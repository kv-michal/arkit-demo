import * as Haptics from "expo-haptics";
import {
  ViroTrackingStateConstants,
  type ViroARScene,
  type ViroARSceneNavigator,
  type ViroARHitTestResult,
  type ViroAnchor,
} from "@reactvision/react-viro";
import { createStore } from "./store";
import { cross, surfacePose, type Pose, type Vec3 } from "./surfacePose";
import { depthNormal, followAnchor, transformMatrix } from "./viroGeometry";

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
  generation++;
  anchorBinding = null;
  anchors.clear();
  updateUI({ locked: false, busy: false });
  invalid("Scan the floor again");
}
export const placement = {
  attachScene(value: ViroARScene | null) {
    if (scene !== value) generation++;
    scene = value;
  },
  attachNavigator(value: ViroARSceneNavigator | null) {
    navigator = value;
  },
  trackingUpdated(state: number) {
    tracking = state;
    if (state !== ViroTrackingStateConstants.TRACKING_NORMAL) {
      generation++;
      updateUI({ busy: false });
      if (!uiStore.get().locked) invalid("Move slowly · tracking the room");
    }
  },
  anchorUpdated(anchor: ViroAnchor) {
    anchors.set(anchor.anchorId, anchor);
    if (anchorBinding?.id === anchor.anchorId) {
      showPose(
        followAnchor(
          anchorBinding.initial,
          transformMatrix(anchor.position, anchor.rotation),
          anchorBinding.placed,
        ),
      );
    }
  },
  anchorRemoved(anchor?: ViroAnchor) {
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
      ui.locked ||
      tracking !== ViroTrackingStateConstants.TRACKING_NORMAL
    )
      return;
    const token = generation;
    const settings = settingsStore.get();
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
      updateUI({
        ready: true,
        message: "Ready to anchor",
        detail: `${pose.distance.toFixed(1)} m away · ${pose.slope.toFixed(0)}° slope`,
      });
    } catch (error) {
      if (token !== generation) return;
      invalid("AR hit test unavailable");
      updateUI({ detail: String(error) });
    }
  },
  setWidth(large: boolean) {
    updateUI({ large });
    modelStore.set({ ...modelStore.get(), width: large ? 3 : 0.2 });
  },
  setRectangleCount(rectangleCount: number) {
    const count = Math.min(51, Math.max(1, Math.round(rectangleCount)));
    updateUI({ rectangleCount: count });
    modelStore.set({ ...modelStore.get(), rectangleCount: count });
  },
  setOcclusion(occlusion: boolean) {
    if (uiStore.get().busy) return;
    generation++;
    settingsStore.set({ ...settingsStore.get(), occlusion });
    updateUI({ occlusion });
    if (!uiStore.get().locked) invalid("Aim at the floor to reposition");
  },
  configure(depth: boolean) {
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
    if (ui.busy || !currentScene) return;
    if (ui.locked) {
      // Viro has no public remove-single-anchor API. Clear anchors without resetting tracking.
      navigator?.sceneNavigator.resetARSession(false, true);
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
      updateUI({
        locked: true,
        message: "Anchored in place",
        detail: "Walk around it · tap Reposition to move it",
      });
      const latest = anchors.get(node.anchorId);
      if (latest) placement.anchorUpdated(latest);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      if (token === generation)
        updateUI({ message: "Could not anchor", detail: String(error) });
    } finally {
      if (token === generation) updateUI({ busy: false });
    }
  },
  suspend() {
    generation++;
    updateUI({ busy: false });
    if (!uiStore.get().locked) invalid("Move slowly · tracking the room");
  },
};
