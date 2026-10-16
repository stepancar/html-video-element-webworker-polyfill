import * as lib from "html-video-element-webworker-polyfill";
import { InvalidEnvironmentError } from "html-video-element-webworker-polyfill";
import { afterEach, describe, expect, test } from "vitest";
import { startWorker, type TestWorker } from "./harness.ts";

let w: TestWorker | undefined;
afterEach(() => {
  w?.dispose();
  w = undefined;
});

const WORKER_ONLY_CALLS: Array<[string, () => unknown]> = [
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

function errorOf(call: () => unknown): unknown {
  try {
    call();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("worker-only APIs refuse to run on the main thread", () => {
  test.each(WORKER_ONLY_CALLS)("%s", (name, call) => {
    // Arrange
    const expectedMessage = `${name} must be called inside a Web Worker`;

    // Act
    const error = errorOf(call);

    // Assert
    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    expect((error as Error).name).toBe("InvalidEnvironmentError");
    expect((error as Error).message).toContain(expectedMessage);
  });

  test("the page's DOM and rendering APIs stay untouched", () => {
    // Arrange
    const before = {
      createElement: document.createElement,
      drawImage: CanvasRenderingContext2D.prototype.drawImage,
      offscreenDrawImage: OffscreenCanvasRenderingContext2D.prototype.drawImage,
      texImage2D: WebGL2RenderingContext.prototype.texImage2D,
      createImageBitmap: globalThis.createImageBitmap,
      VideoFrame: globalThis.VideoFrame,
    };

    // Act
    for (const [, call] of WORKER_ONLY_CALLS) errorOf(call);

    // Assert
    expect(document.createElement).toBe(before.createElement);
    expect(CanvasRenderingContext2D.prototype.drawImage).toBe(before.drawImage);
    expect(OffscreenCanvasRenderingContext2D.prototype.drawImage).toBe(before.offscreenDrawImage);
    expect(WebGL2RenderingContext.prototype.texImage2D).toBe(before.texImage2D);
    expect(globalThis.createImageBitmap).toBe(before.createImageBitmap);
    expect(globalThis.VideoFrame).toBe(before.VideoFrame);
    expect(document.createElement("video")).toBeInstanceOf(HTMLVideoElement);
  });

  test("importing the auto entry on the main thread throws", async () => {
    // Arrange
    const load = () => import("html-video-element-webworker-polyfill/auto");

    // Act
    const result = load();

    // Assert
    await expect(result).rejects.toBeInstanceOf(InvalidEnvironmentError);
  });

  test("environment helpers report the main thread", () => {
    // Arrange
    const { isMainThread, isWorker } = lib;

    // Act
    const environment = { isMainThread: isMainThread(), isWorker: isWorker() };

    // Assert
    expect(environment).toEqual({ isMainThread: true, isWorker: false });
  });
});

describe("main-thread-only APIs refuse to run in a worker", () => {
  test("createVideoHost() throws inside a worker", async () => {
    // Arrange
    w = startWorker();

    // Act
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

    // Assert
    expect(result).toMatchObject({ name: "InvalidEnvironmentError", isMainThread: false, isWorker: true });
    expect(result!.message).toContain("createVideoHost() must be called on the main thread");
  });

  test("polyfillDocument() works inside a worker", async () => {
    // Arrange
    w = startWorker();

    // Act
    const tagName = await w.run(({ polyfillDocument }) => {
      polyfillDocument();
      return document.createElement("video").tagName;
    });

    // Assert
    expect(tagName).toBe("VIDEO");
  });
});

describe("misuse is reported clearly", () => {
  test("createVideoHost() validates its endpoint", () => {
    // Arrange
    const invalidEndpoints = [undefined, null, {}, "worker", window];

    // Act
    const errors = invalidEndpoints.map((endpoint) => errorOf(() => lib.createVideoHost(endpoint as never)));

    // Assert
    for (const error of errors) expect(error).toBeInstanceOf(TypeError);
  });

  test("createVideoHost() cannot be attached twice to the same worker", () => {
    // Arrange
    const worker = new Worker(new URL("./worker-harness.ts", import.meta.url), { type: "module" });
    const host = lib.createVideoHost(worker);

    // Act
    const secondAttach = errorOf(() => lib.createVideoHost(worker)) as DOMException;
    host.dispose();
    const attachAfterDispose = errorOf(() => lib.createVideoHost(worker).dispose());
    worker.terminate();

    // Assert
    expect(secondAttach.name).toBe("InvalidStateError");
    expect(attachAfterDispose).toBeUndefined();
  });

  test("createVideoElement() and configureVideoTransport() validate the transport", async () => {
    // Arrange
    w = startWorker();

    // Act
    const errors = await w.run(({ createVideoElement, configureVideoTransport }) =>
      [
        () => createVideoElement({ transport: {} as never }),
        () => configureVideoTransport({ postMessage() {} } as never),
      ].map((call) => {
        try {
          call();
          return "no error";
        } catch (error) {
          return (error as Error).name;
        }
      }),
    );

    // Assert
    expect(errors).toEqual(["TypeError", "TypeError"]);
  });

  test("warns when no host is attached to the worker", async () => {
    // Arrange
    w = startWorker({ host: false });
    await w.run(({ state }) => {
      const warnings: string[] = [];
      state.warnings = warnings;
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    });

    // Act
    const warnings = await w.run(async ({ createVideoElement, helpers, state }) => {
      createVideoElement();
      await helpers.sleep(3300);
      return state.warnings as string[];
    });

    // Assert
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Call createVideoHost(worker) on the main thread");
  });

  test("does not warn when the host is attached", async () => {
    // Arrange
    w = startWorker();
    await w.run(({ state }) => {
      const warnings: string[] = [];
      state.warnings = warnings;
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    });

    // Act
    const warnings = await w.run(async ({ createVideoElement, helpers, state }) => {
      createVideoElement();
      await helpers.sleep(3300);
      return state.warnings as string[];
    });

    // Assert
    expect(warnings).toEqual([]);
  });
});
