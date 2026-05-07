# WebGL Vector Tile Renderer

**Live demo:** https://galmungral.github.io/vector-tiles-gl/

## Rhetorical Design

### Purpose

This project addresses practitioners who work with vector tiles regularly but have not had occasion to implement a renderer. It makes the rendering pipeline explicit — from tile fetch to GPU draw call — for an audience already familiar with the format and its applications.

### Strategy

Restricting scope to polygons and lines, the two principal geometry types on a basemap, is sufficient to produce recognizable geography while keeping the emphasis on the rendering mechanism. Polygon triangulation is delegated to [Earcut](https://github.com/mapbox/earcut); the project is not concerned with computational geometry.

## Technical Challenges

### Worker Thread

Tile compilation — fetching the protobuf, decoding the geometry, projecting coordinates, and triangulating polygons — is CPU-intensive enough to block the main thread and drop frames. Compilation is delegated to a Web Worker, which returns the finished vertex and index buffers as transferable `Float32Array`s. The main thread is responsible solely for uploading geometry to the GPU and issuing draw calls.