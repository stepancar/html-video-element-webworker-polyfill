import { Lab } from "./lab.ts";
import type { LabCommand, LabEvent } from "./protocol.ts";

let lab: Lab | null = null;

type Init = { type: "init"; source: OffscreenCanvas; output: OffscreenCanvas; audio: MessagePort };

self.onmessage = (event: MessageEvent<LabCommand | Init>) => {
  const message = event.data;
  if (message.type === "init") {
    lab = new Lab(message.source, message.output, (labEvent: LabEvent) => self.postMessage(labEvent), message.audio);
    return;
  }
  void lab?.handle(message);
};
