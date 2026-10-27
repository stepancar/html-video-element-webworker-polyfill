export class Signal {
  #waiters: (() => void)[] = [];

  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  notify(): void {
    const waiters = this.#waiters;
    if (waiters.length === 0) return;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}

let channel: MessageChannel | null = null;
const tasks: (() => void)[] = [];

export function queueTask(task: () => void): void {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      tasks.shift()?.();
    };
  }
  tasks.push(task);
  channel.port2.postMessage(null);
}
