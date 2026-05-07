import { mat2d, vec2 } from "gl-matrix";
import { createWebGLProgram, dist, mod } from "./utils";
import type { CompiledTileFeature, Feature, WorkerMessage } from "./types";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

const MAX_ZOOM = 18;
const MIN_ZOOM = 1;
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
  uniform mat3 M;

  void main() {
    vec3 pos = M * vec3(position.xy, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
  }
    `,
  `#version 300 es
  precision mediump float;
  uniform vec3 color;
  out vec4 fragColor;

  void main() {
    fragColor = vec4(color, 1);
  }
    `
);
gl.clearColor(0, 0.2, 0.25, 1);
gl.viewport(0, 0, WIDTH, HEIGHT);
gl.useProgram(program);

const positionLoc = gl.getAttribLocation(program, "position");
const colorLoc = gl.getUniformLocation(program, "color");
gl.enableVertexAttribArray(positionLoc);

// map state

let cameraX = 0.57;
let cameraY = 0.44;
let zoom = 2.22;

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

const tileCache: Record<string, Array<Feature>> = {};

function loadTile(
  x: number,
  y: number,
  z: number,
  waitUntil: Promise<void>
): Array<Feature> {
  const key = `${x}-${y}-${z}`;
  waitUntil.then(() => {
    if (!tileCache[key]) {
      tileCache[key] = [];
      worker.postMessage({ x, y, z });
    }
  });
  return loadTileFallback(x, y, z);
}

function loadTileFallback(x: number, y: number, z: number): Array<Feature> {
  let key = "";
  while (z > 0 && !tileCache[(key = `${x}-${y}-${z}`)]?.length) {
    x >>= 1;
    y >>= 1;
    --z;
  }
  return tileCache[key] ?? [];
}

worker.addEventListener("message", (e: MessageEvent<WorkerMessage>) => {
  const payload = e.data;
  switch (payload.type) {
    case "abort": {
      const { x, y, z } = payload;
      const key = `${x}-${y}-${z}`;
      delete tileCache[key];
      break;
    }
    case "done": {
      requestIdleCallback(() => {
        for (const feature of payload.data) {
          compileDrawCall(feature);
        }
        const tileId = payload.data[0].tileId;
        tileCache[tileId].sort((a, b) => (a.featureId < b.featureId ? -1 : 1));
      });
      break;
    }
  }
});

function compileDrawCall(feature: CompiledTileFeature) {
  const { tileId, featureId, vertices, triangles, color } = feature;
  const verticesBuf = gl.createBuffer();
  const trianglesBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, verticesBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, trianglesBuf);
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint32Array(triangles),
    gl.STATIC_DRAW
  );

  tileCache[tileId].push({
    featureId,
    drawCall(originX: number, originY: number) {
      gl.bindBuffer(gl.ARRAY_BUFFER, verticesBuf);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, trianglesBuf);
      const m = makeMatrix(cameraX - originX, cameraY - originY, zoom);
      // prettier-ignore
      gl.uniformMatrix3fv(gl.getUniformLocation(program, "M"), false, [
        m[0], m[1], 0,
        m[2], m[3], 0,
        m[4], m[5], 1,
      ]);
      gl.uniform3fv(colorLoc, color);
      gl.drawElements(gl.TRIANGLES, triangles.length, gl.UNSIGNED_INT, 0);
    },
  });
}

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

  // optimization: abort tile loading
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
      tile.forEach((f) => f.drawCall(originX, originY));
    }
  }

  requestAnimationFrame(render);
});
