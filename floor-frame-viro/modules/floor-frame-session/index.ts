import { requireNativeModule } from "expo";
export type SessionSample = {
  status:
    | "starting"
    | "tracking"
    | "noSurface"
    | "hit"
    | "anchored"
    | "anchorPending";
  matrix?: number[];
  camera?: [number, number, number];
};
export default requireNativeModule<{
  readonly supportsLiDAR: boolean;
  configure(lidar: boolean, reset: boolean): Promise<void>;
  sample(): Promise<SessionSample>;
  anchor(matrix: number[]): Promise<boolean>;
  unanchor(): Promise<void>;
}>("FloorFrameSession");
