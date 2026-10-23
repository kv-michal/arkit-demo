# Floor Frame — stock Viro comparison

Expo 57 / React Native 0.86 / **@reactvision/react-viro 3.0.3**, installed as **Floor Frame Viro** (`cz.koval.floorframe.viro`) alongside native **Floor Frame**.

**No custom native module, ARKit bridge, library patch, or secondary AR session.** Viro owns the camera, session, hit tests, anchors, depth, mesh and occlusion. React Native draws the controls; TypeScript handles placement geometry.

## Kept behavior

- Portrait camera, center target, status, reset, anchor/reposition, width selector.
- 20 × 9 × 10 cm or 3 × 1.35 × 1.5 m transparent mint blocks, rounded corners and opaque red bounding edges.
- 1–51 rectangles, default **11**: center plus five on each side. Count and width can change after anchoring.
- Viewer-facing wide edge, local surface alignment, 60° slope limit, below-camera and 8 m range checks.
- **Occlusion off by default**, controlled by Viro's `occlusionMode="depthBased"` when enabled.
- **Viro depth + mesh** on by default, using `depthEnabled` and `worldMeshEnabled`. The mode cannot change while anchored. Turning it off resets the scan; occlusion can still use depth independently.

## How the stock APIs are used

`ViroARScene.performARHitTestWithRay` samples the camera-forward ray at up to 20 Hz, without overlapping requests. Feature points are rejected because they do not establish a surface normal. Plane-hit rotations supply their surface orientation. For depth hits, two adjacent ray tests estimate a local normal; missing, coincident or widely separated samples are rejected. The result is less direct than native ARKit's mesh-backed estimated-plane raycast and can be noisier at edges or on uneven ground.

`createAnchoredNode(hit)` creates a Viro-managed anchor. The returned anchor ID and scene `onAnchorFound` / `onAnchorUpdated` callbacks update the rendered world-space node while preserving its viewer-facing orientation. Viro 3.0.3 does not expose a React `ViroARNode` attachment component, so rendering follows those callbacks in JavaScript rather than attaching directly inside the renderer. If Viro returns no anchor ID, the UI reports failure; it does not pretend a frozen preview is an anchor.

Viro has no public remove-single-anchor API. Reposition uses its `resetARSession(false, true)` to clear anchors while keeping tracking. Reset and depth-mode changes recreate the navigator/session.

## Capability differences from native

| Feature | Stock Viro | Native Swift |
| --- | --- | --- |
| Floor placement | Viro plane/depth hit tests | ARKit estimated-plane raycast |
| Slopes | Normal estimated from adjacent depth hits; requires usable depth data | ARKit surface normal |
| Anchor rendering | Anchor creation + callbacks driving a world-space node | Direct RealityKit anchor entity |
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

## Verification

```sh
npm run typecheck
npm test
npx react-doctor@latest --verbose --diff
```

Tests cover native-equivalent placement geometry, Viro Euler conversions, anchor transform updates, depth-normal estimation and rejection of depth discontinuities. Build/install checks do not prove live tracking, anchor stability, sloped-surface quality, or occlusion. Check those on an unlocked phone aimed at a textured, well-lit floor, including a deliberate incline and an intervening real object. Use the same sizes/counts/settings and Release builds in both apps. No performance winner or measured FPS is asserted.

Validated 2026-10-23: TypeScript and all 11 geometry tests passed; React Doctor 100/100; Release build installed and launched on PotatoPhone (iPhone 16 Pro). Verified removal from pod registration, generated Expo provider and JS bundle. Live AR behavior of this bridge-free implementation remains unverified.
