import type { Effect } from "../effects.ts";

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform vec2 texel;
uniform int effect;
in vec2 uv;
out vec4 color;

float luma(vec2 offset) {
  return dot(texture(frame, uv + offset * texel).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec3 rgb = texture(frame, uv).rgb;
  if (effect == 1) {
    float gx = -luma(vec2(-1, -1)) - 2.0 * luma(vec2(-1, 0)) - luma(vec2(-1, 1))
             + luma(vec2(1, -1)) + 2.0 * luma(vec2(1, 0)) + luma(vec2(1, 1));
    float gy = -luma(vec2(-1, -1)) - 2.0 * luma(vec2(0, -1)) - luma(vec2(1, -1))
             + luma(vec2(-1, 1)) + 2.0 * luma(vec2(0, 1)) + luma(vec2(1, 1));
    rgb = min(1.0, length(vec2(gx, gy))) * vec3(0.45, 0.95, 1.0);
  } else if (effect == 2) {
    rgb = vec3(dot(rgb, vec3(0.299, 0.587, 0.114)));
  } else if (effect == 3) {
    rgb = floor(rgb * 4.0 + 0.5) / 4.0;
  } else if (effect == 4) {
    rgb = 1.0 - rgb;
  }
  color = vec4(rgb, 1.0);
}`;

const EFFECT_IDS: Record<Effect, number> = { none: 0, edges: 1, grayscale: 2, posterize: 3, invert: 4 };

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
  return shader;
}

export class GpuFilter {
  readonly #canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly #gl: WebGL2RenderingContext;
  readonly #texel: WebGLUniformLocation | null;
  readonly #effect: WebGLUniformLocation | null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.#canvas = canvas;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available.");
    this.#gl = gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#texel = gl.getUniformLocation(program, "texel");
    this.#effect = gl.getUniformLocation(program, "effect");
  }

  render(source: TexImageSource, width: number, height: number, effect: Effect): void {
    const gl = this.#gl;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform2f(this.#texel, 1 / width, 1 / height);
    gl.uniform1i(this.#effect, EFFECT_IDS[effect]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
