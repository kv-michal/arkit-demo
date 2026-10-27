import { CALIBRATION, fitFloor, type CalibrationResult, type SurfaceObservation } from "./floorCalibration";
import type { Vec3 } from "./surfacePose";

/**
 * IMPLEMENTATION_PLAN section 5 sampling adapter: bounded batches stored in
 * the calibration reference (anchor) frame, tagged with batch and coordinate
 * epoch so stale batches are rejected by the fit. Swift port:
 * FloorFrame/CalibrationSampler.swift.
 */
/** Screen-fraction sample grid within the aim area (0..1). */
export function calibrationGrid(size: number): [number, number][] {
  const points: [number, number][] = [];
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      points.push([0.1 + (0.8 * col) / (size - 1), 0.1 + (0.8 * row) / (size - 1)]);
  return points;
}

export type ReferenceSample = { point: Vec3; camera: Vec3; source: string; captureTimestamp?: number; confidence?: number };

/** Accumulates samples in the reference frame and keeps the fit history. */
export class CalibrationSession {
  observations: SurfaceObservation[] = [];
  batch = 0;
  history: { time: number; inclination: number }[] = [];
  last: CalibrationResult | null = null;
  gridSize = 5;
  constructor(
    readonly origin: Vec3,
    readonly heading: Vec3,
    readonly gravityUp: Vec3,
    readonly epoch: number,
  ) {}

  addBatch(samples: ReferenceSample[], now: number, durationS: number) {
    this.batch++;
    for (const s of samples)
      this.observations.push({ ...s, batch: this.batch, epoch: this.epoch, receivedTimestamp: now });
    if (this.observations.length > CALIBRATION.maxObservations)
      this.observations = this.observations.slice(-CALIBRATION.maxObservations);
    // Adaptive reduction on slow devices; recover once batches are fast again.
    this.gridSize = durationS > 0.3 ? 3 : durationS < 0.15 ? 5 : this.gridSize;
    return this.batch;
  }

  fit(now: number): CalibrationResult {
    this.history = this.history.filter((h) => now - h.time <= CALIBRATION.stabilityWindowS);
    const result = fitFloor({
      observations: this.observations, origin: this.origin, heading: this.heading,
      gravityUp: this.gravityUp, epoch: this.epoch,
      recentInclinations: this.history.map((h) => h.inclination),
    });
    if (result.alongRowInclination !== null && result.status !== "insufficient")
      this.history.push({ time: now, inclination: result.alongRowInclination });
    this.last = result;
    return result;
  }
}
