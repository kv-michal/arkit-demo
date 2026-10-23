import * as Haptics from "expo-haptics";
import Session from "../modules/floor-frame-session";
import { createStore } from "./store";
import { Pose, poseFromMatrix, surfacePose, Vec3 } from "./surfacePose";

export const occlusionStore = createStore(false);
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
  lidar: Session.supportsLiDAR,
  locked: false,
  ready: false,
  busy: false,
  message: "Move your phone slowly to find the floor",
  detail: "Aim the center target at a floor or slope",
});
type UI = ReturnType<typeof uiStore.get>;
let generation = 0;
let lastHitTime = 0;
function updateUI(change: Partial<UI>) {
  const current = uiStore.get();
  if (
    Object.entries(change).some(
      ([key, value]) => current[key as keyof UI] !== value,
    )
  )
    uiStore.set({ ...current, ...change });
}
// Keep React/Viro idle when an invalid preview or anchored pose is unchanged.
function showPose(pose: Pose | null) {
  const current = modelStore.get();
  if (current.pose === pose) return;
  if (
    pose &&
    current.pose &&
    pose.matrix.every((value, index) => value === current.pose!.matrix[index])
  )
    return;
  modelStore.set({ ...current, pose });
}
function invalid(message: string) {
  lastHitTime = 0;
  showPose(null);
  updateUI({
    ready: false,
    message,
    detail: "Aim the center target at a floor or slope",
  });
}
export const placement = {
  async sample() {
    const token = generation;
    if (uiStore.get().busy) return;
    try {
      const sample = await Session.sample();
      if (token !== generation || uiStore.get().busy) return;
      if (uiStore.get().locked) {
        if (sample.status === "anchored" && sample.matrix)
          showPose(poseFromMatrix(sample.matrix));
        return;
      }
      if (sample.status !== "hit" || !sample.matrix || !sample.camera) {
        invalid(
          sample.status === "tracking"
            ? "Move slowly · tracking the room"
            : "Aim at a textured floor and move slowly",
        );
        return;
      }
      const m = sample.matrix;
      const pose = surfacePose(
        m.slice(12, 15) as Vec3,
        m.slice(4, 7) as Vec3,
        sample.camera,
      );
      if (!pose) {
        invalid("Point down at a floor or slope");
        return;
      }
      lastHitTime = Date.now();
      showPose(pose);
      updateUI({
        ready: true,
        message: "Ready to anchor",
        detail: `${pose.distance.toFixed(1)} m away · ${pose.slope.toFixed(0)}° slope`,
      });
    } catch (error) {
      invalid("AR session stopped");
      updateUI({
        detail: error instanceof Error ? error.message : String(error),
      });
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
  async setOcclusion(occlusion: boolean) {
    const ui = uiStore.get();
    if (ui.busy || !Session.supportsLiDAR) return;
    generation++;
    updateUI({ busy: true });
    try {
      await Session.configure(ui.lidar, false, occlusion);
      occlusionStore.set(occlusion);
      updateUI({ occlusion });
    } catch (error) {
      updateUI({
        message: "Could not change occlusion",
        detail: String(error),
      });
    } finally {
      updateUI({ busy: false });
    }
  },
  async configure(lidar: boolean) {
    if (uiStore.get().busy) return;
    generation++;
    lastHitTime = 0;
    updateUI({
      busy: true,
      lidar,
      locked: false,
      ready: false,
      message: "Scan the floor again",
    });
    showPose(null);
    try {
      await Session.configure(lidar, true, uiStore.get().occlusion);
    } catch (error) {
      updateUI({ message: "AR session stopped", detail: String(error) });
    } finally {
      updateUI({ busy: false });
    }
  },
  async anchorOrReposition() {
    const ui = uiStore.get();
    if (ui.busy) return;
    if (!ui.locked && (!ui.ready || Date.now() - lastHitTime > 250)) {
      invalid("Aim at the floor to reposition");
      return;
    }
    const pose = modelStore.get().pose;
    generation++;
    updateUI({ busy: true });
    try {
      if (ui.locked) {
        await Session.unanchor();
        updateUI({ locked: false });
        invalid("Aim at the floor to reposition");
      } else if (pose && (await Session.anchor(pose.matrix))) {
        updateUI({
          locked: true,
          message: "Anchored in place",
          detail: "Walk around it · tap Reposition to move it",
        });
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else {
        invalid("Move slowly · tracking the room");
      }
    } catch (error) {
      updateUI({ message: "Could not anchor", detail: String(error) });
    } finally {
      updateUI({ busy: false });
    }
  },
  suspend() {
    generation++;
    if (!uiStore.get().locked) invalid("Move slowly · tracking the room");
  },
};
