/**
 * Durable per-thread exclusivity. The production implementation is `CheckpointFence` from `@sahaj/atlas/fenced`: a session
 * advisory lock on a dedicated connection that ALSO carries every checkpoint statement for the thread, so a lost connection
 * cannot leave a committed checkpoint behind and an in-flight checkpoint transaction cannot commit after the lock is gone.
 */
export interface ThreadLock {
  readonly held: boolean;
  assertHeld(): void;
  onLost?(listener: () => void): void;
  lose?(): void;
  release(): Promise<void>;
}
