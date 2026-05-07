import Protobuf from "pbf";
import earcut from "earcut";
import { VectorTile, VectorTileFeature } from "@mapbox/vector-tile";
import { mercatorXfromLng, mercatorYfromLat } from "./mercator";
import type { CompiledTileFeature } from "./types";
const TOKEN = import.meta.env.TOKEN;

const sourceId = "mapbox.country-boundaries-v1";

let lastRequestedZ = -1;

addEventListener("message", async (event) => {
  const { x, y, z } = event.data as { x: number; y: number; z: number };
  compileTile(x, y, z);
});

async function compileTile(x: number, y: number, z: number) {
  lastRequestedZ = z;

  try {
    const data = await (
      await fetch(
        `https://api.mapbox.com/v4/${sourceId}/${z}/${x}/${y}.vector.pbf?access_token=${TOKEN}`
      )
    ).arrayBuffer();

    // bail out if the zoom level changed after the tile was requested
    if (z != lastRequestedZ || !data) {
      self.postMessage({ type: "abort", x, y, z });
      // console.debug("abort", x, y, z);
      return;
    }

    const compiled: Array<CompiledTileFeature> = [];
    const vectorTile = new VectorTile(new Protobuf(data));
    for (const [key, layer] of Object.entries(vectorTile.layers)) {
      for (let i = 0; i < layer.length; ++i) {
        compiled.push(compileFeature(layer.feature(i), x, y, z));
      }
    }
    self.postMessage({ type: "done", data: compiled });
  } catch (e) {
    console.warn(e);
  }

  function compileFeature(
    feature: VectorTileFeature,
    x: number,
    y: number,
    z: number
  ) {
    const tileId = `${x}-${y}-${z}`;
    const featureId = feature.id;
    const geojson = feature.toGeoJSON(x, y, z);

    const color = [50, 100, 100].map((m) => 0.2 + (0.8 * (feature.id % m)) / m);
    const triangles: Array<number> = [];
    const vertices: Array<number> = [];

    switch (geojson.geometry.type) {
      case "Polygon":
        compile(geojson.geometry.coordinates);
        break;
      case "MultiPolygon":
        geojson.geometry.coordinates.forEach((c) => compile(c));
        break;
      case "LineString":
      case "MultiLineString":
      default:
        console.info("not implemented");
    }

    return { tileId, featureId, color, vertices, triangles };

    function compile(rings: Array<Array<Array<number>>>) {
      const data = earcut.flatten(
        rings.map((ring) =>
          ring.map((v) => [mercatorXfromLng(v[0]), mercatorYfromLat(v[1])])
        )
      );
      const base = vertices.length / 2;
      vertices.push(...data.vertices);
      const tri = earcut(data.vertices, data.holes, data.dimensions);
      triangles.push(...tri.map((i) => i + base));
    }
  }
}
