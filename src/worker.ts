import Protobuf from "pbf";
import earcut from "earcut";
import { VectorTile, VectorTileFeature } from "@mapbox/vector-tile";
import { mercatorXfromLng, mercatorYfromLat } from "./mercator";

const VERTEX_SIZE = 5; // x, y, r, g, b

let lastRequestedZ = -1;

addEventListener("message", async (event) => {
  const { x, y, z } = event.data as { x: number; y: number; z: number };
  compileTile(x, y, z);
});

async function compileTile(x: number, y: number, z: number) {
  lastRequestedZ = z;

  try {
    const data = await (
      await fetch(`https://tiles.openfreemap.org/planet/latest/${z}/${x}/${y}.pbf`)
    ).arrayBuffer();

    if (z != lastRequestedZ || !data) {
      self.postMessage({ type: "abort", x, y, z });
      return;
    }

    const vertexData: number[] = []; // x, y, r, g, b per vertex
    const indexData: number[] = [];

    const vectorTile = new VectorTile(new Protobuf(data));
    for (const layer of Object.values(vectorTile.layers)) {
      for (let i = 0; i < layer.length; ++i) {
        compileFeature(layer.feature(i), x, y, z, vertexData, indexData);
      }
    }

    const vertices = new Float32Array(vertexData);
    const indices = new Uint32Array(indexData);
    const tileId = `${x}-${y}-${z}`;
    self.postMessage({ type: "done", tileId, vertices, indices }, [vertices.buffer, indices.buffer]);
  } catch (e) {
    console.warn(e);
  }
}

function compileFeature(
  feature: VectorTileFeature,
  x: number,
  y: number,
  z: number,
  vertexData: number[],
  indexData: number[]
) {
  const geojson = feature.toGeoJSON(x, y, z);
  const color = [50, 100, 100].map((m) => 0.2 + (0.8 * (feature.id % m)) / m);

  switch (geojson.geometry.type) {
    case "Polygon":
      compileRings(geojson.geometry.coordinates, color, vertexData, indexData);
      break;
    case "MultiPolygon":
      for (const rings of geojson.geometry.coordinates) {
        compileRings(rings, color, vertexData, indexData);
      }
      break;
  }
}

function compileRings(
  rings: number[][][],
  color: number[],
  vertexData: number[],
  indexData: number[]
) {
  const data = earcut.flatten(
    rings.map((ring) =>
      ring.map((v) => [mercatorXfromLng(v[0]), mercatorYfromLat(v[1])])
    )
  );

  const base = vertexData.length / VERTEX_SIZE;
  for (let i = 0; i < data.vertices.length; i += 2) {
    vertexData.push(data.vertices[i], data.vertices[i + 1], color[0], color[1], color[2]);
  }
  for (const i of earcut(data.vertices, data.holes, data.dimensions)) {
    indexData.push(i + base);
  }
}
