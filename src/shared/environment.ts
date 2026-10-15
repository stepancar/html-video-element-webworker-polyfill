const PACKAGE = "html-video-element-webworker-polyfill";

export class InvalidEnvironmentError extends Error {
  override name: string = "InvalidEnvironmentError";
}

export function isMainThread(): boolean {
  const scope = globalThis as { Window?: abstract new () => unknown };
  return typeof scope.Window === "function" && globalThis instanceof scope.Window;
}

export function isWorker(): boolean {
  const scope = globalThis as { WorkerGlobalScope?: abstract new () => unknown };
  return typeof scope.WorkerGlobalScope === "function" && globalThis instanceof scope.WorkerGlobalScope;
}

export function assertMainThread(api: string): void {
  if (isMainThread()) return;
  throw new InvalidEnvironmentError(
    `${PACKAGE}: ${api} must be called on the main thread, where real <video> elements exist. ` +
      `Inside a worker use createVideoElement() or polyfillDocument() and attach the worker on the main thread with createVideoHost(worker).`,
  );
}

export function assertWorker(api: string): void {
  if (isWorker()) return;
  throw new InvalidEnvironmentError(
    `${PACKAGE}: ${api} must be called inside a Web Worker. ` +
      `On the main thread use a real <video> element, and serve workers with createVideoHost(worker).`,
  );
}

export function isMessageEndpoint(value: unknown): boolean {
  const endpoint = value as { postMessage?: unknown; addEventListener?: unknown; removeEventListener?: unknown } | null;
  return (
    typeof endpoint === "object" &&
    endpoint !== null &&
    typeof endpoint.postMessage === "function" &&
    typeof endpoint.addEventListener === "function" &&
    typeof endpoint.removeEventListener === "function"
  );
}
