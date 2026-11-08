import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { OnModuleDestroy } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { outboxPublisherSettings } from "../../config/settings.js";
import { createSqsClient, SqsQueueUrls } from "../../shared/aws/sqs-client.js";
import { isRecord } from "../../shared/validation/index.js";
import type { OutboxEventPublisher, OutboxMessage } from "./types/index.js";

export class SqsOutboxPublisher
  implements OutboxEventPublisher, OnModuleDestroy
{
  private readonly client: SQSClient;
  private readonly queueUrls: SqsQueueUrls;
  private readonly queueName: string;
  private readonly publishTimeoutMs: number;

  constructor(configuration: ConfigService) {
    const settings = outboxPublisherSettings(configuration);
    this.queueName = settings.queueName;
    this.publishTimeoutMs = settings.publishTimeoutMs;
    this.client = createSqsClient(configuration);
    this.queueUrls = new SqsQueueUrls(this.client);
  }

  /**
   * Sends the envelope exactly as it was committed to the outbox.
   *
   * Nothing is rebuilt or inferred here. The envelope was built by a typed
   * event factory inside the financial transaction, which is the only place
   * that still has the correlation ID of the originating request and the
   * movement the aggregate applied. Reconstructing either at publish time
   * would invent values.
   */
  async publish(message: OutboxMessage): Promise<void> {
    if (!isRecord(message.payload)) {
      throw new TypeError("Outbox event payload must be a JSON object");
    }
    if (message.payload.eventType !== message.eventType) {
      // The row's type column and its envelope disagree, which means the row
      // was not written through `IntegrationEvent.toOutboxRow`.
      throw new TypeError(
        `Outbox event ${message.eventId} carries an envelope for "${String(
          message.payload.eventType,
        )}"`,
      );
    }

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrls.resolve(this.queueName),
        MessageBody: JSON.stringify(message.payload),
        MessageAttributes: {
          event_id: { DataType: "String", StringValue: message.eventId },
          event_type: { DataType: "String", StringValue: message.eventType },
        },
        ...(this.queueName.endsWith(".fifo")
          ? {
              // Grouping by aggregate keeps one wallet's events in order
              // without serializing unrelated wallets against each other.
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.eventId,
            }
          : {}),
      }),
      { abortSignal: AbortSignal.timeout(this.publishTimeoutMs) },
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
