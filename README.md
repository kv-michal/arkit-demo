# Floor Frame

The [project state and intended behavior](PROJECT_STATE.md) is the core reference for both apps, the placement/orientation contract, the 20 m walking goal, and unresolved stability issues. This README covers native-app operation and build instructions.

Native iPhone AR app built with SwiftUI, RealityKit, and ARKit. Open `FloorFrame.xcodeproj` in Xcode, choose your signing team, select an ARKit-capable iPhone, and run. No third-party app dependencies.

## Use

1. Allow camera access and slowly scan a textured, well-lit floor.
2. Choose a placement mode (see below), then aim the crosshair in the clear camera area above the controls at a floor or incline. The mint block follows that screen point: the middle of its camera-facing bottom edge stays on the aimed surface point, and its footprint extends away from you. Its long edge faces the camera.
3. Choose **20 cm wide** (20 × 9 × 10 cm) or **3 m wide** (3 × 1.35 × 1.5 m).
4. Set **Rectangles** (1–51, default 11). The row contains the main rectangle and alternates left/right: the default adds five on each side. Count and width can change after anchoring.
5. **Occlusion** defaults off. Enable it on a LiDAR device to let real surfaces hide virtual rectangles; this keeps mesh reconstruction active even if the LiDAR mesh switch is off.
6. Tap **Anchor rectangle** to keep it at that position and orientation while you walk around it. Tap **Reposition** to resume the preview. Width can also change after anchoring.
7. **Reset scan** removes the placement and rebuilds tracking.

The block is rigid: it aligns to the local surface normal, rather than bending to cover uneven ground. Walls and inclines steeper than 60° are rejected. Anchors last for the current session; they are not saved between launches. The UI stays portrait while the rectangle itself is landscape on the floor.

## LiDAR

On supported devices, **LiDAR mesh** enables ARKit mesh reconstruction for surface raycasts, including slopes. Turning it off removes mesh reconstruction and resets the scan. Standard ARKit surface detection works on supported non-LiDAR iPhones; featureless surfaces and slopes may take longer or fail to detect. ARKit manages sensor fusion internally; this switch disables the mesh feature, not the LiDAR hardware. The switch is unavailable while anchored so a scan reset cannot silently remove the placement.

## Build

The Xcode project is checked in. To regenerate it after changing `project.yml`, install XcodeGen and run `xcodegen generate`.

```sh
xcodebuild -project FloorFrame.xcodeproj -scheme FloorFrame \
  -configuration Debug -destination 'generic/platform=iOS' \
  -derivedDataPath build -allowProvisioningUpdates build
```

Signing currently uses the local development team. Change `DEVELOPMENT_TEAM` in `project.yml` or in Xcode when using another account.

## Verification

Run `scripts/test-geometry.sh` on macOS. It checks flat-floor placement, viewer rotation, pitched surfaces, orthonormal transforms, and rejection of walls, overhead surfaces, distant hits, and undefined orientations.

The Debug build was signed and installed on the connected iPhone 16 Pro. Geometry checks passed. Argent successfully launched an initial build, but its on-device runner stalled during the final UI check; controls and live AR anchoring have not been verified through automation. Physical testing should cover both widths, each mesh mode, a sloped surface, and walking around an anchored rectangle. Camera permission must be granted on first launch.

## React Native comparison app

The Expo/Viro implementation is in [`floor-frame-viro/`](floor-frame-viro/README.md). It uses a separate bundle ID and can coexist with this app. Use Release configurations for both when comparing performance; see its README for stock-Viro API capabilities and renderer differences. The Viro app has no custom ARKit bridge or native module. Both apps now default to 11 rectangles (five on each side) and occlusion off, with matching count and occlusion controls.

The transparent block has 12 opaque red bounding-box edges to make floor penetration easier to see. Edge thickness is 3 mm for the 20 cm version and 3 cm for the 3 m version; the bottom of the outline matches the bottom of the block.

## Placement modes, calibration and hit markers (both apps)

Both apps implement the code-level parts of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) with the same modes, states, transforms, gates and diagnostic event names. The **mode picker** can change only before placement:

| Mode | What happens |
| --- | --- |
| **Single hit** | Original flow: one surface hit, then **Anchor rectangle**. The row is stored relative to the anchor that was actually created, so the first render cannot jump. |
| **Calibrate** | **Start calibration** creates the reference anchor and latches the origin and your facing direction. Sweep the target over the floor around and beside the row: a 5 × 5 grid of rays samples it 2.5 times per second. When the robust plane fit has enough spread-out evidence, **Anchor rectangle** commits the measured floor slope. **Cancel calibration** discards it. |
| **Height exp.** | Calibrate, then an **unadopted experiment**: one rate-limited, gated vertical offset for the whole row, estimated from floor rays near you. Every other mode logs this estimate without applying it. |
| **Survey** | Disabled until a validated survey manifest and printed board images are bundled (none ship). Surveyed floor-control points then define floor slope and origin height; the boards locate the survey frame. |

Yaw now comes from the latched plan-view direction toward you; the floor normal supplies inclination. Phone pitch/roll never tilts the row. States: searching → calibrating → ready → locked, plus *tracking limited* and *lost* (the reference anchor was removed; tap Reposition).

The status card shows the farthest rendered point and the proposed height-angle budget for the selected width/count, e.g. "Reach 16.5 m · height budget ±0.035°". This budget is a proposed target. Calibration quality is always labelled *precision unverified*: passing the research gates does not show absolute accuracy.

**Purple spheres** mark where hit tests landed: the current aim hit (plus the two adjacent depth samples in Viro), up to 200 recent calibration samples, and the latest locked surface-probe cycle. They are display-only, 1.2 cm (20 cm blocks) or 3 cm (3 m blocks), and are cleared on reset/reposition.

Shared fixtures in `Tests/fixtures/` (from `scripts/generate-fixtures.py`, an independent Python reference) feed both `scripts/test-fixtures.sh` (Swift) and `npm test` (TypeScript). They cover yaw/inclination, plane fit (pitched, compound, outliers, steps, source bias, collinear, stale epochs), budgets, height-correction gates and mode isolation, survey import, marker fusion, and actual-anchor transport.

## Native sinking diagnostics

The native app now matches Viro's **Mark sinking now** and **Debug logs** workflow. Recording starts automatically, continues while anchored, and survives scan resets within the current app process. When a row sinks, mark it, then open Debug logs to **Copy log**, **Share full log**, or **Refresh preview**. The share button opens the system share sheet with a JSONL text attachment; choose a destination there. Export before terminating the app.

Native captures include device/build information, requested and actual session/occlusion settings, tracking state and interruptions/errors, camera transforms/intrinsics, frame callback gaps, lighting and feature-point samples, plane geometry, mesh counts, placement decisions, sampled preview raycast hits, bound-anchor callbacks, initial/current/rendered transforms, pose deltas, bottom corner positions, geometry/settings changes, resets and lifecycle events. Snapshots run at 5 Hz and environment summaries at 1 Hz. Plane summaries are capped at 32 planes with 64 vertices each; feature samples are capped at 64. Every delivered update of the bound ARAnchor is recorded.

While anchored, up to four read-only ARKit raycasts per second probe the center, chain ends and nearest rectangle. Targets outside 0.1–8 m or a 60° forward cone are logged as skipped. Hits include their transforms, anchor IDs, target errors and signed normal clearance (negative means the estimated surface is above the block's underside). These are ARKit estimates, not independent ground truth or RealityKit's occlusion depth-buffer pixels. Probe results never reposition geometry or change renderer settings. Logging does not enable additional depth semantics or collect camera images.

The JSONL format matches Viro's event envelope and pinned-marker structure, with native-specific payloads. The native buffer retains up to 6 million UTF-8 bytes plus 100 pinned events / 500,000 bytes and reports eviction counts. Copy exports recent complete records up to 350,000 bytes and reports truncation; sharing exports the entire retained capture. Pinned events may duplicate chronological records; deduplicate by `seq`. The preview displays the last 12,000 characters. Captures stay in memory until process exit; sharing replaces a temporary local text file.

Run `scripts/test-diagnostics.sh` for buffer eviction, pinned-marker retention, JSON validity with nonfinite values, UTF-8 export limits, ordering and throttling checks. `scripts/test-geometry.sh` checks placement geometry. The native Release build and both test scripts passed on 2026-10-26; the build was installed on PotatoPhone. Automated on-device UI verification was blocked by the slow automation runner; live sinking/occlusion quality still requires moving the phone around a real surface.

## Aiming and size changes

Both implementations now keep the camera-facing bottom edge at the aimed surface point for both sizes, rather than centering the footprint on it. The 3 m block therefore extends 1.35 m away from the aimed edge instead of reaching 67.5 cm towards the viewer. Size changes while anchored retain that same edge/anchor. Rows still alternate left/right along the width axis.

The crosshair occupies the clear area between the header and controls. Native converts its measured window position into ARView coordinates before raycasting; Viro converts the matching layout point to physical pixels for screen-point hit tests. Diagnostics record the aim point and use the updated footprint for corner positions and surface probes. Geometry checks cover both sizes, slopes, even/odd rows and preservation of the aimed edge.

## Follow anchor updates

**Follow anchor updates** defaults on. Turn it off before placement or while anchored to keep the rendered world transform fixed and ignore subsequent anchor corrections. Tracking, anchor telemetry and surface diagnostics continue. Turn it back on to apply the latest known anchor transform; this can move the model immediately. Reposition/reset still clear the placement, and width/count changes preserve the frozen pose. This control does not disable camera tracking or prevent apparent motion caused by world-tracking drift or relocalization.
