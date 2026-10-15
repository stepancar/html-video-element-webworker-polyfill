import { type VideoHost, createVideoHost } from "../src/host/index.ts";
import type { Lib } from "./worker-harness.ts";
import colorsUrl from "./fixtures/colors.webm?url";
import patternUrl from "./fixtures/pattern.webm?url";

export const fixtures = {
  colors: new URL(colorsUrl, location.href).href,
  pattern: new URL(patternUrl, location.href).href,
};

export interface TestWorker {
  worker: Worker;
  host: VideoHost;
  run<T, A = undefined>(fn: (lib: Lib, args: A) => T | Promise<T>, args?: A): Promise<Awaited<T>>;
  dispose(): void;
}

let nextCall = 1;

export function startWorker(): TestWorker {
  const worker = new Worker(new URL("./worker-harness.ts", import.meta.url), { type: "module" });
  const host = createVideoHost(worker);
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  worker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      __test?: number;
      value?: never;
      error?: { name: string; message: string; stack?: string };
    };
    if (data?.__test === undefined) return;
    const call = pending.get(data.__test);
    if (!call) return;
    pending.delete(data.__test);
    if (data.error) {
      const error = new Error(data.error.message);
      error.name = data.error.name;
      if (data.error.stack) error.stack = data.error.stack;
      call.reject(error);
    } else {
      call.resolve(data.value as never);
    }
  });
  worker.addEventListener("error", (event) => {
    for (const call of pending.values()) call.reject(new Error(`Worker error: ${event.message}`));
    pending.clear();
  });
  return {
    worker,
    host,
    run(fn, args) {
      const id = nextCall++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ __test: id, source: fn.toString(), args });
      });
    },
    dispose() {
      host.dispose();
      worker.terminate();
    },
  };
}

export function showBitmap(bitmap: ImageBitmap, testId: string): HTMLCanvasElement {
  document.querySelector(`[data-testid="${testId}"]`)?.remove();
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.dataset.testid = testId;
  canvas.style.display = "block";
  canvas.getContext("bitmaprenderer")!.transferFromImageBitmap(bitmap);
  document.body.append(canvas);
  return canvas;
}
