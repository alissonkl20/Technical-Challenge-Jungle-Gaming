/**
 * Bounds a graceful stop. Workers finish the unit of work they hold, and this
 * timer forces the exit if that work is stuck, for example on a blocked lock.
 * Nothing is lost by the forced exit: uncommitted transactions roll back, and
 * claimed outbox leases or unacknowledged SQS messages expire and are retried.
 * The timer is unref'd, so it never keeps a finished process alive.
 */
export function armShutdownDeadline(
  deadlineMs: number,
  onExpired: () => void,
): void {
  const timer = setTimeout(onExpired, deadlineMs);
  timer.unref();
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
