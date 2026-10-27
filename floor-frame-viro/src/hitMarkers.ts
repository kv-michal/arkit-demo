import type { Vec3 } from "./surfacePose";

/**
 * Purple spheres at hit-test results so the user can see where rays landed:
 * the current preview hit(s), accumulated calibration samples, and the
 * latest locked surface-probe cycle. Display only; never used for placement.
 */
export const HIT_MARKERS = { maxCalibration: 200, maxTotal: 256, color: "#a020f0" };

export function hitMarkerRadius(width: number) {
  return width >= 1 ? 0.03 : 0.012;
}

export class HitMarkerBuffer {
  private preview: Vec3[] = [];
  private calibration: Vec3[] = [];
  private probe: Vec3[] = [];
  version = 0;

  setPreview(points: Vec3[]) {
    this.preview = points.filter((p) => p.every(Number.isFinite));
    this.version++;
  }
  addCalibration(points: Vec3[]) {
    this.calibration = [...this.calibration, ...points.filter((p) => p.every(Number.isFinite))].slice(-HIT_MARKERS.maxCalibration);
    this.version++;
  }
  setProbes(points: Vec3[]) {
    this.probe = points.filter((p) => p.every(Number.isFinite));
    this.version++;
  }
  clear() {
    this.preview = [];
    this.calibration = [];
    this.probe = [];
    this.version++;
  }
  all(): Vec3[] {
    return [...this.calibration, ...this.probe, ...this.preview].slice(-HIT_MARKERS.maxTotal);
  }
}
