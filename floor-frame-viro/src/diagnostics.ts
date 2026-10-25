import { Platform } from "react-native";
import { DiagnosticLog } from "./diagnosticLog";
import packageInfo from "../package.json";

export const diagnostics = new DiagnosticLog();
diagnostics.record("app_start", {
  platform: Platform.OS, osVersion: Platform.Version, platformConstants: Platform.constants,
  appVersion: packageInfo.version, viroVersion: packageInfo.dependencies["@reactvision/react-viro"],
  expoVersion: packageInfo.dependencies.expo, development: __DEV__,
  renderer: "Viro", previewHz: 20, lockedSnapshotHz: 5, surfaceProbeHz: 1,
  limits: "6 million characters plus up to 100 pinned events / 500,000 pinned characters; oldest records evicted with count",
  unavailable: ["raw depth images", "occlusion depth-buffer pixels", "native ARKit/ARCore internals not exposed by Viro"],
}, true);
