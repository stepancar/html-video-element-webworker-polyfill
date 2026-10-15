import { rolldown } from "rolldown";

const pkg = "html-video-element-webworker-polyfill";

const MARKERS = {
  element: "Illegal invocation",
  host: "failed to set",
  document: "is not supported in a worker",
  webgl: "texSubImage3D",
  webgpu: "copyExternalImageToTexture",
};

const cases = [
  { code: `import { polyfillWebglAPI } from "${pkg}/webgl"; polyfillWebglAPI();`, has: ["webgl"] },
  { code: `import { polyfill2dCanvasApi } from "${pkg}/canvas2d"; polyfill2dCanvasApi();`, has: [] },
  { code: `import { polyfillWebgpu } from "${pkg}/webgpu"; polyfillWebgpu();`, has: ["webgpu"] },
  { code: `import { createVideoHost } from "${pkg}/host"; createVideoHost(self);`, has: ["host"] },
  { code: `import { createVideoElement } from "${pkg}/worker"; createVideoElement();`, has: ["element"] },
  { code: `import { polyfillWebglAPI } from "${pkg}"; polyfillWebglAPI();`, has: ["webgl"] },
  { code: `import { createVideoHost } from "${pkg}"; createVideoHost(self);`, has: ["host"] },
  {
    code: `import "${pkg}/auto";`,
    has: ["element", "document", "webgl", "webgpu"],
  },
];

let failed = false;
for (const { code, has } of cases) {
  const bundle = await rolldown({
    input: "entry",
    cwd: process.cwd(),
    plugins: [
      {
        name: "virtual-entry",
        resolveId: (id) => (id === "entry" ? id : null),
        load: (id) => (id === "entry" ? code : null),
      },
    ],
  });
  const { output } = await bundle.generate({ format: "esm" });
  const text = output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
  const found = Object.entries(MARKERS)
    .filter(([, marker]) => text.includes(marker))
    .map(([name]) => name);
  const ok = found.length === has.length && has.every((name) => found.includes(name));
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${(text.length / 1024).toFixed(1).padStart(5)} kB  ${code}`);
  if (!ok) console.log(`       expected [${has}] got [${found}]`);
}
process.exit(failed ? 1 : 0);
