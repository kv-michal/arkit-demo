import type { Vec3 } from "./surfacePose";
import type { SurveyManifest } from "./surveyManifest";
import {
  inverseRigid,
  isRigid,
  matrixFromQuaternion,
  multiply,
  poseDifference,
  quaternionFromMatrix,
} from "./viroGeometry";

/**
 * IMPLEMENTATION_PLAN section 8: fuse accepted marker observations into one
 * rigid world-from-survey transform. Quaternion averaging, never Euler.
 */
export const FUSION = {
  maxAgeS: 0.5,
  outlierPositionM: 0.1,
  outlierRotationDeg: 2,
};

export type MarkerObservation = {
  id: string;
  worldFromMarker: number[];
  /** Receipt time in seconds; capture time is not exposed by every backend. */
  timestamp: number;
  epoch: number;
  tracking: boolean;
};

export type FusionResult = {
  worldFromSurvey: number[] | null;
  used: string[];
  rejected: { id: string; reason: string }[];
  residuals: { id: string; positionM: number; rotationDeg: number }[];
  validation: { id: string; positionM: number; rotationDeg: number }[];
  observability: "none" | "single-board" | "multi-board";
  weights: Record<string, number>;
};

export function fuseReferences(
  manifest: SurveyManifest,
  observations: MarkerObservation[],
  now: number,
  epoch: number,
): FusionResult {
  const result: FusionResult = {
    worldFromSurvey: null, used: [], rejected: [], residuals: [], validation: [],
    observability: "none", weights: {},
  };
  // One observation per board: repeated correlated callbacks must not add confidence.
  const latest = new Map<string, MarkerObservation>();
  for (const o of observations) {
    const previous = latest.get(o.id);
    if (!previous || o.timestamp >= previous.timestamp) latest.set(o.id, o);
  }
  const candidates: { id: string; matrix: number[]; weightP: number; weightR: number }[] = [];
  for (const id of [...latest.keys()].sort()) {
    const o = latest.get(id)!;
    const reference = manifest.references.find((r) => r.id === id);
    const reject = (reason: string) => result.rejected.push({ id, reason });
    if (!reference) { reject("unknown id"); continue; }
    if (reference.role !== "correction") continue;
    if (o.epoch !== epoch) { reject("stale epoch"); continue; }
    if (!o.tracking) { reject("not tracking"); continue; }
    if (now - o.timestamp > FUSION.maxAgeS) { reject("stale observation"); continue; }
    if (!isRigid(o.worldFromMarker, 1e-3)) { reject("non-rigid pose"); continue; }
    candidates.push({
      id,
      matrix: multiply(o.worldFromMarker, inverseRigid(reference.surveyFromMarker)),
      weightP: 1 / reference.uncertainty.positionM ** 2,
      weightR: 1 / reference.uncertainty.rotationDeg ** 2,
    });
  }
  let accepted = candidates;
  if (candidates.length >= 2) {
    // Most central candidate as robust reference; reject boards that disagree with it.
    const cost = (c: (typeof candidates)[number]) => candidates.reduce((sum, other) => {
      const d = poseDifference(c.matrix, other.matrix);
      return sum + d.positionM / FUSION.outlierPositionM + d.rotationDeg / FUSION.outlierRotationDeg;
    }, 0);
    const center = [...candidates].sort((a, b) => cost(a) - cost(b) || (a.id < b.id ? -1 : 1))[0];
    accepted = candidates.filter((c) => {
      const d = poseDifference(center.matrix, c.matrix);
      const ok = d.positionM <= FUSION.outlierPositionM && d.rotationDeg <= FUSION.outlierRotationDeg;
      if (!ok) result.rejected.push({ id: c.id, reason: "inconsistent with other boards" });
      return ok;
    });
    if (candidates.length === 2 && accepted.length < 2) {
      result.rejected.push(...accepted.map((c) => ({ id: c.id, reason: "two boards disagree" })));
      accepted = [];
    }
  }
  if (!accepted.length) return result;
  const totalP = accepted.reduce((s, c) => s + c.weightP, 0);
  const totalR = accepted.reduce((s, c) => s + c.weightR, 0);
  const position: Vec3 = [0, 1, 2].map((k) =>
    accepted.reduce((s, c) => s + c.matrix[12 + k] * c.weightP, 0) / totalP) as Vec3;
  const reference = quaternionFromMatrix(accepted[0].matrix);
  const q = [0, 0, 0, 0];
  for (const c of accepted) {
    const qi = quaternionFromMatrix(c.matrix);
    const sign = qi.reduce((s, v, i) => s + v * reference[i], 0) < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) q[k] += sign * qi[k] * (c.weightR / totalR);
  }
  const fused = matrixFromQuaternion(position, q);
  if (!fused) return result;
  result.worldFromSurvey = fused;
  result.used = accepted.map((c) => c.id);
  result.weights = Object.fromEntries(accepted.map((c) => [c.id, c.weightP / totalP]));
  result.observability = accepted.length >= 2 ? "multi-board" : "single-board";
  result.residuals = accepted.map((c) => ({ id: c.id, ...poseDifference(fused, c.matrix) }));
  // Held-out boards never drive the pose; they only report validation residuals.
  for (const [id, o] of latest) {
    const reference = manifest.references.find((r) => r.id === id);
    if (reference?.role !== "heldOutValidation" || o.epoch !== epoch) continue;
    result.validation.push({ id, ...poseDifference(multiply(fused, reference.surveyFromMarker), o.worldFromMarker) });
  }
  return result;
}
