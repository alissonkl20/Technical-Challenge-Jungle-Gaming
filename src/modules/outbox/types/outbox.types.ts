/** An outbox event as handed to the transport, exactly as it was committed. */
export interface OutboxMessage {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly occurredAt?: Date;
}

export interface OutboxEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export interface OutboxDispatchFailure {
  readonly eventId: string;
  readonly error: string;
}

export interface OutboxDispatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failures: readonly OutboxDispatchFailure[];
}
