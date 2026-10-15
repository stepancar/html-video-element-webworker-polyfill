import { afterEach, describe, expect, test } from "vitest";
import * as lib from "../src/index.ts";
import { InvalidEnvironmentError } from "../src/index.ts";
import { startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker | undefined;
afterEach(() => {
  w?.dispose();
  w = undefined;
});

describe("worker-only APIs refuse to run on the main thread", () => {
  const calls: Array<[string, () => unknown]> = [
    ["createVideoElement()", () => lib.createVideoElement()],
    ["createVideoElement()", () => new lib.WorkerVideoElement()],
    ["polyfillDocument()", () => lib.polyfillDocument()],
    ["configureVideoTransport()", () => lib.configureVideoTransport(new MessageChannel().port1)],
    ["polyfill2dCanvasApi()", () => lib.polyfill2dCanvasApi()],
    ["polyfillWebglAPI()", () => lib.polyfillWebglAPI()],
    ["polyfillWebgpu()", () => lib.polyfillWebgpu()],
    ["polyfillCreateImageBitmap()", () => lib.polyfillCreateImageBitmap()],
    ["polyfillVideoFrame()", () => lib.polyfillVideoFrame()],
    ["installWorkerPolyfills()", () => lib.installWorkerPolyfills()],
  ];

  test.each(calls)("%s", (name, call) => {
    let error: unknown;
    try {
      call();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    expect((error as Error).name).toBe("InvalidEnvironmentError");
    expect((error as Error).message).toContain(`${name} must be called inside a Web Worker`);
  });

  test("nothing on the main thread was patched", () => {
    const patched = Symbol.for("html-video-element-webworker-polyfill.patched");
    const isPatched = (value: unknown) => Boolean((value as Record<symbol, unknown>)[patched]);
    expect(document.createElement("video")).toBeInstanceOf(HTMLVideoElement);
    expect(isPatched(document)).toBe(false);
    expect(isPatched(CanvasRenderingContext2D.prototype.drawImage)).toBe(false);
    expect(isPatched(OffscreenCanvasRenderingContext2D.prototype.drawImage)).toBe(false);
    expect(isPatched(WebGL2RenderingContext.prototype.texImage2D)).toBe(false);
    expect(isPatched(createImageBitmap)).toBe(false);
    expect(isPatched(VideoFrame)).toBe(false);
  });

  test("importing the auto entry on the main thread throws", async () => {
    await expect(import("../src/auto.ts")).rejects.toBeInstanceOf(InvalidEnvironmentError);
  });

  test("environment helpers", () => {
    expect(lib.isMainThread()).toBe(true);
    expect(lib.isWorker()).toBe(false);
  });
});

describe("main-thread-only APIs refuse to run in a worker", () => {
  test("createVideoHost() throws inside a worker", async () => {
    w = startWorker();
    const result = await w.run(({ createVideoHost, isMainThread, isWorker }) => {
      try {
        createVideoHost(new MessageChannel().port1);
        return null;
      } catch (error) {
        return {
          name: (error as Error).name,
          message: (error as Error).message,
          isMainThread: isMainThread(),
          isWorker: isWorker(),
        };
      }
    });
    expect(result).toMatchObject({ name: "InvalidEnvironmentError", isMainThread: false, isWorker: true });
    expect(result!.message).toContain("createVideoHost() must be called on the main thread");
  });

  test("polyfillDocument() in a worker keeps working", async () => {
    w = startWorker();
    const result = await w.run(({ polyfillDocument }) => {
      polyfillDocument();
      return document.createElement("video").tagName;
    });
    expect(result).toBe("VIDEO");
  });
});

describe("misuse is reported clearly", () => {
  test("createVideoHost() validates its endpoint", () => {
    for (const endpoint of [undefined, null, {}, "worker", window]) {
      expect(() => lib.createVideoHost(endpoint as never)).toThrow(TypeError);
    }
  });

  test("createVideoHost() cannot be attached twice to the same worker", () => {
    const worker = new Worker(new URL("./worker-harness.ts", import.meta.url), { type: "module" });
    try {
      const host = lib.createVideoHost(worker);
      let error: DOMException | undefined;
      try {
        lib.createVideoHost(worker);
      } catch (caught) {
        error = caught as DOMException;
      }
      expect(error?.name).toBe("InvalidStateError");
      host.dispose();
      expect(() => lib.createVideoHost(worker).dispose()).not.toThrow();
    } finally {
      worker.terminate();
    }
  });

  test("createVideoElement() validates its transport", async () => {
    w = startWorker();
    const result = await w.run(({ createVideoElement, configureVideoTransport }) => {
      const errors: string[] = [];
      for (const call of [
        () => createVideoElement({ transport: {} as never }),
        () => configureVideoTransport({ postMessage() {} } as never),
      ]) {
        try {
          call();
        } catch (error) {
          errors.push((error as Error).name);
        }
      }
      return errors;
    });
    expect(result).toEqual(["TypeError", "TypeError"]);
  });

  test("warns when no host is attached to the worker", async () => {
    w = startWorker({ host: false });
    const warnings = await w.run(async ({ createVideoElement, helpers }) => {
      const messages: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => messages.push(args.map(String).join(" "));
      try {
        createVideoElement();
        await helpers.sleep(3300);
      } finally {
        console.warn = original;
      }
      return messages;
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Call createVideoHost(worker) on the main thread");
  });

  test("does not warn when the host is attached", async () => {
    w = startWorker();
    const warnings = await w.run(async ({ createVideoElement, helpers }) => {
      const messages: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => messages.push(args.map(String).join(" "));
      try {
        createVideoElement();
        await helpers.sleep(3300);
      } finally {
        console.warn = original;
      }
      return messages;
    });
    expect(warnings).toEqual([]);
  });
});
