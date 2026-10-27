import { dot, GRAVITY_UP, normalize, subtract, type Vec3 } from "./surfacePose";
import { multiply, translation } from "./viroGeometry";

/**
 * IMPLEMENTATION_PLAN section 7: candidate gated rigid height correction.
 * Unadopted experiment. One shared gravity-axis offset for the whole row;
 * never changes yaw, inclination or the local layout. Applied only in the
 * explicitly selected experimental phone-only mode; always zero otherwise.
 * Every constant is an untuned starting proposal.
 */
export const HEIGHT_CORRECTION = {
  windowS: 3,
  minResiduals: 3,
  minCycles: 2,
  minDenominator: 0.5,
  maxNormalAngleDeg: 10,
  maxTargetMissM: 0.5,
  maxResidualM: 0.3,
  deadbandM: 0.005,
  rateMPerS: 0.02,
  capM: 0.25,
};

export type HeightObservation = {
  point: Vec3;
  /** Surface normal when the source reports one. */
  normal?: Vec3;
  source: string;
  targetMissM: number;
  cycle: number;
};

export type HeightUpdate = {
  residuals: { source: string; residualM: number; cycle: number }[];
  rejected: { source: string; reason: string }[];
  proposedDeltaM: number | null;
  appliedDeltaM: number;
  applying: boolean;
  stale: boolean;
  windowCount: number;
};

/** Gravity-axis offset that raises the plane (local y = 0 of base) to p. */
export function gravityResidual(baseWorldFromRow: number[], p: Vec3, gravityUp: Vec3 = GRAVITY_UP): number | null {
  const n = normalize(baseWorldFromRow.slice(4, 7) as Vec3);
  const origin = baseWorldFromRow.slice(12, 15) as Vec3;
  const denominator = dot(n, normalize(gravityUp));
  if (denominator <= HEIGHT_CORRECTION.minDenominator) return null;
  return dot(n, subtract(p, origin)) / denominator;
}

export function correctedWorldFromRow(base: number[], appliedDeltaM: number, gravityUp: Vec3 = GRAVITY_UP): number[] {
  if (appliedDeltaM === 0) return base;
  const g = normalize(gravityUp);
  return multiply(translation([g[0] * appliedDeltaM, g[1] * appliedDeltaM, g[2] * appliedDeltaM]), base);
}

export class HeightCorrector {
  private window: { time: number; residual: number; cycle: number }[] = [];
  appliedDeltaM = 0;
  stale = false;
  private lastTime: number | null = null;

  /** Clears offsets; required on a new commit or placement-mode change. */
  reset() {
    this.window = [];
    this.appliedDeltaM = 0;
    this.stale = false;
    this.lastTime = null;
  }

  /** Tracking/reference loss: stop updating and drop the old coordinate epoch. */
  markStale() {
    this.stale = true;
    this.window = [];
    this.lastTime = null;
  }

  update(
    baseWorldFromRow: number[],
    observations: HeightObservation[],
    now: number,
    apply: boolean,
    gravityUp: Vec3 = GRAVITY_UP,
  ): HeightUpdate {
    const rowNormal = normalize(baseWorldFromRow.slice(4, 7) as Vec3);
    const residuals: HeightUpdate["residuals"] = [];
    const rejected: HeightUpdate["rejected"] = [];
    for (const o of observations) {
      const reject = (reason: string) => rejected.push({ source: o.source, reason });
      if (![...o.point].every(Number.isFinite)) { reject("non-finite"); continue; }
      if (o.source === "FeaturePoint") { reject("feature point has no surface"); continue; }
      if (o.targetMissM > HEIGHT_CORRECTION.maxTargetMissM) { reject("depth discontinuity / target miss"); continue; }
      if (o.normal) {
        const cosine = dot(normalize(o.normal), rowNormal);
        if (Math.abs(cosine) < Math.cos((HEIGHT_CORRECTION.maxNormalAngleDeg * Math.PI) / 180)) {
          reject("normal disagrees with committed floor");
          continue;
        }
      }
      const residual = gravityResidual(baseWorldFromRow, o.point, gravityUp);
      if (residual === null) { reject("insufficient upward denominator"); continue; }
      if (Math.abs(residual) > HEIGHT_CORRECTION.maxResidualM) { reject("residual exceeds gate"); continue; }
      residuals.push({ source: o.source, residualM: residual, cycle: o.cycle });
      this.window.push({ time: now, residual, cycle: o.cycle });
    }
    this.window = this.window.filter((w) => now - w.time <= HEIGHT_CORRECTION.windowS);
    const cycles = new Set(this.window.map((w) => w.cycle)).size;
    let proposed: number | null = null;
    if (this.window.length >= HEIGHT_CORRECTION.minResiduals && cycles >= HEIGHT_CORRECTION.minCycles) {
      const sorted = this.window.map((w) => w.residual).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      proposed = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      // Recovered epoch: enough fresh residuals after a loss.
      this.stale = false;
    }
    const dt = this.lastTime === null ? 0 : Math.min(1, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    if (!apply) {
      this.appliedDeltaM = 0;
    } else if (proposed !== null && !this.stale) {
      const target = Math.max(-HEIGHT_CORRECTION.capM, Math.min(HEIGHT_CORRECTION.capM, proposed));
      const difference = target - this.appliedDeltaM;
      if (Math.abs(difference) >= HEIGHT_CORRECTION.deadbandM) {
        const step = HEIGHT_CORRECTION.rateMPerS * dt;
        this.appliedDeltaM += Math.max(-step, Math.min(step, difference));
      }
    }
    return {
      residuals, rejected, proposedDeltaM: proposed, appliedDeltaM: this.appliedDeltaM,
      applying: apply, stale: this.stale, windowCount: this.window.length,
    };
  }
}
