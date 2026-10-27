import {
  dot,
  GRAVITY_UP,
  horizontalHeading,
  length,
  rowFrame,
  scale,
  subtract,
  add,
  type Vec3,
} from "./surfacePose";
import type { SurveyManifest } from "./surveyManifest";
import { fuseReferences, type FusionResult, type MarkerObservation } from "./referenceFusion";
import { inverseRigid, multiply, rotateVector, transformPoint } from "./viroGeometry";

export type ReferenceState = "unavailable" | "searching" | "tracking" | "stale" | "inconsistent";

/**
 * IMPLEMENTATION_PLAN section 8: preserves the committed survey-relative row
 * and drives one root. Surveyed floor control defines floor tilt and origin
 * height; the user supplies yaw only. Phone floor observations never feed
 * this controller's pose (the phone height correction is forced to zero).
 */
export class ReferenceFrameController {
  readonly observations = new Map<string, MarkerObservation>();
  state: ReferenceState;
  worldFromSurvey: number[] | null = null;
  surveyFromRow: number[] | null = null;
  anchorFromSurvey: number[] | null = null;
  lastFusion: FusionResult | null = null;

  constructor(readonly manifest: SurveyManifest | null) {
    this.state = manifest ? "searching" : "unavailable";
  }

  observe(observation: MarkerObservation) {
    this.observations.set(observation.id, observation);
  }

  /** Viro's removal callback has no payload; callers bind the id in a closure. */
  remove(id: string) {
    const o = this.observations.get(id);
    if (o) this.observations.set(id, { ...o, tracking: false });
  }

  reset() {
    this.observations.clear();
    this.worldFromSurvey = null;
    this.surveyFromRow = null;
    this.anchorFromSurvey = null;
    this.lastFusion = null;
    this.state = this.manifest ? "searching" : "unavailable";
  }

  /** New commit or reposition: drop the row relation, keep board observations. */
  clearPlacement() {
    this.surveyFromRow = null;
    this.anchorFromSurvey = null;
  }

  update(now: number, epoch: number, worldFromAnchorNow: number[] | null): ReferenceState {
    if (!this.manifest) return (this.state = "unavailable");
    const fusion = fuseReferences(this.manifest, [...this.observations.values()], now, epoch);
    this.lastFusion = fusion;
    if (fusion.worldFromSurvey) {
      this.worldFromSurvey = fusion.worldFromSurvey;
      if (worldFromAnchorNow) this.anchorFromSurvey = multiply(inverseRigid(worldFromAnchorNow), fusion.worldFromSurvey);
      return (this.state = "tracking");
    }
    const disagreement = fusion.rejected.some((r) => r.reason.includes("disagree") || r.reason.includes("inconsistent"));
    // Transport through the ordinary anchor only while its survey relation is known.
    if (this.anchorFromSurvey && worldFromAnchorNow)
      this.worldFromSurvey = multiply(worldFromAnchorNow, this.anchorFromSurvey);
    if (disagreement) return (this.state = "inconsistent");
    return (this.state = this.worldFromSurvey ? "stale" : "searching");
  }

  /** Row placement in the survey frame from an aimed world point and camera. */
  placeRow(hitWorld: Vec3, cameraWorld: Vec3): { surveyFromRow: number[] } | { error: string } {
    if (!this.manifest) return { error: "no survey loaded" };
    if (this.state !== "tracking" || !this.worldFromSurvey) return { error: "survey boards not tracked" };
    const surveyFromWorld = inverseRigid(this.worldFromSurvey);
    const hit = transformPoint(surveyFromWorld, hitWorld);
    const camera = transformPoint(surveyFromWorld, cameraWorld);
    const g = rotateVector(surveyFromWorld, GRAVITY_UP);
    const { normal, point, extentRadiusM } = this.manifest.floor;
    const denominator = dot(normal, g);
    if (denominator <= 0.5) return { error: "survey floor too steep for gravity" };
    const origin = add(hit, scale(g, dot(normal, subtract(point, hit)) / denominator));
    const offset = subtract(origin, point);
    if (length(subtract(offset, scale(normal, dot(offset, normal)))) > extentRadiusM)
      return { error: "outside surveyed floor extent" };
    const heading = horizontalHeading(origin, camera, g);
    const frame = heading && rowFrame(origin, normal, heading, g);
    if (!frame) return { error: "row orientation undefined" };
    return { surveyFromRow: frame.matrix };
  }

  commit(surveyFromRow: number[], worldFromAnchorNow: number[] | null) {
    this.surveyFromRow = surveyFromRow;
    if (this.worldFromSurvey && worldFromAnchorNow)
      this.anchorFromSurvey = multiply(inverseRigid(worldFromAnchorNow), this.worldFromSurvey);
  }

  worldFromRow(): number[] | null {
    return this.worldFromSurvey && this.surveyFromRow ? multiply(this.worldFromSurvey, this.surveyFromRow) : null;
  }
}
