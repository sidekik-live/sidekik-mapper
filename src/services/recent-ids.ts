/** A set that remembers only the most recent `max` ids (insertion order), so it never grows unbounded. */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly max = 10_000) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
  }
}
