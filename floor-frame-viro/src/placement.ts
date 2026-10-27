import * as Haptics from "expo-haptics";
import {
  ViroTrackingStateConstants,
  type ViroARScene,
  type ViroARSceneNavigator,
  type ViroARHitTestResult,
  type ViroAnchor,
  type ViroCameraTransform,
  type ViroPlatformInfo,
  type ViroAmbientLightInfo,
} from "@reactvision/react-viro";
import { createStore } from "./store";
import {
  GRAVITY_UP,
  horizontalHeading,
  poseFromMatrix,
  surfacePose,
  type Pose,
  type Vec3,
} from "./surfacePose";
import {
  anchorMatrix,
  depthNormal,
  inverseRigid,
  multiply,
  poseDifference,
  rotateVector,
  transformMatrix,
  transformPoint,
} from "./viroGeometry";
import { diagnostics } from "./diagnostics";
import { aimGridPixel, aimPointFromLayout, type AimPoint } from "./aimPoint";
import { rectangleCenterZ } from "./rectangleGeometry";
import { chainGeometry, rectangleOffset, surfaceClearance, worldPoint } from "./diagnosticGeometry";
import type { CalibrationResult } from "./floorCalibration";
import { CalibrationSession, calibrationGrid, type ReferenceSample } from "./calibrationSampler";
import { accuracyBudget, budgetSummary } from "./accuracyBudget";
import { HeightCorrector, correctedWorldFromRow, type HeightObservation } from "./heightCorrection";
import { ReferenceFrameController } from "./referenceFrameController";
import { validateSurvey } from "./surveyManifest";
import { bundledSurvey } from "./survey/bundledSurvey";
import { HitMarkerBuffer } from "./hitMarkers";

export type PlacementMode = "baseline" | "calibrated" | "heightExperiment" | "surveyed";
export type PlacementPhase = "searching" | "calibrating" | "readyToCommit" | "locked" | "trackingLimited" | "lost";
export const PLACEMENT_MODES: { mode: PlacementMode; label: string }[] = [
  { mode: "baseline", label: "Single hit" },
  { mode: "calibrated", label: "Calibrate" },
  { mode: "heightExperiment", label: "Height exp." },
  { mode: "surveyed", label: "Survey" },
];
/** Version of the yaw/inclination composition recorded with each commit. */
export const YAW_CONVENTION_VERSION = 2;

const surveyValidation = bundledSurvey ? validateSurvey(bundledSurvey.manifest) : null;
export const surveyManifest = surveyValidation?.ok ? surveyValidation.manifest : null;
diagnostics.record(
  surveyValidation ? (surveyValidation.ok ? "survey_loaded" : "survey_invalid") : "survey_unavailable",
  surveyValidation?.ok
    ? { surveyId: surveyValidation.manifest.surveyId, revision: surveyValidation.manifest.revision, references: surveyValidation.manifest.references.map((r) => ({ id: r.id, role: r.role })), floor: surveyValidation.manifest.floor }
    : surveyValidation ? { errors: surveyValidation.errors } : { reason: "no bundled survey manifest" },
  true,
);

export const settingsStore = createStore({
  depth: true,
  occlusion: false,
  sessionId: 0,
});
export const modelStore = createStore<{
  pose: Pose | null;
  width: number;
  rectangleCount: number;
}>({
  pose: null,
  width: 0.2,
  rectangleCount: 11,
});
export const uiStore = createStore({
  mode: "baseline" as PlacementMode,
  phase: "searching" as PlacementPhase,
  followAnchorUpdates: true,
  large: false,
  rectangleCount: 11,
  occlusion: false,
  depth: true,
  locked: false,
  ready: false,
  busy: false,
  message: "Move your phone slowly to find the floor",
  detail: "Aim the center target at a floor or slope",
  quality: "",
  budget: budgetSummary(accuracyBudget(0.2, 11)),
  surveyAvailable: surveyManifest !== null,
  referenceState: surveyManifest ? "searching" : "unavailable",
});
/** World-space hit positions rendered as purple spheres. */
export const hitStore = createStore<Vec3[]>([]);
type UI = ReturnType<typeof uiStore.get>;
type Reference = {
  id: string;
  baseline: number[];
  baselineSource: string;
  latest: number[] | null;
  /** Matrix that transports the row; frozen while Follow anchor updates is off. */
  transport: number[];
  firstCallback: boolean;
};
let aimPoint: AimPoint | null = null;
let scene: ViroARScene | null = null;
let navigator: ViroARSceneNavigator | null = null;
let tracking: number = ViroTrackingStateConstants.TRACKING_UNAVAILABLE;
let generation = 0;
/** Coordinate epoch: changes on resets, session changes and reference loss. */
let epoch = 0;
let lastHitTime = 0;
let candidate: ViroARHitTestResult | null = null;
let candidateCamera: Vec3 | null = null;
let reference: Reference | null = null;
let referenceFromRow: number[] | null = null;
let calibration: CalibrationSession | null = null;
let lastBatchMs = -Infinity;
let probeCycle = 0;
let committed: Record<string, unknown> | null = null;
const corrector = new HeightCorrector();
const referenceController = new ReferenceFrameController(surveyManifest);
const hits = new HitMarkerBuffer();
let lastHitFlushMs = -Infinity;
const anchors = new Map<string, ViroAnchor>();
let trackingReason: number | undefined;
let cameraSample: { receivedMs: number; transform: ViroCameraTransform } | null = null;
let previousCameraMs: number | null = null;
let largestCameraGapMs = 0;
let cameraCallbacks = 0;
let lastProbeMs = -Infinity;
let lastCapabilitiesSession = -1;
let engineDiagnosticsInFlight = false;

const seconds = () => performance.now() / 1000;
const isLocked = (phase: PlacementPhase) => phase === "locked" || phase === "trackingLimited" || phase === "lost";
const hitPosition = (hit: ViroARHitTestResult) => hit.transform.position as Vec3;

function flushHits(force = false) {
  const now = performance.now();
  if (!force && now - lastHitFlushMs < 200) return;
  lastHitFlushMs = now;
  hitStore.set(hits.all());
}

async function engineDiagnostics(token: number) {
  const currentNavigator = navigator;
  if (!currentNavigator) return;
  const settings = settingsStore.get();
  if (lastCapabilitiesSession !== settings.sessionId) {
    lastCapabilitiesSession = settings.sessionId;
    const results = await Promise.allSettled([
      currentNavigator.sceneNavigator.isDepthOcclusionSupported(),
      currentNavigator.sceneNavigator.isPreferMonocularDepth(),
    ]);
    diagnostics.record("depth_capabilities", { sessionId: settings.sessionId, results, staleGeneration: generation !== token }, true);
  }
  if (generation === token && navigator === currentNavigator && diagnostics.due("world_mesh", 1000)) {
    try {
      const stats = await currentNavigator.sceneNavigator.getWorldMeshStats();
      diagnostics.record("world_mesh_stats", { stats, sessionId: settings.sessionId, staleGeneration: generation !== token });
    } catch (error) { diagnostics.record("world_mesh_error", { error }); }
  }
}

function anchorSummary(anchor: ViroAnchor) {
  return { ...anchor, vertices: anchor.vertices?.slice(0, 64), vertexCount: anchor.vertices?.length };
}
function calibrationSummary(result: CalibrationResult | null) {
  if (!result) return null;
  return { ...result, normal: result.normal, matrix: result.matrix };
}
function debugSnapshot() {
  const model = modelStore.get();
  const ui = uiStore.get();
  return {
    aimPoint, placementOrigin: "camera-facing bottom edge", generation, epoch, tracking, trackingReason,
    mode: ui.mode, phase: ui.phase, settings: settingsStore.get(), ui,
    model, candidate, camera: cameraSample,
    cameraAgeMs: cameraSample ? performance.now() - cameraSample.receivedMs : null,
    reference, referenceFromRow,
    calibration: calibration ? { batches: calibration.batch, observations: calibration.observations.length, gridSize: calibration.gridSize, last: calibrationSummary(calibration.last) } : null,
    heightCorrection: { appliedDeltaM: corrector.appliedDeltaM, stale: corrector.stale },
    survey: { state: referenceController.state, worldFromSurvey: referenceController.worldFromSurvey, surveyFromRow: referenceController.surveyFromRow },
    committed,
    budget: accuracyBudget(model.width, model.rectangleCount),
    chain: model.pose ? chainGeometry(model.pose, model.width, model.rectangleCount) : null,
    anchorCount: anchors.size,
    anchors: [...anchors.values()].slice(0, 64).map(anchorSummary),
  };
}

function updateUI(change: Partial<UI>) {
  const current = uiStore.get();
  if (
    Object.entries(change).some(
      ([key, value]) => current[key as keyof UI] !== value,
    )
  )
    uiStore.set({ ...current, ...change });
}
function setPhase(phase: PlacementPhase, reason: string) {
  const previous = uiStore.get().phase;
  if (previous !== phase) diagnostics.record("placement_state_changed", { previous, phase, reason, mode: uiStore.get().mode, epoch }, true);
  updateUI({ phase, locked: isLocked(phase) });
}
function updateBudget() {
  const model = modelStore.get();
  const budget = accuracyBudget(model.width, model.rectangleCount);
  const uncertainty = calibration?.last?.uncertaintyDeg ?? undefined;
  const summary = budgetSummary(budget, uncertainty ?? undefined);
  if (summary !== uiStore.get().budget) diagnostics.record("accuracy_budget", { budget, calibrationUncertaintyDeg: uncertainty ?? null, summary }, true);
  updateUI({ budget: summary });
}
function showPose(pose: Pose | null) {
  const current = modelStore.get();
  if (
    current.pose === pose ||
    (pose &&
      current.pose &&
      pose.matrix.every(
        (value, index) => value === current.pose!.matrix[index],
      ))
  )
    return;
  modelStore.set({ ...current, pose });
}
/** Uncorrected root: worldFromReference(t) * referenceFromRowAtCommit. */
function baseWorldFromRow(): number[] | null {
  const ui = uiStore.get();
  if (ui.mode === "surveyed" && isLocked(ui.phase)) return referenceController.worldFromRow();
  return reference && referenceFromRow ? multiply(reference.transport, referenceFromRow) : null;
}
/** The phone height offset applies only in the experimental mode; zero elsewhere. */
function renderRow() {
  const ui = uiStore.get();
  const base = baseWorldFromRow();
  if (!base) return;
  const applied = ui.mode === "heightExperiment" && isLocked(ui.phase) ? corrector.appliedDeltaM : 0;
  showPose(poseFromMatrix(correctedWorldFromRow(base, applied)));
}
function currentAnchorMatrix() {
  return reference ? reference.latest ?? reference.baseline : null;
}

function heightObservations(target: { world: Vec3 }, results: ViroARHitTestResult[], cycle: number): HeightObservation[] {
  return results.slice(0, 4).map((hit) => {
    const position = hitPosition(hit);
    const plane = hit.type !== "DepthPoint" && hit.type !== "FeaturePoint";
    return {
      point: position,
      normal: plane ? (transformMatrix(position, hit.transform.rotation).slice(4, 7) as Vec3) : undefined,
      source: hit.type,
      targetMissM: Math.hypot(...position.map((v, i) => v - target.world[i])),
      cycle,
    };
  });
}

/** Diagnostic-only probes; their results only reach the gated height experiment. */
async function probeLockedSurface(currentScene: ViroARScene, token: number) {
  const now = performance.now();
  if (now - lastProbeMs < 1000) return;
  lastProbeMs = now;
  const model = modelStore.get();
  const pose = model.pose;
  const base = baseWorldFromRow();
  if (!pose || !base) return;
  const basePose = poseFromMatrix(base);
  const cycle = ++probeCycle;
  const startedMs = performance.now();
  const observations: HeightObservation[] = [];
  const probePoints: Vec3[] = [];
  try {
    const orientation = await currentScene.getCameraOrientationAsync();
    if (generation !== token || scene !== currentScene || !uiStore.get().locked) return;
    const camera = orientation.position as Vec3;
    const geometry = chainGeometry(basePose, model.width, model.rectangleCount);
    const centers = Array.from({ length: model.rectangleCount }, (_, i) => ({
      index: i, world: worldPoint(base, [rectangleOffset(i, model.width), 0.001, rectangleCenterZ(model.width)]),
    }));
    const nearest = centers.reduce((best, next) =>
      Math.hypot(...next.world.map((v, i) => v - camera[i])) < Math.hypot(...best.world.map((v, i) => v - camera[i])) ? next : best);
    const targets = [
      { label: "chain_center", world: geometry.center },
      { label: "chain_left_end", world: geometry.leftEnd },
      { label: "chain_right_end", world: geometry.rightEnd },
      { label: `nearest_rectangle_${nearest.index}`, world: nearest.world },
    ];
    // Independent rays use the same API as the existing adjacent-depth tests.
    // The poll waits for all four so another diagnostic cycle cannot overlap.
    const results = await Promise.allSettled(targets.map(async (target) => {
      if (generation !== token || scene !== currentScene || !uiStore.get().locked) return;
      const ray = target.world.map((v, i) => v - camera[i]) as Vec3;
      const distance = Math.hypot(...ray);
      const facing = ray.reduce((sum, v, i) => sum + v / Math.max(distance, 1e-6) * orientation.forward[i], 0);
      if (distance > 8 || distance < 0.1 || facing < 0.5) {
        diagnostics.record("surface_probe_skipped", { target, camera, distance, facing, reason: "outside 0.1–8 m range or 60 degree forward cone" });
        return;
      }
      const queryStartedMs = performance.now();
      const unitRay = ray.map(value => value / distance) as Vec3;
      const probeHits: ViroARHitTestResult[] = await currentScene.performARHitTestWithRay(unitRay);
      if (generation !== token || scene !== currentScene || !uiStore.get().locked) return;
      const surfaces = probeHits.filter((hit) => hit.type !== "FeaturePoint");
      probePoints.push(...surfaces.slice(0, 4).map(hitPosition));
      observations.push(...heightObservations(target, surfaces, cycle));
      diagnostics.record("locked_surface_probe", {
        target, camera, unitRay, durationMs: performance.now() - queryStartedMs,
        poseAtQuery: pose, basePose, poseAtCompletion: modelStore.get().pose,
        settings: settingsStore.get(), hitCount: probeHits.length,
        hits: probeHits.slice(0, 32).map(hit => ({ ...hit,
          clearance: hit.type === "FeaturePoint" ? null : surfaceClearance(basePose, hit.transform.position),
          targetMissM: Math.hypot(...hit.transform.position.map((v, i) => v - target.world[i])),
        })),
      });
    }));
    hits.setProbes(probePoints);
    flushHits(true);
    diagnostics.record("locked_probe_cycle", {
      durationMs: performance.now() - startedMs, camera: orientation, geometry, nearestRectangle: nearest,
      staleGeneration: generation !== token,
      failures: results.flatMap((result, index) => result.status === "rejected" ? [{ target: targets[index], error: result.reason }] : []),
    });
    if (generation !== token) return;
    const ui = uiStore.get();
    // Shadow estimate in every locked mode; applied only in the experiment.
    const update = tracking === ViroTrackingStateConstants.TRACKING_NORMAL
      ? corrector.update(base, observations, seconds(), ui.mode === "heightExperiment")
      : null;
    diagnostics.record("height_correction", {
      mode: ui.mode, cycle, update, applied: ui.mode === "heightExperiment" ? corrector.appliedDeltaM : 0,
      shadowOnly: ui.mode !== "heightExperiment", surveyState: referenceController.state, epoch,
    });
    renderRow();
    if (ui.mode === "heightExperiment" && update)
      updateUI({ quality: `Height exp. · applied ${(corrector.appliedDeltaM * 100).toFixed(1)} cm${update.proposedDeltaM === null ? " · waiting for floor" : ` · proposed ${(update.proposedDeltaM * 100).toFixed(1)} cm`}` });
  } catch (error) {
    if (generation === token) diagnostics.record("surface_probe_error", { error, durationMs: performance.now() - startedMs });
  }
}
function invalid(message: string) {
  if (uiStore.get().message !== message) diagnostics.record("preview_invalid", { message, candidate, pose: modelStore.get().pose });
  lastHitTime = 0;
  candidate = null;
  hits.setPreview([]);
  flushHits(true);
  showPose(null);
  updateUI({
    ready: false,
    message,
    detail: "Aim the center target at a floor or slope",
  });
}
function closestSurface(
  results: ViroARHitTestResult[],
  camera: Vec3,
  depth: boolean,
) {
  return results
    .filter(
      (hit) =>
        hit.type !== "FeaturePoint" && (depth || hit.type !== "DepthPoint"),
    )
    .sort(
      (a, b) =>
        Math.hypot(...a.transform.position.map((v, i) => v - camera[i])) -
        Math.hypot(...b.transform.position.map((v, i) => v - camera[i])),
    )[0];
}
function resetPlacement(message = "Scan the floor again") {
  diagnostics.record("placement_reset", debugSnapshot(), true);
  generation++;
  epoch++;
  reference = null;
  referenceFromRow = null;
  calibration = null;
  committed = null;
  corrector.reset();
  referenceController.clearPlacement();
  anchors.clear();
  lastProbeMs = -Infinity;
  hits.clear();
  flushHits(true);
  updateUI({ busy: false, quality: "" });
  setPhase("searching", message);
  updateBudget();
  invalid(message);
}

/** Creates the Viro anchor that becomes this placement's tracking reference. */
async function createReference(currentScene: ViroARScene, hit: ViroARHitTestResult, token: number): Promise<Reference | null> {
  const node = await currentScene.createAnchoredNode(hit);
  diagnostics.record("anchor_creation_result", { node, hit, staleGeneration: token !== generation }, true);
  if (token !== generation) return null;
  if (!node?.anchorId) {
    updateUI({ message: "Viro could not create an anchor", detail: "Aim at a detected plane and try again" });
    return null;
  }
  // IMPLEMENTATION_PLAN section 6: baseline from the created anchor itself,
  // not the hit. iOS returns its rotation as a quaternion [x, y, z, w].
  const hitMatrix = transformMatrix(hit.transform.position, hit.transform.rotation);
  const nodeTransform = node.transform
    ? anchorMatrix(node.transform.position as Vec3, node.transform.rotation as unknown as number[])
    : null;
  const callback = anchors.get(node.anchorId);
  const callbackMatrix = callback ? anchorMatrix(callback.position as Vec3, callback.rotation as unknown as number[])?.matrix ?? null : null;
  const baseline = nodeTransform?.matrix ?? callbackMatrix ?? hitMatrix;
  const baselineSource = nodeTransform ? `createAnchoredNode transform (${nodeTransform.format})` : callbackMatrix ? "first anchor callback" : "hit transform (anchor pose unavailable)";
  diagnostics.record("anchor_baseline", {
    anchorId: node.anchorId, baselineSource, hitMatrix, nodeMatrix: nodeTransform?.matrix ?? null,
    nodeRotationFormat: nodeTransform?.format ?? null, callbackMatrix,
    hitVsNode: nodeTransform ? poseDifference(hitMatrix, nodeTransform.matrix) : null,
    nodeVsCallback: nodeTransform && callbackMatrix ? poseDifference(nodeTransform.matrix, callbackMatrix) : null,
  }, true);
  return { id: node.anchorId, baseline, baselineSource, latest: callbackMatrix, transport: callbackMatrix ?? baseline, firstCallback: callbackMatrix !== null };
}

function commitRecord(calibrationResult: CalibrationResult | null) {
  const model = modelStore.get();
  const budget = accuracyBudget(model.width, model.rectangleCount);
  committed = {
    placementId: `${settingsStore.get().sessionId}-${epoch}-${Date.now()}`,
    sessionId: settingsStore.get().sessionId,
    mode: uiStore.get().mode,
    referenceId: reference?.id ?? null,
    referenceBaselineSource: reference?.baselineSource ?? null,
    referenceFromRow,
    surveyFromRow: referenceController.surveyFromRow,
    calibrationResult: calibrationSummary(calibrationResult),
    yawConventionVersion: YAW_CONVENTION_VERSION,
    validatedRadius: budget.radiusM,
    budget,
    width: model.width,
    rectangleCount: model.rectangleCount,
    committedTimestamp: Date.now(),
    epoch,
  };
  diagnostics.record("placement_committed", committed, true);
}

function lockPlacement(message: string) {
  corrector.reset();
  hits.setPreview([]);
  flushHits(true);
  setPhase("locked", message);
  updateUI({ message, detail: "Walk along the row · tap Reposition to move it" });
  renderRow();
  diagnostics.record("placement_anchored", debugSnapshot(), true);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

async function sampleCalibration(currentScene: ViroARScene, token: number) {
  const now = performance.now();
  const session = calibration;
  const target = aimPoint;
  const worldFromReference = currentAnchorMatrix();
  if (!session || !target || !worldFromReference || now - lastBatchMs < 400) return;
  lastBatchMs = now;
  const started = performance.now();
  const orientation = await currentScene.getCameraOrientationAsync();
  const grid = calibrationGrid(session.gridSize);
  const settings = settingsStore.get();
  const batches = await Promise.all(grid.map((fraction) => {
    const [x, y] = aimGridPixel(target, fraction);
    return currentScene.performARHitTestWithPoint(x, y);
  }));
  if (token !== generation || calibration !== session) return;
  const camera = orientation.position as Vec3;
  const referenceFromWorld = inverseRigid(worldFromReference);
  const cameraRef = transformPoint(referenceFromWorld, camera);
  const samples: ReferenceSample[] = [];
  const worldPoints: Vec3[] = [];
  for (const results of batches) {
    const hit = closestSurface(results, camera, settings.depth || settings.occlusion);
    if (!hit) continue;
    worldPoints.push(hitPosition(hit));
    // Missing capture timestamps stay missing; JS receipt time is recorded separately.
    samples.push({ point: transformPoint(referenceFromWorld, hitPosition(hit)), camera: cameraRef, source: hit.type });
  }
  const duration = (performance.now() - started) / 1000;
  const batch = session.addBatch(samples, seconds(), duration);
  hits.addCalibration(worldPoints);
  flushHits();
  const result = session.fit(seconds());
  diagnostics.record("calibration_batch", { batch, grid: grid.length, accepted: samples.length, durationS: duration, gridSize: session.gridSize, worldFromReference, timing: "JS receipt time; Viro exposes no capture timestamp for hit tests" });
  if (diagnostics.due("calibration_fit", 1000) || result.status !== session.last?.status)
    diagnostics.record("calibration_fit", calibrationSummary(result), result.status !== "insufficient");
  if (result.matrix && result.status !== "insufficient") {
    referenceFromRow = result.matrix;
    if (uiStore.get().phase === "calibrating") setPhase("readyToCommit", "calibration measured");
  } else if (uiStore.get().phase === "readyToCommit") {
    setPhase("calibrating", "calibration evidence insufficient");
  }
  renderRow();
  updateBudget();
  updateUI({
    message: result.status === "insufficient" ? "Calibrating floor · scan nearby ground slowly" : result.status === "research_consistent" ? "Floor calibrated · research gates met" : "Floor measured · ready to anchor",
    detail: calibrationDetail(result),
    quality: result.status === "insufficient" ? result.reasons.slice(0, 3).join(" · ") : "Precision unverified",
  });
}

function calibrationDetail(result: CalibrationResult) {
  const parts = [
    `${result.occupiedCells} cells`,
    `${result.alongExtentM.toFixed(1)}×${result.acrossExtentM.toFixed(1)} m`,
  ];
  if (result.alongRowInclination !== null) parts.push(`row ${result.alongRowInclination.toFixed(2)}°`);
  if (result.uncertaintyDeg !== null) parts.push(`±${result.uncertaintyDeg.toFixed(3)}°`);
  return parts.join(" · ");
}

async function startCalibration(currentScene: ViroARScene) {
  const hit = candidate, pose = modelStore.get().pose, camera = candidateCamera;
  if (!hit || !pose || !camera) return;
  const token = ++generation;
  updateUI({ busy: true });
  try {
    const created = await createReference(currentScene, hit, token);
    if (!created || token !== generation) return;
    reference = created;
    // Latch origin and heading before the user moves; movement only gathers evidence.
    const referenceFromWorld = inverseRigid(created.baseline);
    const origin = transformPoint(referenceFromWorld, pose.position);
    const cameraRef = transformPoint(referenceFromWorld, camera);
    const gravity = rotateVector(referenceFromWorld, GRAVITY_UP);
    const heading = horizontalHeading(origin, cameraRef, gravity);
    if (!heading) {
      updateUI({ message: "Step back from the target", detail: "The initial facing direction is undefined" });
      return;
    }
    referenceFromRow = multiply(referenceFromWorld, pose.matrix);
    calibration = new CalibrationSession(origin, heading, gravity, epoch);
    lastBatchMs = -Infinity;
    hits.setPreview([]);
    diagnostics.record("calibration_started", { referenceId: created.id, originReference: origin, cameraReference: cameraRef, headingReference: heading, gravityReference: gravity, provisionalPose: pose, epoch }, true);
    setPhase("calibrating", "calibration started");
    updateUI({ message: "Calibrating floor · scan nearby ground slowly", detail: "Sweep the target across the floor around and beside the row", quality: "" });
    renderRow();
  } catch (error) {
    diagnostics.record("anchor_creation_error", { error, staleGeneration: token !== generation }, true);
    if (token === generation) updateUI({ message: "Could not start calibration", detail: String(error) });
  } finally {
    if (token === generation) updateUI({ busy: false });
  }
}

async function commitSingleHit(currentScene: ViroARScene) {
  const hit = candidate, pose = modelStore.get().pose;
  if (!hit || !pose) return;
  const token = ++generation;
  updateUI({ busy: true });
  try {
    const created = await createReference(currentScene, hit, token);
    if (!created || token !== generation) return;
    reference = created;
    // Store the row relative to the actual anchor, so the first render cannot jump.
    referenceFromRow = multiply(inverseRigid(created.baseline), pose.matrix);
    commitRecord(null);
    lockPlacement("Anchored in place");
  } catch (error) {
    diagnostics.record("anchor_creation_error", { error, staleGeneration: token !== generation }, true);
    if (token === generation) updateUI({ message: "Could not anchor", detail: String(error) });
  } finally {
    if (token === generation) updateUI({ busy: false });
  }
}

async function commitSurveyed(currentScene: ViroARScene) {
  const hit = candidate, camera = candidateCamera;
  if (!hit || !camera) return;
  const placed = referenceController.placeRow(hitPosition(hit), camera);
  if ("error" in placed) {
    diagnostics.record("survey_placement_rejected", { error: placed.error, state: referenceController.state }, true);
    updateUI({ message: "Cannot anchor to survey", detail: placed.error });
    return;
  }
  const token = ++generation;
  updateUI({ busy: true });
  try {
    // An ordinary anchor only carries the survey relation while boards are out of view.
    const created = await createReference(currentScene, hit, token);
    if (token !== generation) return;
    reference = created;
    referenceFromRow = null;
    referenceController.commit(placed.surveyFromRow, created?.baseline ?? null);
    commitRecord(null);
    lockPlacement("Anchored to survey");
  } catch (error) {
    diagnostics.record("anchor_creation_error", { error, staleGeneration: token !== generation }, true);
    if (token === generation) updateUI({ message: "Could not anchor", detail: String(error) });
  } finally {
    if (token === generation) updateUI({ busy: false });
  }
}

export const placement = {
  debugSnapshot,
  setAimLayout(layout: { x: number; y: number; width: number; height: number }, pixelRatio: number) {
    const next = aimPointFromLayout(layout, pixelRatio);
    if (JSON.stringify(next) === JSON.stringify(aimPoint)) return;
    aimPoint = next;
    diagnostics.record("aim_point_changed", { aimPoint, layout, pixelRatio });
    if (uiStore.get().phase === "searching") {
      generation++;
      invalid("Aim the target at a floor or slope");
    }
  },
  attachScene(value: ViroARScene | null) {
    diagnostics.record("scene_attached", { attached: value !== null, changed: scene !== value, generation }, true);
    if (scene !== value) generation++;
    scene = value;
  },
  attachNavigator(value: ViroARSceneNavigator | null) {
    diagnostics.record("navigator_attached", { attached: value !== null }, true);
    navigator = value;
    lastCapabilitiesSession = -1;
  },
  trackingUpdated(state: number, reason?: number) {
    if (state !== tracking || reason !== trackingReason) diagnostics.record("tracking_changed", { previousState: tracking, state, reason, phase: uiStore.get().phase }, true);
    trackingReason = reason;
    tracking = state;
    const phase = uiStore.get().phase;
    if (state !== ViroTrackingStateConstants.TRACKING_NORMAL) {
      generation++;
      updateUI({ busy: false });
      corrector.markStale();
      if (phase === "locked") {
        setPhase("trackingLimited", "tracking limited");
        updateUI({ message: "Tracking limited · placement confidence reduced", detail: "Move slowly; the row keeps its last placement" });
      } else if (phase === "searching") invalid("Move slowly · tracking the room");
      else if (phase === "calibrating" || phase === "readyToCommit") updateUI({ message: "Tracking limited · calibration paused", detail: "Move slowly until tracking recovers" });
    } else if (phase === "trackingLimited") {
      setPhase("locked", "tracking recovered");
      updateUI({ message: "Tracking recovered", detail: "Walk along the row · tap Reposition to move it" });
    }
  },
  cameraUpdated(transform: ViroCameraTransform) {
    const now = performance.now();
    if (previousCameraMs !== null) largestCameraGapMs = Math.max(largestCameraGapMs, now - previousCameraMs);
    previousCameraMs = now;
    cameraCallbacks++;
    cameraSample = { receivedMs: now, transform };
    if (diagnostics.due("camera", 200)) {
      const model = modelStore.get();
      diagnostics.record("camera_pose", {
        camera: transform, generation, epoch, tracking, trackingReason, settings: settingsStore.get(),
        phase: uiStore.get().phase, pose: model.pose, referenceId: reference?.id,
        chain: model.pose ? chainGeometry(model.pose, model.width, model.rectangleCount) : null,
      });
    }
    if (diagnostics.due("camera_timing", 1000)) {
      diagnostics.record("camera_callback_timing", { callbacksSinceLastRecord: cameraCallbacks, largestGapMs: largestCameraGapMs, note: "JS callback arrival timing, not renderer FPS" });
      cameraCallbacks = 0;
      largestCameraGapMs = 0;
    }
  },
  lightUpdated(light: ViroAmbientLightInfo) {
    if (diagnostics.due("light", 1000)) diagnostics.record("ambient_light", light);
  },
  pointCloudUpdated(cloud: unknown) {
    if (!diagnostics.due("point_cloud", 1000)) return;
    if (!cloud || typeof cloud !== "object" || !("points" in cloud) || !Array.isArray(cloud.points)) {
      diagnostics.record("point_cloud_unavailable", { reason: "unexpected payload shape" });
      return;
    }
    const points: unknown[] = cloud.points;
    diagnostics.record("point_cloud", { count: points.length, sample: points.slice(0, 64), identifiers: "identifiers" in cloud && Array.isArray(cloud.identifiers) ? cloud.identifiers.slice(0, 64) : undefined });
  },
  platformUpdated(platform: ViroPlatformInfo) {
    diagnostics.record("viro_platform", platform, true);
  },
  depthReady() {
    diagnostics.record("depth_ready", { settings: settingsStore.get() }, true);
  },
  anchorFound(anchor: ViroAnchor) {
    diagnostics.record("anchor_found", anchorSummary(anchor));
    placement.anchorUpdated(anchor);
  },
  anchorUpdated(anchor: ViroAnchor) {
    const previous = anchors.get(anchor.anchorId);
    anchors.set(anchor.anchorId, anchor);
    if (reference?.id === anchor.anchorId) {
      const converted = anchorMatrix(anchor.position as Vec3, anchor.rotation as unknown as number[]);
      if (!converted) return;
      if (!reference.firstCallback) {
        reference.firstCallback = true;
        diagnostics.record("anchor_baseline_callback", {
          anchorId: anchor.anchorId, baseline: reference.baseline, baselineSource: reference.baselineSource,
          callback: converted.matrix, callbackFormat: converted.format,
          difference: poseDifference(reference.baseline, converted.matrix),
        }, true);
      }
      reference.latest = converted.matrix;
      if (uiStore.get().followAnchorUpdates) reference.transport = converted.matrix;
      const before = modelStore.get().pose;
      renderRow();
      diagnostics.record("bound_anchor_updated", {
        anchor: anchorSummary(anchor), previous: previous ? anchorSummary(previous) : null,
        baseline: reference.baseline, transport: reference.transport, referenceFromRow,
        followAnchorUpdates: uiStore.get().followAnchorUpdates,
        renderedBefore: before, renderedAfter: modelStore.get().pose,
        deltaFromBaseline: poseDifference(reference.baseline, converted.matrix),
      });
    } else if (!previous || diagnostics.due(`anchor:${anchor.anchorId}`, 1000)) {
      diagnostics.record("surface_anchor_updated", { anchor: anchorSummary(anchor), previous: previous ? anchorSummary(previous) : null });
    }
  },
  anchorRemoved(anchor?: ViroAnchor) {
    diagnostics.record("anchor_removed", { anchor: anchor ? anchorSummary(anchor) : null, bound: anchor?.anchorId === reference?.id }, true);
    if (!anchor) return;
    anchors.delete(anchor.anchorId);
    if (reference?.id !== anchor.anchorId) return;
    const phase = uiStore.get().phase;
    epoch++;
    corrector.markStale();
    if (phase === "calibrating" || phase === "readyToCommit") {
      resetPlacement("Reference anchor lost · calibrate again");
    } else if (isLocked(phase)) {
      // Keep the last placement visible but never adopt a new floor or origin silently.
      setPhase("lost", "reference anchor removed");
      updateUI({ message: "Placement lost · tap Reposition", detail: "The tracking reference was removed; this position is uncertain" });
    }
  },
  markerObserved(id: string, anchor: ViroAnchor) {
    referenceController.observe({
      id,
      worldFromMarker: transformMatrix(anchor.position as Vec3, anchor.rotation as Vec3),
      timestamp: seconds(),
      epoch,
      tracking: tracking === ViroTrackingStateConstants.TRACKING_NORMAL,
    });
    if (diagnostics.due(`marker:${id}`, 500)) diagnostics.record("reference_observation", { id, anchor: anchorSummary(anchor), epoch, timing: "JS receipt time" });
  },
  markerRemoved(id: string) {
    referenceController.remove(id);
    diagnostics.record("reference_removed", { id }, true);
  },
  async sample() {
    const currentScene = scene;
    const target = aimPoint;
    const ui = uiStore.get();
    if (surveyManifest) {
      const previous = referenceController.state;
      const state = referenceController.update(seconds(), epoch, currentAnchorMatrix());
      if (state !== previous) diagnostics.record("reference_state_changed", { previous, state, fusion: referenceController.lastFusion }, true);
      else if (diagnostics.due("reference_fusion", 1000)) diagnostics.record("reference_fusion", { state, fusion: referenceController.lastFusion });
      updateUI({ referenceState: state });
      if (ui.mode === "surveyed" && isLocked(ui.phase) && (ui.followAnchorUpdates || !modelStore.get().pose)) renderRow();
    }
    if (
      !currentScene ||
      !target ||
      ui.busy ||
      tracking !== ViroTrackingStateConstants.TRACKING_NORMAL
    )
      return;
    const token = generation;
    const settings = settingsStore.get();
    // Capability/mesh telemetry must never hold up placement if an optional
    // native query is slow or unavailable on one platform.
    if (!engineDiagnosticsInFlight && diagnostics.due("engine_poll", 1000)) {
      engineDiagnosticsInFlight = true;
      void engineDiagnostics(token)
        .catch(error => diagnostics.record("engine_diagnostics_error", { error }))
        .finally(() => { engineDiagnosticsInFlight = false; });
    }
    if (ui.locked) {
      if (diagnostics.due("locked_snapshot", 1000)) diagnostics.record("locked_snapshot", debugSnapshot());
      await probeLockedSurface(currentScene, token);
      return;
    }
    if (ui.phase === "calibrating" || ui.phase === "readyToCommit") {
      try {
        await sampleCalibration(currentScene, token);
      } catch (error) {
        if (diagnostics.due("calibration_error", 1000)) diagnostics.record("calibration_error", { error });
      }
      return;
    }
    const sampleStartedMs = performance.now();
    const recordPreview = diagnostics.due("preview", 200);
    try {
      const orientation = await currentScene.getCameraOrientationAsync();
      const camera = orientation.position as Vec3;
      // Hit-test the visible crosshair, not the camera-forward ray hidden by the controls.
      const results: ViroARHitTestResult[] =
        await currentScene.performARHitTestWithPoint(target.x, target.y);
      const hit = closestSurface(
        results,
        camera,
        settings.depth || settings.occlusion,
      );
      if (token !== generation) return;
      if (recordPreview) diagnostics.record("preview_hits", { aimPoint: target, camera: orientation, settings, hits: results.slice(0, 32), hitCount: results.length, selected: hit, durationMs: performance.now() - sampleStartedMs });
      if (!hit) {
        invalid("Aim at a textured floor and move slowly");
        return;
      }
      const matrix = transformMatrix(
        hit.transform.position,
        hit.transform.rotation,
      );
      let normal: Vec3 | null = matrix.slice(4, 7) as Vec3;
      const previewPoints: Vec3[] = [hitPosition(hit)];
      if (hit.type === "DepthPoint") {
        // A depth point alone does not establish a surface orientation.
        const [rightHits, upHits]: ViroARHitTestResult[][] = await Promise.all([
          currentScene.performARHitTestWithPoint(target.adjacentX, target.y),
          currentScene.performARHitTestWithPoint(target.x, target.adjacentY),
        ]);
        const rightHit = closestSurface(
          rightHits.filter((h) => h.type === "DepthPoint"),
          camera,
          true,
        );
        const upHit = closestSurface(
          upHits.filter((h) => h.type === "DepthPoint"),
          camera,
          true,
        );
        if (rightHit) previewPoints.push(hitPosition(rightHit));
        if (upHit) previewPoints.push(hitPosition(upHit));
        normal =
          rightHit && upHit
            ? depthNormal(
                hit.transform.position,
                rightHit.transform.position,
                upHit.transform.position,
              )
            : null;
        if (recordPreview) diagnostics.record("depth_normal_samples", { center: hit, right: rightHit, up: upHit, rightHits: rightHits.slice(0, 16), upHits: upHits.slice(0, 16), normal, aimPoint: target });
      }
      if (token !== generation) return;
      hits.setPreview(previewPoints);
      flushHits();
      const pose =
        normal && surfacePose(hit.transform.position, normal, camera);
      if (!pose) {
        invalid("Point down at a floor or slope");
        hits.setPreview(previewPoints);
        flushHits();
        return;
      }
      lastHitTime = Date.now();
      candidateCamera = camera;
      // Prefer a nearby plane result for Viro anchor creation. Synthetic depth
      // hits may not support createAnchoredNode on every backend.
      candidate =
        hit.type === "DepthPoint"
          ? (results.find(
              (other) =>
                other.type !== "DepthPoint" &&
                other.type !== "FeaturePoint" &&
                Math.hypot(
                  ...other.transform.position.map(
                    (value, index) => value - hit.transform.position[index],
                  ),
                ) < 0.1,
            ) ?? hit)
          : hit;
      showPose(pose);
      if (recordPreview) diagnostics.record("preview_pose", { pose, normal, anchorCandidate: candidate, chain: chainGeometry(pose, modelStore.get().width, modelStore.get().rectangleCount), durationMs: performance.now() - sampleStartedMs });
      const mode = uiStore.get().mode;
      const surveyBlocked = mode === "surveyed" && referenceController.state !== "tracking";
      updateUI({
        ready: !surveyBlocked,
        message: surveyBlocked ? "Point at a survey board" : mode === "baseline" || mode === "surveyed" ? "Ready to anchor" : "Ready to calibrate",
        detail: `${pose.distance.toFixed(1)} m away · ${pose.slope.toFixed(0)}° slope`,
      });
    } catch (error) {
      if (diagnostics.due("sample_error", 1000)) diagnostics.record("sample_error", { error, staleGeneration: token !== generation, durationMs: performance.now() - sampleStartedMs });
      if (token !== generation) return;
      invalid("AR hit test unavailable");
      updateUI({ detail: String(error) });
    }
  },
  setMode(mode: PlacementMode) {
    const ui = uiStore.get();
    if (ui.busy || ui.phase !== "searching" || ui.mode === mode) return;
    if (mode === "surveyed" && !surveyManifest) return;
    diagnostics.record("placement_mode_changed", { previous: ui.mode, mode }, true);
    // A mode change always needs a new commit and clears experimental offsets.
    corrector.reset();
    updateUI({ mode, quality: "" });
    invalid("Aim the target at a floor or slope");
  },
  setFollowAnchorUpdates(followAnchorUpdates: boolean) {
    if (uiStore.get().busy) return;
    updateUI({ followAnchorUpdates });
    if (followAnchorUpdates && reference) {
      reference.transport = reference.latest ?? reference.baseline;
      renderRow();
    }
    diagnostics.record("anchor_following_changed", debugSnapshot(), true);
  },
  setWidth(large: boolean) {
    diagnostics.record("width_changed", { large, previousWidth: modelStore.get().width, width: large ? 3 : 0.2 }, true);
    updateUI({ large });
    modelStore.set({ ...modelStore.get(), width: large ? 3 : 0.2 });
    hits.version++;
    flushHits(true);
    updateBudget();
  },
  setRectangleCount(rectangleCount: number) {
    const count = Math.min(51, Math.max(1, Math.round(rectangleCount)));
    diagnostics.record("rectangle_count_changed", { previousCount: modelStore.get().rectangleCount, count }, true);
    updateUI({ rectangleCount: count });
    modelStore.set({ ...modelStore.get(), rectangleCount: count });
    updateBudget();
  },
  setOcclusion(occlusion: boolean) {
    if (uiStore.get().busy) return;
    diagnostics.record("occlusion_changed", { previous: settingsStore.get().occlusion, occlusion, phase: uiStore.get().phase }, true);
    generation++;
    settingsStore.set({ ...settingsStore.get(), occlusion });
    updateUI({ occlusion });
    if (uiStore.get().phase === "searching") invalid("Aim at the floor to reposition");
  },
  configure(depth: boolean) {
    diagnostics.record("session_reset_requested", { depth, settings: settingsStore.get() }, true);
    referenceController.reset();
    resetPlacement();
    tracking = ViroTrackingStateConstants.TRACKING_UNAVAILABLE;
    updateUI({ depth });
    const settings = settingsStore.get();
    // Recreate Viro's navigator/session for a full reset and depth-mode change.
    settingsStore.set({
      ...settings,
      depth,
      sessionId: settings.sessionId + 1,
    });
  },
  /** Clears the reference anchor and any calibration or placement. */
  reposition(message = "Scan the floor again") {
    // Viro has no public remove-single-anchor API. Clear anchors without resetting tracking.
    navigator?.sceneNavigator.resetARSession(false, true);
    diagnostics.record("unanchor_requested", { id: reference?.id, phase: uiStore.get().phase }, true);
    resetPlacement(message);
  },
  async primaryAction() {
    const currentScene = scene;
    const ui = uiStore.get();
    diagnostics.record("placement_requested", { ...debugSnapshot(), hitAgeMs: Date.now() - lastHitTime }, true);
    if (ui.busy || !currentScene) return;
    if (isLocked(ui.phase)) {
      placement.reposition();
      return;
    }
    if (ui.phase === "readyToCommit") {
      const result = calibration?.last;
      if (!result?.matrix || result.status === "insufficient") return;
      referenceFromRow = result.matrix;
      commitRecord(result);
      calibration = null;
      lockPlacement(result.status === "research_consistent" ? "Anchored · research gates met" : "Anchored · floor measured");
      updateUI({ quality: "Precision unverified" });
      return;
    }
    if (ui.phase !== "searching") return;
    if (
      !ui.ready ||
      !candidate ||
      Date.now() - lastHitTime > 250 ||
      tracking !== ViroTrackingStateConstants.TRACKING_NORMAL
    ) {
      invalid("Aim at the floor to reposition");
      return;
    }
    if (ui.mode === "baseline") await commitSingleHit(currentScene);
    else if (ui.mode === "surveyed") await commitSurveyed(currentScene);
    else await startCalibration(currentScene);
  },
  suspend() {
    diagnostics.record("sampling_suspended", debugSnapshot(), true);
    generation++;
    updateUI({ busy: false });
    if (uiStore.get().phase === "searching") invalid("Move slowly · tracking the room");
  },
};
