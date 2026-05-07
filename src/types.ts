export type DrawableTile = {
  draw(originX: number, originY: number): void;
};

export type WorkerMessage =
  | {
      type: "done";
      tileId: string;
      vertices: Float32Array;
      indices: Uint32Array;
    }
  | {
      type: "abort";
      x: number;
      y: number;
      z: number;
    };