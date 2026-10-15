import type { Ranges, SerializedMediaError } from "../shared/protocol.ts";

export class WorkerTimeRanges implements TimeRanges {
  readonly #ranges: Ranges;

  constructor(ranges: Ranges = []) {
    this.#ranges = ranges;
  }

  get length(): number {
    return this.#ranges.length;
  }

  start(index: number): number {
    return this.#at(index)[0];
  }

  end(index: number): number {
    return this.#at(index)[1];
  }

  #at(index: number): [number, number] {
    const range = this.#ranges[index];
    if (!range) {
      throw new DOMException(
        `The index provided (${index}) is greater than or equal to the maximum bound (${this.#ranges.length}).`,
        "IndexSizeError",
      );
    }
    return range;
  }
}

export class WorkerMediaError implements MediaError {
  static readonly MEDIA_ERR_ABORTED = 1 as const;
  static readonly MEDIA_ERR_NETWORK = 2 as const;
  static readonly MEDIA_ERR_DECODE = 3 as const;
  static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4 as const;
  readonly MEDIA_ERR_ABORTED = 1 as const;
  readonly MEDIA_ERR_NETWORK = 2 as const;
  readonly MEDIA_ERR_DECODE = 3 as const;
  readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4 as const;

  readonly code: number;
  readonly message: string;

  constructor({ code, message }: SerializedMediaError) {
    this.code = code;
    this.message = message;
  }
}
