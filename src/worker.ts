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

function getFillColor(layerName: string, props: Record<string, any>): Color | null {
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
      return null;
  }
}

function getLineColor(layerName: string, props: Record<string, any>): Color | null {
  switch (layerName) {
    case "waterway":
      return [0.627, 0.784, 0.941]; // #a0c8f0
    case "boundary":
      return props.admin_level <= 2
        ? [0.409, 0.409, 0.411] // hsl(248,1%,41%) — country borders
        : [0.700, 0.700, 0.700]; // hsl(0,0%,70%)   — region borders
    case "transportation":
      switch (props.class) {
        case "motorway":
        case "motorway_link": return [1.000, 0.800, 0.533]; // #ffcc88
        case "trunk":
        case "trunk_link":
        case "primary":
        case "secondary":
        case "tertiary":
        case "link":          return [1.000, 0.933, 0.667]; // #ffeeaa
        case "rail":
        case "transit_rail":  return [0.733, 0.733, 0.733]; // #bbbbbb
        default:              return [1.000, 1.000, 1.000]; // white
      }
    case "park":    return [0.894, 0.945, 0.843]; // rgba(228,241,215)
    case "aeroway": return [0.941, 0.929, 0.914]; // #f0ede9
    default:
      return null;
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
    const lineData: number[] = [];

    const vectorTile = new VectorTile(new Protobuf(data));
    for (const [layerName, layer] of Object.entries(vectorTile.layers)) {
      for (let i = 0; i < layer.length; ++i) {
        compileFeature(layer.feature(i), layerName, x, y, z, vertexData, indexData, lineData);
      }
    }

    const vertices = new Float32Array(vertexData);
    const indices = new Uint32Array(indexData);
    const lineVertices = new Float32Array(lineData);
    const tileId = `${x}-${y}-${z}`;
    self.postMessage(
      { type: "done", tileId, vertices, indices, lineVertices },
      [vertices.buffer, indices.buffer, lineVertices.buffer]
    );
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
  indexData: number[],
  lineData: number[]
) {
  const geojson = feature.toGeoJSON(x, y, z);
  const props = feature.properties ?? {};

  switch (geojson.geometry.type) {
    case "Polygon": {
      const color = getFillColor(layerName, props);
      if (color) compileRings(geojson.geometry.coordinates, color, vertexData, indexData);
      break;
    }
    case "MultiPolygon": {
      const color = getFillColor(layerName, props);
      if (color) {
        for (const rings of geojson.geometry.coordinates) {
          compileRings(rings, color, vertexData, indexData);
        }
      }
      break;
    }
    case "LineString": {
      const color = getLineColor(layerName, props);
      if (color) compileLineString(geojson.geometry.coordinates, color, lineData);
      break;
    }
    case "MultiLineString": {
      const color = getLineColor(layerName, props);
      if (color) {
        for (const line of geojson.geometry.coordinates) {
          compileLineString(line, color, lineData);
        }
      }
      break;
    }
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

function compileLineString(coords: number[][], color: Color, lineData: number[]) {
  for (let i = 0; i < coords.length - 1; i++) {
    const x0 = mercatorXfromLng(coords[i][0]),     y0 = mercatorYfromLat(coords[i][1]);
    const x1 = mercatorXfromLng(coords[i + 1][0]), y1 = mercatorYfromLat(coords[i + 1][1]);
    lineData.push(x0, y0, color[0], color[1], color[2]);
    lineData.push(x1, y1, color[0], color[1], color[2]);
  }
}