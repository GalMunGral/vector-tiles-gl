import { mat2d, vec2 } from "gl-matrix";
import { createWebGLProgram, dist, mod } from "./utils";
import type { DrawableTile, WorkerMessage } from "./types";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

const MAX_ZOOM = 14;
const MIN_ZOOM = 0;
const WIDTH = window.innerWidth;
const HEIGHT = window.innerHeight;

const canvas = document.createElement("canvas");
document.body.append(canvas);
canvas.width = WIDTH;
canvas.height = HEIGHT;
canvas.style.width = canvas.width + "px";
canvas.style.height = canvas.height + "px";

const gl = canvas.getContext("webgl2")!;
const program = createWebGLProgram(
  gl,
  `#version 300 es
  in vec2 position;
  in vec3 color;
  out vec3 vColor;
  uniform mat3 M;

  void main() {
    vColor = color;
    vec3 pos = M * vec3(position.xy, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
  }
  `,
  `#version 300 es
  precision mediump float;
  in vec3 vColor;
  out vec4 fragColor;

  void main() {
    fragColor = vec4(vColor, 1);
  }
  `
);
gl.clearColor(0.973, 0.957, 0.941, 1); // #f8f4f0 liberty background
gl.viewport(0, 0, WIDTH, HEIGHT);
gl.useProgram(program);

const VERTEX_SIZE = 5; // x, y, r, g, b
const STRIDE = VERTEX_SIZE * 4; // bytes

const positionLoc = gl.getAttribLocation(program, "position");
const colorLoc = gl.getAttribLocation(program, "color");
const matrixLoc = gl.getUniformLocation(program, "M");
gl.enableVertexAttribArray(positionLoc);
gl.enableVertexAttribArray(colorLoc);

// map state

let cameraX = 0.2565; // Chicago (~87.65°W)
let cameraY = 0.3720; // Chicago (~41.85°N)
let zoom = 10;

const N = 10;
const M = Array(N)
  .fill(0)
  .map(() => mat2d.create());
const V = Array(N)
  .fill(0)
  .map(() => vec2.create());

function makeMatrix(cameraX: number, cameraY: number, zoom: number): mat2d {
  const m1 = mat2d.fromTranslation(M[0], vec2.fromValues(-cameraX, -cameraY));
  const m2 = mat2d.fromScaling(
    M[1],
    vec2.fromValues(
      2 ** zoom / (WIDTH / 2 / 256),
      2 ** zoom / -(HEIGHT / 2 / 256)
    )
  );
  return mat2d.mul(M[2], m2, m1);
}

const tileCache: Record<string, DrawableTile | null> = {};

function loadTile(
  x: number,
  y: number,
  z: number,
  waitUntil: Promise<void>
): DrawableTile | null {
  const key = `${x}-${y}-${z}`;
  waitUntil.then(() => {
    if (!(key in tileCache)) {
      tileCache[key] = null;
      worker.postMessage({ x, y, z });
    }
  });
  return loadTileFallback(x, y, z);
}

function loadTileFallback(x: number, y: number, z: number): DrawableTile | null {
  let key = "";
  while (z > 0) {
    key = `${x}-${y}-${z}`;
    if (tileCache[key]) return tileCache[key];
    x >>= 1;
    y >>= 1;
    --z;
  }
  return tileCache[`${x}-${y}-${z}`] ?? null;
}

worker.addEventListener("message", (e: MessageEvent<WorkerMessage>) => {
  const payload = e.data;
  switch (payload.type) {
    case "abort": {
      const { x, y, z } = payload;
      delete tileCache[`${x}-${y}-${z}`];
      break;
    }
    case "done": {
      const { tileId, vertices, indices, lineVertices } = payload;
      requestIdleCallback(() => {
        const vbo = gl.createBuffer()!;
        const ibo = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        const triCount = indices.length;

        const lineVbo = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
        gl.bufferData(gl.ARRAY_BUFFER, lineVertices, gl.STATIC_DRAW);
        const lineCount = lineVertices.length / VERTEX_SIZE;

        tileCache[tileId] = {
          draw(originX: number, originY: number) {
            const m = makeMatrix(cameraX - originX, cameraY - originY, zoom);
            gl.uniformMatrix3fv(matrixLoc, false, [
              m[0], m[1], 0,
              m[2], m[3], 0,
              m[4], m[5], 1,
            ]);
            if (triCount > 0) {
              gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
              gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, STRIDE, 0);
              gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, STRIDE, 2 * 4);
              gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
              gl.drawElements(gl.TRIANGLES, triCount, gl.UNSIGNED_INT, 0);
            }
            if (lineCount > 0) {
              gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
              gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, STRIDE, 0);
              gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, STRIDE, 2 * 4);
              gl.drawArrays(gl.LINES, 0, lineCount);
            }
          },
        };
      });
      break;
    }
  }
});

let isMoving = false;
let prevX = -1;
let prevY = -1;

canvas.addEventListener("mousedown", (e) => {
  isMoving = true;
  prevX = e.clientX;
  prevY = e.clientY;
});

canvas.addEventListener("mouseup", () => {
  isMoving = false;
});

canvas.addEventListener("mouseleave", () => {
  isMoving = false;
});

canvas.addEventListener("mousemove", (e) => {
  if (isMoving) {
    cameraX += (prevX - e.clientX) / 256 / 2 ** zoom;
    cameraY += (prevY - e.clientY) / 256 / 2 ** zoom;
    prevX = e.clientX;
    prevY = e.clientY;
  }
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const zoomDelta = -0.005 * e.deltaY;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + zoomDelta));
    const x = (e.clientX - WIDTH / 2) / 256;
    const y = (e.clientY - HEIGHT / 2) / 256;
    const scale = 2 ** (newZoom - zoom);
    cameraX += (x * (scale - 1)) / 2 ** newZoom;
    cameraY += (y * (scale - 1)) / 2 ** newZoom;
    zoom = newZoom;
  },
  { passive: false }
);

const touchCache: Record<number, Touch> = {};

canvas.addEventListener("touchstart", (e) => {
  for (let touch of e.touches) {
    touchCache[touch.identifier] = touch;
  }
});

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  switch (e.targetTouches.length) {
    case 1:
      if (e.changedTouches.length) {
        const touch = e.changedTouches[0];
        const prevTouch = touchCache[e.changedTouches[0].identifier];
        cameraX += (prevTouch.clientX - touch.clientX) / 256 / 2 ** zoom;
        cameraY += (prevTouch.clientY - touch.clientY) / 256 / 2 ** zoom;
      }
      break;
    case 2:
      const touch1 = e.targetTouches[0];
      const touch2 = e.targetTouches[1];
      const curDist = dist(e.targetTouches[0], e.targetTouches[1]);
      const prevDist = dist(
        touchCache[touch1.identifier],
        touchCache[touch2.identifier]
      );
      const zoomDelta = 0.01 * (curDist - prevDist);
      const newZoom = Math.max(0, Math.min(MAX_ZOOM, zoom + zoomDelta));
      const x = ((touch1.clientX + touch2.clientX) / 2 - WIDTH / 2) / 256;
      const y = ((touch1.clientY + touch2.clientY) / 2 - HEIGHT / 2) / 256;
      const scale = 2 ** (newZoom - zoom);
      cameraX += (x * (scale - 1)) / 2 ** newZoom;
      cameraY += (y * (scale - 1)) / 2 ** newZoom;
      zoom = newZoom;
  }
  for (const touch of e.touches) {
    touchCache[touch.identifier] = touch;
  }
});

let timer = -1;
let prevCameraX = -1;
let prevCameraY = -1;
let prevZoom = -1;

requestAnimationFrame(function render() {
  gl.useProgram(program);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const minX = -(WIDTH / 2) / 256 / 2 ** zoom + cameraX;
  const maxX = WIDTH / 2 / 256 / 2 ** zoom + cameraX;
  const minY = -(HEIGHT / 2) / 256 / 2 ** zoom + cameraY;
  const maxY = HEIGHT / 2 / 256 / 2 ** zoom + cameraY;

  const Z = Math.ceil(zoom);
  const minTileX = Math.floor(minX * 2 ** Z);
  const maxTileX = Math.floor(maxX * 2 ** Z);
  const minTileY = Math.floor(minY * 2 ** Z);
  const maxTileY = Math.floor(maxY * 2 ** Z);

  if (zoom !== prevZoom || cameraX !== prevCameraX || cameraY !== prevCameraY) {
    prevZoom = zoom;
    prevCameraX = cameraX;
    prevCameraY = cameraY;
    clearTimeout(timer);
  }

  const waitUtil = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 200);
  });

  for (let x = minTileX - 1; x <= maxTileX + 1; x++) {
    for (let y = minTileY - 1; y <= maxTileY + 1; y++) {
      const X = mod(x, 2 ** Z);
      const Y = mod(y, 2 ** Z);
      const tile = loadTile(X, Y, Z, waitUtil);
      const originX = Math.floor(x / 2 ** Z);
      const originY = Math.floor(y / 2 ** Z);
      tile?.draw(originX, originY);
    }
  }

  requestAnimationFrame(render);
});
