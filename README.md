# WebGL Vector Tile Renderer

**Live demo:** https://galmungral.github.io/vector-tiles-gl/

## Rhetorical Design

### Purpose

Web maps like Google Maps or Mapbox look like a seamless, continuous surface, but under the hood the map is divided into a grid of square tiles that are fetched and rendered independently. This project demystifies that mechanism — how tiles are requested, decoded, triangulated, and drawn — without getting sidetracked by the geometry algorithms underneath. Triangulating a polygon is a computational geometry problem solved by [Earcut](https://github.com/mapbox/earcut); that is taken as given here.

### Strategy

Vector tiles are protobuf-encoded binary files served by the Mapbox API. Each tile covers a fixed geographic bounding box at a given zoom level and contains polygon and line geometries for the features (country boundaries, roads, etc.) within that region. This project fetches tiles as the user pans and zooms, decodes the protobuf with `@mapbox/vector-tile`, projects the coordinates from longitude/latitude into Mercator space, triangulates the polygons with Earcut, and uploads the resulting vertex and index buffers to the GPU for rendering with WebGL.

## Technical Challenges

### Coordinate systems

Vector tile geometries are delivered as GeoJSON in longitude/latitude, but the GPU shader works in a flat 2D coordinate space. The Mercator projection maps longitude linearly to [0, 1] but latitude non-linearly — the Y axis is compressed near the poles to preserve local angles. Each tile is decoded into this normalized Mercator space so that all tiles share the same coordinate system and can be rendered with a single affine transform per tile.

### Tile cache and zoom fallback

Fetching a tile is asynchronous, so the viewport can be partially blank during loading. Rather than showing empty space, the renderer walks up the tile quadtree to find the nearest cached ancestor and renders that coarser tile in its place. This gives the effect of a blurry-then-sharp progressive load with no blank regions.

### Worker thread

Tile compilation — fetch, protobuf decode, coordinate projection, triangulation — is CPU-intensive and would block the main thread if run synchronously, causing dropped frames during user interaction. The work runs in a Web Worker and posts the compiled vertex and index arrays back to the main thread, which uploads them to the GPU. Tile responses for zoom levels that are no longer current are discarded on arrival.
