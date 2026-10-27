import { rectangleDepth, rectangleOffset } from "./rectangleGeometry";

/**
 * IMPLEMENTATION_PLAN section 1. Proposed evaluation targets, not measured
 * capabilities or user-approved product tolerances.
 */
export const PROPOSED_TARGETS = {
  horizontalM: 0.2,
  largeVerticalM: 0.02,
  smallVerticalM: 0.005,
  horizontalRotationShareM: 0.05,
};

/** Farthest vertex of the rendered row from the placement origin. */
export function farthestRadius(width: number, count: number): number {
  const offsets = Array.from({ length: Math.max(1, count) }, (_, i) => rectangleOffset(i, width));
  const xs = [Math.min(...offsets) - width / 2, Math.max(...offsets) + width / 2];
  const ys = [0.001, width * 0.5 + 0.001];
  const zs = [-rectangleDepth(width), 0];
  let radius = 0;
  for (const x of xs) for (const y of ys) for (const z of zs) radius = Math.max(radius, Math.hypot(x, y, z));
  return radius;
}

/** rotationAllowance = 2 * asin(displacement / (2R)), degrees. */
export function rotationAllowanceDeg(displacementM: number, radiusM: number): number {
  if (!(radiusM > 0)) return Infinity;
  return (2 * Math.asin(Math.min(1, displacementM / (2 * radiusM))) * 180) / Math.PI;
}

/** Slope-independent bound on displacement from a rotation error, metres. */
export function rotationDisplacementM(errorDeg: number, radiusM: number): number {
  return 2 * radiusM * Math.sin((errorDeg * Math.PI) / 360);
}

export type AccuracyBudget = {
  width: number;
  rectangleCount: number;
  radiusM: number;
  verticalLimitM: number;
  verticalAngleAllocationM: number;
  verticalAngleAllowanceDeg: number;
  horizontalRotationAllowanceDeg: number;
};

export function accuracyBudget(width: number, rectangleCount: number): AccuracyBudget {
  const radiusM = farthestRadius(width, rectangleCount);
  const verticalLimitM = width >= 1 ? PROPOSED_TARGETS.largeVerticalM : PROPOSED_TARGETS.smallVerticalM;
  const verticalAngleAllocationM = verticalLimitM / 2;
  return {
    width,
    rectangleCount,
    radiusM,
    verticalLimitM,
    verticalAngleAllocationM,
    verticalAngleAllowanceDeg: rotationAllowanceDeg(verticalAngleAllocationM, radiusM),
    horizontalRotationAllowanceDeg: rotationAllowanceDeg(PROPOSED_TARGETS.horizontalRotationShareM, radiusM),
  };
}

/** Short status label; precision is never claimed without independent validation. */
export function budgetSummary(budget: AccuracyBudget, uncertaintyDeg?: number): string {
  const base = `Reach ${budget.radiusM.toFixed(1)} m · height budget ±${budget.verticalAngleAllowanceDeg.toFixed(3)}°`;
  if (uncertaintyDeg === undefined || !Number.isFinite(uncertaintyDeg)) return `${base} · precision unverified`;
  const within = uncertaintyDeg <= budget.verticalAngleAllowanceDeg;
  return `${base} · fit ±${uncertaintyDeg.toFixed(3)}° ${within ? "inside" : "exceeds"} · unverified`;
}
