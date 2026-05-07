import Protobuf from "pbf";
import earcut from "earcut";
import { VectorTile, VectorTileFeature } from "@mapbox/vector-tile";
import { mercatorXfromLng, mercatorYfromLat } from "./mercator";

const VERTEX_SIZE = 5; // x, y, r, g, b

let lastRequestedZ = -1;

type Color = [number, number, number];

// Compiled from https://tiles.openfreemap.org/styles/liberty at author time.
// Colors are pre-converted to linear [r,g,b] floats.
// Zoom-interpolated colors use their zoom-12 value.
function getColor(layerName: string, props: Record<string, any>): Color {
  switch (layerName) {
    case "water":     return [0.620, 0.741, 1.000]; // rgb(158,189,255)
    case "park":      return [0.847, 0.910, 0.784]; // #d8e8c8
    case "building":  return [0.862, 0.852, 0.838]; // hsl(35,8%,85%)
    case "aeroway":   return [0.898, 0.894, 0.878]; // rgba(229,228,224)
    case "landuse":
      switch (props.class) {
        case "residential": return [0.949, 0.891, 0.812]; // hsla(35,57%,88%)
        case "cemetery":    return [0.845, 0.880, 0.740]; // hsl(75,37%,81%)
        case "hospital":    return [1.000, 0.867, 0.933]; // #ffddee
        case "school":      return [0.925, 0.933, 0.800]; // rgb(236,238,204)
        case "pitch":
        case "track":       return [0.871, 0.890, 0.804]; // #DEE3CD
        default:            return [0.949, 0.891, 0.812];
      }
    case "landcover":
      switch (props.class) {
        case "wood":  return [0.675, 0.891, 0.549]; // hsla(98,61%,72%)
        case "grass": return [0.690, 0.835, 0.604]; // rgba(176,213,154)
        case "ice":   return [0.878, 0.925, 0.925]; // rgba(224,236,236)
        case "sand":  return [0.969, 0.937, 0.765]; // rgba(247,239,195)
        default:      return [0.690, 0.835, 0.604];
      }
    default:
      return [0.820, 0.820, 0.820];
  }
}

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

    const vertexData: number[] = [];
    const indexData: number[] = [];

    const vectorTile = new VectorTile(new Protobuf(data));
    for (const [layerName, layer] of Object.entries(vectorTile.layers)) {
      for (let i = 0; i < layer.length; ++i) {
        compileFeature(layer.feature(i), layerName, x, y, z, vertexData, indexData);
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
  layerName: string,
  x: number,
  y: number,
  z: number,
  vertexData: number[],
  indexData: number[]
) {
  const geojson = feature.toGeoJSON(x, y, z);
  const props = feature.properties ?? {};
  const color = getColor(layerName, props);

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
  color: Color,
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