import type { EncodedPacket } from "mediabunny";

export type QueueItem = { serial: number; packet: EncodedPacket } | { serial: number; packet: null };

export class PacketQueue {
  #items: QueueItem[] = [];

  get length(): number {
    return this.#items.length;
  }

  get duration(): number {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const item of this.#items) {
      if (!item.packet) continue;
      first = Math.min(first, item.packet.timestamp);
      last = Math.max(last, item.packet.timestamp + item.packet.duration);
    }
    return last > first ? last - first : 0;
  }

  push(item: QueueItem): void {
    this.#items.push(item);
  }

  peek(): QueueItem | undefined {
    return this.#items[0];
  }

  shift(): QueueItem | undefined {
    return this.#items.shift();
  }

  clear(): void {
    this.#items = [];
  }
}
