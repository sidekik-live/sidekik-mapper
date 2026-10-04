/** Runs tasks for the same key one at a time, in arrival order; different keys run concurrently. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.tails.set(key, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    return next;
  }
}
