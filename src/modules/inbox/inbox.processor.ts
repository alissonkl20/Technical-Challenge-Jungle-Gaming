import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { InboxMessage, PayloadFingerprint } from "../finance/domain/index.js";
import type {
  PersistenceSession,
  TransactionManager,
} from "../finance/persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../finance/persistence/tokens.js";
import { InboxPayloadConflictError } from "./errors/index.js";
import type { InboxProcessingResult } from "./types/index.js";

@Injectable()
export class InboxProcessor {
  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
  ) {}

  /**
   * Runs `handler` at most once per `(consumerName, messageId)`.
   *
   * The insert happens inside the same transaction as the handler, so a
   * handler that throws rolls back its own deduplication record and the
   * message is retried. PostgreSQL arbitrates the race between instances; no
   * in-memory cache is consulted.
   */
  process<Result, Payload>(
    consumerName: string,
    messageId: string,
    payload: Payload,
    handler: (session: PersistenceSession, payload: Payload) => Promise<Result>,
  ): Promise<InboxProcessingResult<Result>> {
    const fingerprint = PayloadFingerprint.of(payload);

    return this.transactions.transaction(async (session) => {
      const now = new Date();
      const message = InboxMessage.receive({
        id: randomUUID(),
        consumerName,
        messageId,
        fingerprint,
        receivedAt: now,
      });
      // Marked before the handler runs because the row is the lock that
      // arbitrates concurrent consumers and must be written first. It is
      // safe: the record commits only together with the handler's effects,
      // so a failed handler rolls "processed" back with everything else.
      message.markProcessed(now);

      const inserted = await session.inbox.createIfAbsent({
        id: message.id,
        consumer_name: message.consumerName,
        message_id: message.messageId,
        payload_hash: message.fingerprint.toString(),
        received_at: message.receivedAt,
        processed_at: now,
      });
      if (inserted === null) {
        const existing = await session.inbox.findByConsumerAndMessage(
          message.consumerName,
          message.messageId,
        );
        if (existing === null) {
          throw new Error(
            "Inbox identity conflicted but its record was not found",
          );
        }

        const handled = InboxMessage.rehydrate({
          id: existing.id,
          consumerName: existing.consumer_name,
          messageId: existing.message_id,
          payloadHash: existing.payload_hash,
          receivedAt: existing.received_at,
          processedAt: existing.processed_at,
        });
        if (!handled.isRedeliveryOf(fingerprint)) {
          // Same message ID, different payload: the producer reused an ID.
          // Skipping it would drop a distinct financial command.
          throw new InboxPayloadConflictError(
            handled.consumerName,
            handled.messageId,
            handled.fingerprint.toString(),
            fingerprint.toString(),
          );
        }
        return { processed: false };
      }

      const result = await handler(session, payload);
      return { processed: true, result };
    });
  }
}
