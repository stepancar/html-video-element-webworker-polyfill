export {
  type CanvasVideoElementOptions,
  type CanvasVideoFrameCallback,
  type CanvasVideoFrameMetadata,
  CanvasVideoElement,
  createCanvasVideoElement,
} from "./element.ts";
export {
  type AudioChunk,
  type AudioOutput,
  type AudioSink,
  type WebAudioSinkOptions,
  PortAudioSink,
  WebAudioSink,
  createAudioOutput,
} from "./audio/sink.ts";
