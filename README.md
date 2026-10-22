# Floor Frame

Native iPhone AR app built with SwiftUI, RealityKit, and ARKit. Open `FloorFrame.xcodeproj` in Xcode, choose your signing team, select an ARKit-capable iPhone, and run. No third-party app dependencies.

## Use

1. Allow camera access and slowly scan a textured, well-lit floor.
2. Aim the center crosshair at a floor or incline. The mint rectangular block follows the surface and its long edge faces the camera.
3. Choose **20 cm wide** (20 × 9 × 10 cm) or **3 m wide** (3 × 1.35 × 1.5 m).
4. Tap **Anchor rectangle** to keep it at that position and orientation while you walk around it. Tap **Reposition** to resume the preview. Width can also change after anchoring.
5. **Reset scan** removes the placement and rebuilds tracking.

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

The Expo/Viro implementation is in [`floor-frame-viro/`](floor-frame-viro/README.md). It uses a separate bundle ID and can coexist with this app. Use Release configurations for both when comparing performance; see its README for parity details, renderer differences and a repeatable comparison procedure.

The transparent block has 12 opaque red bounding-box edges to make floor penetration easier to see. Edge thickness is 3 mm for the 20 cm version and 3 cm for the 3 m version; the bottom of the outline matches the bottom of the block.
