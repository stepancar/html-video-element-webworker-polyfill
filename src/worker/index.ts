export { configureVideoTransport } from "./bridge.ts";
export { polyfillDocument } from "./document.ts";
export { WorkerMediaError, WorkerTimeRanges } from "./media-types.ts";
export {
  type CreateVideoElementOptions,
  type VideoFrameRequestCallback,
  WorkerVideoElement,
  createVideoElement,
} from "./video-element.ts";
export type { FrameMetadata, MessageEndpoint } from "../shared/protocol.ts";
