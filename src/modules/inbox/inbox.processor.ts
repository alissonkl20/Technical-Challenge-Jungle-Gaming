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
      const identity = InboxMessage.rehydrate({
        id: randomUUID(),
        consumerName,
        messageId,
        payloadHash: fingerprint.toString(),
      });

      const inserted = await session.inbox.createIfAbsent({
        id: identity.id,
        consumer_name: identity.consumerName,
        message_id: identity.messageId,
        payload_hash: identity.fingerprint.toString(),
      });
      if (inserted === null) {
        const existing = await session.inbox.findByConsumerAndMessage(
          identity.consumerName,
          identity.messageId,
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
