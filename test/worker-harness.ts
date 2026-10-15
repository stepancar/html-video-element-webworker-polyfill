import * as polyfill from "../src/index.ts";

function once(target: EventTarget, type: string, timeout = 10_000): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${type}"`)), timeout);
    target.addEventListener(
      type,
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

function pixelOf(source: CanvasImageSource, x = 1, y = 1): number[] {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, x, y, 1, 1, 0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

function colorName([r = 0, g = 0, b = 0]: number[]): string {
  const on = (v: number) => v > 128;
  const key = `${+on(r)}${+on(g)}${+on(b)}`;
  return { "000": "black", "100": "red", "010": "lime", "001": "blue", "110": "yellow", "111": "white" }[key] ?? key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(check: () => T, timeout = 10_000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

const helpers = { once, pixelOf, colorName, sleep, waitFor };
export type Helpers = typeof helpers;
export type Lib = typeof polyfill & { helpers: Helpers };

const lib: Lib = { ...polyfill, helpers };

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => unknown;

self.addEventListener("message", async (event: MessageEvent) => {
  const data = event.data as { __test?: number; source?: string; args?: unknown };
  if (data?.__test === undefined) return;
  try {
    const fn = new AsyncFunction("lib", "args", `return (${data.source})(lib, args);`);
    const value = await fn(lib, data.args);
    const transfer = collectTransferables(value);
    self.postMessage({ __test: data.__test, value }, { transfer });
  } catch (error) {
    const e = error as Error;
    self.postMessage({
      __test: data.__test,
      error: { name: e?.name, message: e?.message ?? String(error), stack: e?.stack },
    });
  }
});

function collectTransferables(value: unknown, out: Transferable[] = []): Transferable[] {
  if (value instanceof ImageBitmap || value instanceof VideoFrame) out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectTransferables(item, out);
  else if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) collectTransferables(item, out);
  }
  return out;
}
