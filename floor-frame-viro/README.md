# Floor Frame — stock Viro comparison

Read the [project state and intended behavior](../PROJECT_STATE.md) for the authoritative comparison of both apps, the yaw/floor-inclination contract, the 20 m walking goal, and current stability/verification gaps. This README provides Viro-specific operation and build details.

Expo 57 / React Native 0.86 / **@reactvision/react-viro 3.0.3**, installed as **Floor Frame Viro** (`cz.koval.floorframe.viro`) alongside native **Floor Frame**.

**No custom native module, ARKit bridge, library patch, or secondary AR session.** Viro owns the camera, session, hit tests, anchors, depth, mesh and occlusion. React Native draws the controls; TypeScript handles placement geometry.

## Kept behavior

- Placement modes, calibration flow and purple hit-result spheres shared with native (see the end of this file).
- Portrait camera, visible aiming target above the controls, status, reset, anchor/reposition, width selector.
- 20 × 9 × 10 cm or 3 × 1.35 × 1.5 m transparent mint blocks, rounded corners and opaque red bounding edges.
- 1–51 rectangles, default **11**: center plus five on each side. Count and width can change after anchoring.
- Viewer-facing wide edge, local surface alignment, 60° slope limit, below-camera and 8 m range checks.
- **Occlusion off by default**, controlled by Viro's `occlusionMode="depthBased"` when enabled.
- **Viro depth + mesh** on by default, using `depthEnabled` and `worldMeshEnabled`. The mode cannot change while anchored. Turning it off resets the scan; occlusion can still use depth independently.

## How the stock APIs are used

`ViroARScene.performARHitTestWithPoint` samples the visible crosshair at up to 20 Hz, without overlapping requests. The crosshair is centred in the free area between the header and controls; its measured layout coordinates are converted to physical pixels for Viro screen hit tests. Feature points are rejected because they do not establish a surface normal. Plane-hit rotations supply their surface orientation. For depth hits, two adjacent screen-point tests estimate a local normal; missing, coincident or widely separated samples are rejected. The result is less direct than native ARKit's mesh-backed estimated-plane raycast and can be noisier at edges or on uneven ground.

`createAnchoredNode(hit)` creates a Viro-managed anchor. The returned anchor ID and scene `onAnchorFound` / `onAnchorUpdated` callbacks update the rendered world-space node while preserving its viewer-facing orientation. Viro 3.0.3 does not expose a React `ViroARNode` attachment component, so rendering follows those callbacks in JavaScript rather than attaching directly inside the renderer. If Viro returns no anchor ID, the UI reports failure; it does not pretend a frozen preview is an anchor.

Viro has no public remove-single-anchor API. Reposition uses its `resetARSession(false, true)` to clear anchors while keeping tracking. Reset and depth-mode changes recreate the navigator/session.

## Capability differences from native

| Feature | Stock Viro | Native Swift |
| --- | --- | --- |
| Floor placement | Viro plane/depth hit tests | ARKit estimated-plane raycast |
| Slopes | Normal estimated from adjacent depth hits; requires usable depth data | ARKit surface normal |
| Anchor rendering | Anchor callbacks driving a world-space node; optional freeze | ARAnchor callbacks driving a RealityKit world anchor; optional freeze |
| Depth control | Viro depth + world mesh; LiDAR where available, monocular fallback | LiDAR mesh reconstruction configuration |
| Occlusion | Viro depth-based | RealityKit mesh-based |
| Remove placement | Clear Viro session anchors | Remove the individual ARAnchor |

Viro exposes no LiDAR-only capability query or exact ARKit scene-reconstruction switch. The UI therefore labels its mode **Viro depth + mesh**, without claiming that it switches LiDAR hardware or exactly matches native configuration. Occlusion also works through Viro's monocular fallback on non-LiDAR devices. These engine/API differences are part of the comparison, not hidden behind native code.

References: [ViroARScene](https://viro-community.readme.io/docs/viroarscene), [ViroARSceneNavigator](https://viro-community.readme.io/docs/viroarscenenavigator). The installed 3.0.3 TypeScript wrappers and native implementation are the source of truth for anchor creation and callback behavior.

## Build and install

```sh
npm ci
npm run prebuild
cd ios && pod install && cd ..
npm run ios:release
```

`ios/` is generated. No Expo Go: Viro itself requires a native build. The app uses Expo 57's supported `expo-build-properties` `ios.enableSceneSupport` for the iOS 27 lifecycle. Local native-module sources have been removed; run `pod install` after updating an existing checkout to remove their old pod registration.

From the parent folder, `scripts/install-comparison.sh IPHONE_UDID` builds and installs both Release apps.

## Sinking diagnostics (iOS and Android)

Diagnostics start automatically with the app and continue after anchoring. Keep the same depth/occlusion settings when reproducing the issue. Tap **Mark sinking now** when the chain intersects the floor, then **Debug logs → Copy log** or **Share full log**. Sharing opens the system share sheet with a JSONL text attachment; it sends nothing automatically. Copy uses the clipboard on both platforms and includes recent complete records up to 350,000 characters to avoid Android clipboard transaction limits. Its status and export header say when it is truncated; sharing includes the entire buffered capture.

The capture includes device/OS/build versions, actual committed renderer settings, tracking states/reasons, camera transforms and callback gaps, ambient lighting, feature counts/samples, depth readiness/capability/preference, world-mesh statistics, plane/anchor geometry, every bound-anchor correction, initial placement versus current pose, chain-end/corner heights, raw hit types/confidences/depth sources, the three samples used for depth-normal estimation, placement decisions/errors, resets, lifecycle events and user markers. Camera/preview snapshots run at 5 Hz; lighting/feature/mesh summaries at 1 Hz. Bound-anchor corrections are recorded for every delivered callback. Point samples and plane vertices are capped at 64 per event, and raw hit lists at 32 (16 for adjacent depth rays).

While anchored, up to four extra diagnostic rays per second target the center, both chain ends and the nearest rectangle. Targets outside 0.1–8 m or a 60° forward cone are logged as skipped; no hit is a valid result. Signed normal clearance is negative when the estimated surface is above the block's bottom plane. These are Viro surface estimates, **not independent ground truth or the exact occlusion depth buffer**. Diagnostics never use those probe results to reposition geometry or change depth/occlusion settings. Raw depth images, native ARKit/ARCore internals and renderer FPS are not exposed by this capture; callback gaps measure JS arrival timing only.

The in-memory buffer retains up to 6 million characters, plus at most 100 pinned events / 500,000 pinned characters; oldest records are evicted with counts in the header. Pinned events can duplicate stream records (deduplicate by `seq`). Export before terminating the app. No camera images or videos are collected. The cache attachment is replaced on each share.

New clipboard/file/sharing modules require a **native rebuild** on both platforms. iOS: `npm run ios:release`. Android: `npm run android:release` on an ARCore-capable device with the Android SDK configured. Android has been enabled in Expo config with package `cz.koval.floorframe.viro`; live device behavior and native compilation must still be verified on each platform.

## Verification

```sh
npm run typecheck
npm test
npx react-doctor@latest --verbose --diff
```

Tests cover native-equivalent placement geometry, Viro Euler conversions, anchor transform updates, depth-normal estimation and rejection of depth discontinuities. Build/install checks do not prove live tracking, anchor stability, sloped-surface quality, or occlusion. Check those on an unlocked phone aimed at a textured, well-lit floor, including a deliberate incline and an intervening real object. Use the same sizes/counts/settings and Release builds in both apps. No performance winner or measured FPS is asserted.

Validated 2026-10-23: TypeScript and all 11 geometry tests passed; React Doctor 100/100; Release build installed and launched on PotatoPhone (iPhone 16 Pro). Verified removal from pod registration, generated Expo provider and JS bundle. Live AR behavior of this bridge-free implementation remains unverified.

## Placement origin

The middle of the camera-facing bottom edge stays at the aimed surface point in both widths. The footprint extends away from you: the 3 m block occupies local Z from −1.35 m to 0 instead of −0.675 m to +0.675 m. Changing width while anchored preserves this edge and the anchor. Preview and anchored geometry share the same offset; the diagnostic corners and surface probes match the rendered footprint. Tests cover target layout/pixel conversion, both widths, slopes, even/odd rows and preservation of the edge after anchor updates.

## Follow anchor updates

**Follow anchor updates** defaults on. Turn it off before placement or while anchored to keep the rendered world transform fixed and ignore subsequent anchor corrections. Tracking, anchor telemetry and surface diagnostics continue. Turn it back on to apply the latest known anchor transform; this can move the model immediately. Reposition/reset still clear the placement, and width/count changes preserve the frozen pose. This control does not disable camera tracking or prevent apparent motion caused by world-tracking drift or relocalization.

## Placement modes, calibration and hit markers

Same modes, states and purple hit spheres as the native app; see the [root README](../README.md#placement-modes-calibration-and-hit-markers). Viro-specific details:

- **Actual-anchor baseline:** `createAnchoredNode` returns the created anchor's transform (on iOS its rotation is a quaternion `[x, y, z, w]`). The app converts it and stores the row as `inverse(anchor) * placedPose`. The hit transform, returned anchor transform and first matching anchor callback are logged as `anchor_baseline` / `anchor_baseline_callback`. If no transform is returned (Android: unverified), the first callback or, failing that, the hit is used and its source is logged.
- **Calibration sampling** uses 25 `performARHitTestWithPoint` calls per batch across the aim area. It drops to a 3 × 3 grid if a batch takes over 300 ms. Viro exposes no capture timestamps for hit tests, so samples carry JS receipt time only. That timing is weaker than native frame timestamps.
- **Survey boards** use a narrowly typed `ViroARImageMarker` adapter, whose removal callback binds the survey id in a closure. The navigator sets `numberOfTrackedImages` to 2 only when a survey is bundled, never changing it at runtime. Add a manifest in `src/survey/bundledSurvey.ts`.
