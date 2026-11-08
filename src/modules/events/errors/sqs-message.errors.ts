/** A message that can never succeed: it goes to the DLQ instead of retrying. */
export class PermanentSqsMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
