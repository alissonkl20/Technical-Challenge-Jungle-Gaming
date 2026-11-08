import { randomUUID } from "node:crypto";
import {
  currentCausationId,
  currentCorrelationId,
} from "../../shared/observability/request-context.js";
import {
  type LedgerDirection,
  type MoneyProps,
  OutboxMessage,
} from "../finance/domain/index.js";

/**
 * Every event type this system publishes, declared once.
 *
 * The classes below take their `eventType` from here and the consumer
 * validates incoming messages against `KNOWN_EVENT_TYPES`, so the published
 * set and the accepted set cannot drift. A new event type that was added to
 * only one of two lists would be published and then rejected to the dead
 * letter queue.
 */
export const EventType = {
  WagerTransactionProcessed: "WagerTransactionProcessed",
  WagerTransactionRejected: "WagerTransactionRejected",
  WalletBalanceChanged: "WalletBalanceChanged",
  WagerTransactionPendingReference: "WagerTransactionPendingReference",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(EventType),
);

export interface IntegrationEventProps<T extends object> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: T;
}

/**
 * The serialized form written to the outbox payload and sent to SQS. The
 * envelope carries identity, tracing and version; `data` carries only business
 * fields.
 */
export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: EventType;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze(structuredClone(props.data));
  }

  /** The serialized envelope written to the outbox payload. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined
        ? {}
        : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data) as T,
    };
  }

  /**
   * The outbox row for this event. Going through here is what keeps
   * `event_type` and the payload from disagreeing: both come from the same
   * typed instance, so a row cannot claim one type and carry another's data.
   */
  toOutboxRow(): {
    readonly id: string;
    readonly aggregate_id: string;
    readonly event_type: string;
    readonly payload: IntegrationEventEnvelope<T>;
  } {
    const message = OutboxMessage.enqueue(this);
    return {
      id: message.id,
      aggregate_id: message.aggregateId,
      event_type: message.eventType,
      payload: message.payload as IntegrationEventEnvelope<T>,
    };
  }
}

/**
 * Re-exported from the domain so event payloads and `Money.toJSON()` cannot
 * drift apart. There is one money shape in the system, not one per layer.
 */
export type { MoneyProps };

/**
 * Where a fact comes from: tracing and the instant it happened. It carries no
 * event ID on purpose, because one committed fact publishes several events and
 * each needs its own identity — the outbox row ID is the event ID. Sharing one
 * ID across two events collides on the primary key.
 *
 * The correlation ID is captured from the active request or consumer scope
 * **at the moment the fact happens**, inside the transaction. The publisher
 * runs later, in another process, and cannot recover it.
 */
export interface EventContext {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

/**
 * The context of an event produced by the work running now. Correlation and
 * causation come from the flow that is executing; an explicit override wins.
 * A random correlation is only a last resort for work that has no flow.
 */
export function eventContext(overrides?: Partial<EventContext>): EventContext {
  const causationId = overrides?.causationId ?? currentCausationId();
  return {
    correlationId:
      overrides?.correlationId ?? currentCorrelationId() ?? randomUUID(),
    ...(causationId === null || causationId === undefined
      ? {}
      : { causationId }),
    occurredAt: overrides?.occurredAt ?? new Date(),
  };
}

function propsFrom<T extends object>(
  aggregateId: string,
  data: T,
  context: EventContext,
): IntegrationEventProps<T> {
  return {
    eventId: randomUUID(),
    aggregateId,
    correlationId: context.correlationId,
    ...(context.causationId === undefined
      ? {}
      : { causationId: context.causationId }),
    occurredAt: context.occurredAt,
    data,
  };
}

export interface WagerTransactionProcessedData {
  readonly wagerTransactionId: string;
  readonly providerId: string;
  readonly kind: string;
  readonly money: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = EventType.WagerTransactionProcessed;
  readonly version = 1;

  static from(
    data: WagerTransactionProcessedData,
    context: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      propsFrom(data.wagerTransactionId, data, context),
    );
  }
}

export interface WagerTransactionRejectedData {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly failureCode: string;
  readonly wagerTransactionId?: string;
  readonly financialOperationId?: string;
  readonly kind?: string;
  readonly money?: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = EventType.WagerTransactionRejected;
  readonly version = 1;

  /**
   * A rejection may have no transaction: a request refused before any
   * financial record exists is still auditable, and then the operation is the
   * aggregate it belongs to.
   */
  static from(
    aggregateId: string,
    data: WagerTransactionRejectedData,
    context: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(propsFrom(aggregateId, data, context));
  }
}

export interface WagerTransactionPendingReferenceData {
  readonly wagerTransactionId: string;
  readonly providerId: string;
  readonly externalReferenceTransactionId: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = EventType.WagerTransactionPendingReference;
  readonly version = 1;

  static from(
    data: WagerTransactionPendingReferenceData,
    context: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      propsFrom(data.wagerTransactionId, data, context),
    );
  }
}

/** Exactly the fields the contract declares: no duplicates, no aliases. */
export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = EventType.WalletBalanceChanged;
  readonly version = 1;

  /**
   * Built from the movement the aggregate returned, so direction, amount and
   * both balances are the ones actually applied. Nothing here is inferred by
   * comparing balances after the fact.
   */
  static from(
    data: WalletBalanceChangedData,
    context: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(propsFrom(data.walletId, data, context));
  }
}
