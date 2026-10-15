export type Effect = "none" | "edges" | "grayscale" | "posterize" | "invert";

export const EFFECTS: Array<{ value: Effect; label: string }> = [
  { value: "edges", label: "Edge detection" },
  { value: "grayscale", label: "Grayscale" },
  { value: "posterize", label: "Posterize" },
  { value: "invert", label: "Invert" },
  { value: "none", label: "None" },
];

let scratch = new Uint8ClampedArray(0);

export function applyEffect(image: ImageData, effect: Effect): void {
  const { data, width, height } = image;
  switch (effect) {
    case "grayscale":
      for (let i = 0; i < data.length; i += 4) {
        const y = data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114;
        data[i] = data[i + 1] = data[i + 2] = y;
      }
      return;
    case "invert":
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i]!;
        data[i + 1] = 255 - data[i + 1]!;
        data[i + 2] = 255 - data[i + 2]!;
      }
      return;
    case "posterize":
      for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.round(data[i]! / 64) * 64;
        data[i + 1] = Math.round(data[i + 1]! / 64) * 64;
        data[i + 2] = Math.round(data[i + 2]! / 64) * 64;
      }
      return;
    case "edges": {
      if (scratch.length < width * height) scratch = new Uint8ClampedArray(width * height);
      const luma = scratch;
      for (let p = 0, i = 0; p < width * height; p++, i += 4) {
        luma[p] = (data[i]! * 77 + data[i + 1]! * 150 + data[i + 2]! * 29) >> 8;
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
            data[i] = data[i + 1] = data[i + 2] = 0;
            continue;
          }
          const p = y * width + x;
          const gx =
            -luma[p - width - 1]! -
            2 * luma[p - 1]! -
            luma[p + width - 1]! +
            luma[p - width + 1]! +
            2 * luma[p + 1]! +
            luma[p + width + 1]!;
          const gy =
            -luma[p - width - 1]! -
            2 * luma[p - width]! -
            luma[p - width + 1]! +
            luma[p + width - 1]! +
            2 * luma[p + width]! +
            luma[p + width + 1]!;
          const edge = Math.min(255, Math.hypot(gx, gy));
          data[i] = edge * 0.45;
          data[i + 1] = edge * 0.95;
          data[i + 2] = edge;
        }
      }
      return;
    }
    case "none":
      return;
  }
}

export function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    Math.sqrt(Math.random());
  }
}
