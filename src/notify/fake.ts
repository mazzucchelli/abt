import type { Notifier, Push } from "./contract.ts";

/** Records pushes for tests. */
export class FakeNotifier implements Notifier {
  readonly pushes: Push[] = [];

  async push(p: Push): Promise<void> {
    this.pushes.push({ ...p });
  }
}
