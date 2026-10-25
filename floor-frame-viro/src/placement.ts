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
import { cross, surfacePose, type Pose, type Vec3 } from "./surfacePose";
import { depthNormal, followAnchor, transformMatrix } from "./viroGeometry";
import { diagnostics } from "./diagnostics";
import { chainGeometry, poseDelta, rectangleOffset, surfaceClearance, worldPoint } from "./diagnosticGeometry";

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
  large: false,
  rectangleCount: 11,
  occlusion: false,
  depth: true,
  locked: false,
  ready: false,
  busy: false,
  message: "Move your phone slowly to find the floor",
  detail: "Aim the center target at a floor or slope",
});
type UI = ReturnType<typeof uiStore.get>;
let scene: ViroARScene | null = null;
let navigator: ViroARSceneNavigator | null = null;
let tracking: number = ViroTrackingStateConstants.TRACKING_UNAVAILABLE;
let generation = 0;
let lastHitTime = 0;
let candidate: ViroARHitTestResult | null = null;
let anchorBinding: { id: string; initial: number[]; placed: Pose } | null =
  null;
const anchors = new Map<string, ViroAnchor>();
let trackingReason: number | undefined;
let cameraSample: { receivedMs: number; transform: ViroCameraTransform } | null = null;
let previousCameraMs: number | null = null;
let largestCameraGapMs = 0;
let cameraCallbacks = 0;
let lastProbeMs = -Infinity;
let lastCapabilitiesSession = -1;
let engineDiagnosticsInFlight = false;

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
function debugSnapshot() {
  const model = modelStore.get();
  return {
    generation, tracking, trackingReason, settings: settingsStore.get(), ui: uiStore.get(),
    model, candidate, camera: cameraSample,
    cameraAgeMs: cameraSample ? performance.now() - cameraSample.receivedMs : null,
    binding: anchorBinding,
    deltaFromPlacement: anchorBinding && model.pose ? poseDelta(anchorBinding.placed, model.pose) : null,
    chain: model.pose ? chainGeometry(model.pose, model.width, model.rectangleCount) : null,
    anchorCount: anchors.size,
    anchors: [...anchors.values()].slice(0, 64).map(anchorSummary),
  };
}

/** Diagnostic-only probes; never feed their results back into placement. */
async function probeLockedSurface(currentScene: ViroARScene, token: number) {
  const now = performance.now();
  if (now - lastProbeMs < 1000) return;
  lastProbeMs = now;
  const model = modelStore.get();
  const pose = model.pose;
  if (!pose) return;
  const startedMs = performance.now();
  try {
    const orientation = await currentScene.getCameraOrientationAsync();
    if (generation !== token || scene !== currentScene || !uiStore.get().locked) return;
    const camera = orientation.position as Vec3;
    const geometry = chainGeometry(pose, model.width, model.rectangleCount);
    const centers = Array.from({ length: model.rectangleCount }, (_, i) => ({
      index: i, world: worldPoint(pose.matrix, [rectangleOffset(i, model.width), 0.001, 0]),
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
      const hits: ViroARHitTestResult[] = await currentScene.performARHitTestWithRay(unitRay);
      if (generation !== token || scene !== currentScene || !uiStore.get().locked) return;
      diagnostics.record("locked_surface_probe", {
        target, camera, unitRay, durationMs: performance.now() - queryStartedMs,
        poseAtQuery: pose, poseAtCompletion: modelStore.get().pose,
        settings: settingsStore.get(), hitCount: hits.length,
        hits: hits.slice(0, 32).map(hit => ({ ...hit,
          clearance: hit.type === "FeaturePoint" ? null : surfaceClearance(pose, hit.transform.position),
          targetMissM: Math.hypot(...hit.transform.position.map((v, i) => v - target.world[i])),
        })),
      });
    }));
    diagnostics.record("locked_probe_cycle", {
      durationMs: performance.now() - startedMs, camera: orientation, geometry, nearestRectangle: nearest,
      staleGeneration: generation !== token,
      failures: results.flatMap((result, index) => result.status === "rejected" ? [{ target: targets[index], error: result.reason }] : []),
    });
  } catch (error) {
    if (generation === token) diagnostics.record("surface_probe_error", { error, durationMs: performance.now() - startedMs });
  }
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
function invalid(message: string) {
  if (uiStore.get().message !== message) diagnostics.record("preview_invalid", { message, candidate, pose: modelStore.get().pose });
  lastHitTime = 0;
  candidate = null;
  showPose(null);
  updateUI({
    ready: false,
    message,
    detail: "Aim the center target at a floor or slope",
  });
}
function closestSurface(
  hits: ViroARHitTestResult[],
  camera: Vec3,
  depth: boolean,
) {
  return hits
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
function resetPlacement() {
  diagnostics.record("placement_reset", debugSnapshot(), true);
  generation++;
  anchorBinding = null;
  anchors.clear();
  lastProbeMs = -Infinity;
  updateUI({ locked: false, busy: false });
  invalid("Scan the floor again");
}
export const placement = {
  debugSnapshot,
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
    if (state !== tracking || reason !== trackingReason) diagnostics.record("tracking_changed", { previousState: tracking, state, reason, locked: uiStore.get().locked }, true);
    trackingReason = reason;
    tracking = state;
    if (state !== ViroTrackingStateConstants.TRACKING_NORMAL) {
      generation++;
      updateUI({ busy: false });
      if (!uiStore.get().locked) invalid("Move slowly · tracking the room");
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
        camera: transform, generation, tracking, trackingReason, settings: settingsStore.get(),
        pose: model.pose, bindingId: anchorBinding?.id,
        deltaFromPlacement: anchorBinding && model.pose ? poseDelta(anchorBinding.placed, model.pose) : null,
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
    if (anchorBinding?.id === anchor.anchorId) {
      const before = modelStore.get().pose;
      showPose(
        followAnchor(
          anchorBinding.initial,
          transformMatrix(anchor.position, anchor.rotation),
          anchorBinding.placed,
        ),
      );
      diagnostics.record("bound_anchor_updated", {
        anchor: anchorSummary(anchor), previous: previous ? anchorSummary(previous) : null,
        initialMatrix: anchorBinding.initial, placedPose: anchorBinding.placed,
        renderedBefore: before, renderedAfter: modelStore.get().pose,
        deltaFromPlacement: modelStore.get().pose ? poseDelta(anchorBinding.placed, modelStore.get().pose!) : null,
      });
    } else if (!previous || diagnostics.due(`anchor:${anchor.anchorId}`, 1000)) {
      diagnostics.record("surface_anchor_updated", { anchor: anchorSummary(anchor), previous: previous ? anchorSummary(previous) : null });
    }
  },
  anchorRemoved(anchor?: ViroAnchor) {
    diagnostics.record("anchor_removed", { anchor: anchor ? anchorSummary(anchor) : null, bound: anchor?.anchorId === anchorBinding?.id }, true);
    if (!anchor) return;
    anchors.delete(anchor.anchorId);
    if (anchorBinding?.id === anchor.anchorId) {
      anchorBinding = null;
      updateUI({ locked: false });
      invalid("Anchor lost · aim at the floor again");
    }
  },
  async sample() {
    const currentScene = scene;
    const ui = uiStore.get();
    if (
      !currentScene ||
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
    const sampleStartedMs = performance.now();
    const recordPreview = diagnostics.due("preview", 200);
    try {
      const orientation = await currentScene.getCameraOrientationAsync();
      const camera = orientation.position as Vec3;
      const forward = orientation.forward as Vec3;
      const hits: ViroARHitTestResult[] =
        await currentScene.performARHitTestWithRay(forward);
      const hit = closestSurface(
        hits,
        camera,
        settings.depth || settings.occlusion,
      );
      if (token !== generation) return;
      if (recordPreview) diagnostics.record("preview_hits", { camera: orientation, settings, hits: hits.slice(0, 32), hitCount: hits.length, selected: hit, durationMs: performance.now() - sampleStartedMs });
      if (!hit) {
        invalid("Aim at a textured floor and move slowly");
        return;
      }
      const matrix = transformMatrix(
        hit.transform.position,
        hit.transform.rotation,
      );
      let normal: Vec3 | null = matrix.slice(4, 7) as Vec3;
      if (hit.type === "DepthPoint") {
        // A depth point alone does not establish a surface orientation.
        const up = orientation.up as Vec3;
        const right = cross(forward, up);
        const ray = (offset: Vec3): Vec3 =>
          forward.map((v, i) => v + offset[i] * 0.015) as Vec3;
        const [rightHits, upHits]: ViroARHitTestResult[][] = await Promise.all([
          currentScene.performARHitTestWithRay(ray(right)),
          currentScene.performARHitTestWithRay(ray(up)),
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
        normal =
          rightHit && upHit
            ? depthNormal(
                hit.transform.position,
                rightHit.transform.position,
                upHit.transform.position,
              )
            : null;
        if (recordPreview) diagnostics.record("depth_normal_samples", { center: hit, right: rightHit, up: upHit, rightHits: rightHits.slice(0, 16), upHits: upHits.slice(0, 16), normal, rayOffset: 0.015 });
      }
      if (token !== generation) return;
      const pose =
        normal && surfacePose(hit.transform.position, normal, camera);
      if (!pose) {
        invalid("Point down at a floor or slope");
        return;
      }
      lastHitTime = Date.now();
      // Prefer a nearby plane result for Viro anchor creation. Synthetic depth
      // hits may not support createAnchoredNode on every backend.
      candidate =
        hit.type === "DepthPoint"
          ? (hits.find(
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
      updateUI({
        ready: true,
        message: "Ready to anchor",
        detail: `${pose.distance.toFixed(1)} m away · ${pose.slope.toFixed(0)}° slope`,
      });
    } catch (error) {
      if (diagnostics.due("sample_error", 1000)) diagnostics.record("sample_error", { error, staleGeneration: token !== generation, durationMs: performance.now() - sampleStartedMs });
      if (token !== generation) return;
      invalid("AR hit test unavailable");
      updateUI({ detail: String(error) });
    }
  },
  setWidth(large: boolean) {
    diagnostics.record("width_changed", { large, previousWidth: modelStore.get().width, width: large ? 3 : 0.2 }, true);
    updateUI({ large });
    modelStore.set({ ...modelStore.get(), width: large ? 3 : 0.2 });
  },
  setRectangleCount(rectangleCount: number) {
    const count = Math.min(51, Math.max(1, Math.round(rectangleCount)));
    diagnostics.record("rectangle_count_changed", { previousCount: modelStore.get().rectangleCount, count }, true);
    updateUI({ rectangleCount: count });
    modelStore.set({ ...modelStore.get(), rectangleCount: count });
  },
  setOcclusion(occlusion: boolean) {
    if (uiStore.get().busy) return;
    diagnostics.record("occlusion_changed", { previous: settingsStore.get().occlusion, occlusion, locked: uiStore.get().locked }, true);
    generation++;
    settingsStore.set({ ...settingsStore.get(), occlusion });
    updateUI({ occlusion });
    if (!uiStore.get().locked) invalid("Aim at the floor to reposition");
  },
  configure(depth: boolean) {
    diagnostics.record("session_reset_requested", { depth, settings: settingsStore.get() }, true);
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
  async anchorOrReposition() {
    const currentScene = scene;
    const ui = uiStore.get();
    diagnostics.record("placement_requested", { ...debugSnapshot(), hitAgeMs: Date.now() - lastHitTime }, true);
    if (ui.busy || !currentScene) return;
    if (ui.locked) {
      // Viro has no public remove-single-anchor API. Clear anchors without resetting tracking.
      navigator?.sceneNavigator.resetARSession(false, true);
      diagnostics.record("unanchor_requested", { id: anchorBinding?.id }, true);
      resetPlacement();
      return;
    }
    if (
      !ui.ready ||
      !candidate ||
      Date.now() - lastHitTime > 250 ||
      tracking !== ViroTrackingStateConstants.TRACKING_NORMAL
    ) {
      invalid("Aim at the floor to reposition");
      return;
    }
    const hit = candidate,
      pose = modelStore.get().pose;
    if (!pose) return;
    const token = ++generation;
    updateUI({ busy: true });
    try {
      const node = await currentScene.createAnchoredNode(hit);
      diagnostics.record("anchor_creation_result", { node, hit, pose, staleGeneration: token !== generation }, true);
      if (token !== generation) return;
      if (!node?.anchorId) {
        updateUI({
          message: "Viro could not create an anchor",
          detail: "Aim at a detected plane and try again",
        });
        return;
      }
      anchorBinding = {
        id: node.anchorId,
        initial: transformMatrix(
          hit.transform.position,
          hit.transform.rotation,
        ),
        placed: pose,
      };
      diagnostics.record("placement_anchored", { binding: anchorBinding, model: modelStore.get(), settings: settingsStore.get() }, true);
      updateUI({
        locked: true,
        message: "Anchored in place",
        detail: "Walk around it · tap Reposition to move it",
      });
      const latest = anchors.get(node.anchorId);
      if (latest) placement.anchorUpdated(latest);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      diagnostics.record("anchor_creation_error", { error, staleGeneration: token !== generation }, true);
      if (token === generation)
        updateUI({ message: "Could not anchor", detail: String(error) });
    } finally {
      if (token === generation) updateUI({ busy: false });
    }
  },
  suspend() {
    diagnostics.record("sampling_suspended", debugSnapshot(), true);
    generation++;
    updateUI({ busy: false });
    if (!uiStore.get().locked) invalid("Move slowly · tracking the room");
  },
};
