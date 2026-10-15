import type { CreateVideoElementOptions } from "./video-element.ts";
import { WorkerVideoElement } from "./video-element.ts";
import { WorkerMediaError, WorkerTimeRanges } from "./media-types.ts";

const PATCHED: unique symbol = Symbol.for("html-video-element-webworker-polyfill.patched") as never;

interface DocumentLike {
  createElement(tagName: string, options?: unknown): unknown;
  [PATCHED]?: true;
}

export function polyfillDocument(options?: CreateVideoElementOptions): void {
  const scope = globalThis as Record<string, unknown>;
  scope.HTMLVideoElement ??= WorkerVideoElement;
  scope.HTMLMediaElement ??= WorkerVideoElement;
  scope.MediaError ??= WorkerMediaError;
  scope.TimeRanges ??= WorkerTimeRanges;

  const existing = scope.document as DocumentLike | undefined;
  if (existing && typeof existing.createElement === "function") {
    if (existing[PATCHED]) return;
    const original = existing.createElement.bind(existing);
    existing.createElement = (tagName: string, elementOptions?: unknown) =>
      isVideo(tagName) ? new WorkerVideoElement(options) : original(tagName, elementOptions);
    existing[PATCHED] = true;
    return;
  }

  const document: DocumentLike = {
    createElement(tagName: string): unknown {
      if (isVideo(tagName)) return new WorkerVideoElement(options);
      throw new DOMException(
        `document.createElement("${tagName}") is not supported in a worker; only "video" is polyfilled.`,
        "NotSupportedError",
      );
    },
    [PATCHED]: true,
  };
  scope.document = document;
}

function isVideo(tagName: string): boolean {
  return String(tagName).toLowerCase() === "video";
}
