export class InboxPayloadConflictError extends Error {
  constructor(
    readonly consumerName: string,
    readonly messageId: string,
    readonly existingHash: string,
    readonly incomingHash: string,
  ) {
    super(
      `Inbox message "${messageId}" for consumer "${consumerName}" was received with a different payload`,
    );
    this.name = new.target.name;
  }
}
