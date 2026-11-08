/**
 * Observes how long locking reads take. A `SELECT ... FOR UPDATE` or
 * `FOR SHARE` returns only after the lock is granted, so its duration is the
 * time spent waiting for the lock plus the read itself. The repository layer
 * reports here; the metrics layer decides how to expose it.
 */
type LockWaitObserver = (milliseconds: number) => void;

let observer: LockWaitObserver | null = null;

export function setLockWaitObserver(next: LockWaitObserver | null): void {
  observer = next;
}

export function observeLockWait(milliseconds: number): void {
  observer?.(milliseconds);
}

export const LOCKING_READ_PATTERN = /\bFOR\s+(UPDATE|SHARE)\b/i;
