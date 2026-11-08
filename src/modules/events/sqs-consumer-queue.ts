import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { SqsEventSettings } from "../../config/settings.js";
import type { SqsQueueUrls } from "../../shared/aws/sqs-client.js";
import { exponentialBackoff } from "../../shared/retry/exponential-backoff.js";

/** SQS caps a message's visibility timeout at 12 hours; 15 minutes is enough. */
const MAX_RETRY_VISIBILITY_SECONDS = 900;
const MAX_DEAD_LETTER_REASON_LENGTH = 900;

/**
 * Exponential backoff for a transient failure, derived from SQS's own receive
 * count so it survives worker restarts: base, 2x base, 4x base... capped. The
 * attempt limit itself stays `SQS_EVENT_MAX_RECEIVE_COUNT`, after which the
 * message goes to the DLQ.
 */
export function retryVisibilityTimeout(
  baseSeconds: number,
  receiveCount: number,
): number {
  return exponentialBackoff(baseSeconds, receiveCount - 1, {
    maxExponent: 20,
    maxDelay: MAX_RETRY_VISIBILITY_SECONDS,
  });
}

export function receiveCountOf(message: Message): number {
  return Number(message.Attributes?.ApproximateReceiveCount ?? "1");
}

/** One source queue and its DLQ, as a consumer sees them. */
export class SqsConsumerQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrls: SqsQueueUrls,
    private readonly queueName: string,
    private readonly deadLetterQueueName: string,
  ) {}

  async receive(
    settings: SqsEventSettings,
    abortSignal?: AbortSignal,
  ): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrls.resolve(this.queueName),
        MaxNumberOfMessages: settings.batchSize,
        WaitTimeSeconds: settings.waitTimeSeconds,
        VisibilityTimeout: settings.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
      { abortSignal },
    );
    return response.Messages ?? [];
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrls.resolve(this.queueName),
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async retryLater(
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrls.resolve(this.queueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  /**
   * Copies the message to the DLQ with its reason. Callers acknowledge the
   * original only after this send succeeds, so a crash in between redelivers
   * instead of losing the message.
   */
  async sendToDeadLetter(
    body: string,
    attributes: Record<string, MessageAttributeValue> | undefined,
    reason: string,
    fifoDeduplicationId?: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrls.resolve(this.deadLetterQueueName),
        MessageBody: body,
        MessageAttributes: {
          ...(attributes ?? {}),
          dead_letter_reason: {
            DataType: "String",
            StringValue: reason.slice(0, MAX_DEAD_LETTER_REASON_LENGTH),
          },
        },
        ...(fifoDeduplicationId !== undefined &&
        this.deadLetterQueueName.endsWith(".fifo")
          ? {
              MessageGroupId: fifoDeduplicationId,
              MessageDeduplicationId: fifoDeduplicationId,
            }
          : {}),
      }),
    );
  }
}
