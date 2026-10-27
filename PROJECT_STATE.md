# Floor Frame: project state and intended behavior

Updated: **2026-10-27**. Implementation inspected at commit **8f450ba**; installed Viro 3.0.3 anchor-creation source inspected 2026-10-26 and image-tracking configuration inspected 2026-10-27.

This is the core reference for the project's goal, current implementation, reasons for the implementation, verification limits, and unresolved problems. The root README and Viro README provide build/use instructions and historical results. Read this document before changing placement, orientation, anchoring, occlusion, diagnostics, or comparing the two apps.

## 1. Product goal: place once, then walk along the rectangles

The user stands in front of one main rectangle and places it on the floor. Additional rectangles continue along its long edge. The user then walks sideways from the original viewing position, along that rectangle direction, to subsequent rectangles, potentially **20 metres from the original placement**.

Required orientation inputs:

- **User supplies yaw only:** the main rectangle's long edge is across the user, perpendicular (90 degrees) to the user's initial viewing direction. The row continues along that long edge.
- **Floor supplies pitch/tilt:** the rectangle follows the floor's inclination at placement. The user's phone pitch or roll must not independently tilt the model. Pointing the phone down selects a floor location; it is not an instruction to lean the rectangle.
- **The floor is always potentially pitched:** measure its real inclination in one calibration flow. Gravity establishes the vertical reference, not an assumed horizontal floor. A separate level-ground mode or zero-pitch fallback is not part of the required solution; insufficient inclination evidence means calibration is not ready.
- **Placement is committed once:** after anchoring, moving or turning the user/phone must not make the row face the user again, select a new placement, or intentionally change its chosen floor inclination.
- **The whole row remains rigid:** rectangles preserve their dimensions, spacing and orientation relative to each other. The desired result remains registered to the physical environment while the user walks along it.
- **Occlusion remains usable:** the user must be able to see genuine floor intersections with occlusion enabled. Disabling occlusion or adding an arbitrary fixed lift to hide penetration is not an accepted solution to stability. A measured, signed root-height correction is a separate unadopted experiment, not an allowed exception by default: its change to post-commit placement behavior and terrain ambiguity require an explicit product decision and validation.

Terminology and axes:

| Term | Meaning |
| --- | --- |
| Local X | Main rectangle's wide/long axis; continuation and walking direction of the row. |
| Local Y | Up from the rectangle's base; currently the estimated floor normal. |
| Local Z | Rectangle's short/depth axis; initially points approximately toward the user along the floor. |
| Initial viewing direction | User-to-placement direction used for initial yaw; not a direction to keep following after placement. |
| Fixed placement | Stable relation to the real environment, not merely unchanged numeric coordinates in an evolving tracking coordinate system. |
| Floor pitch/tilt | The floor's inclination. Current code uses a complete surface normal; it does not store one separately constrained pitch angle. |

The 20 m requirement is **travel along the row**, not an initial floor hit 20 m from the phone and not merely circling the starting rectangle. The current 8 m placement-hit limit does not prohibit walking farther after anchoring.

The user's stated yaw-plus-floor-pitch intent is authoritative. The current mathematical construction below describes implementation, not a decision that any arbitrary surface-normal rotation is the final desired yaw/pitch decomposition.

## 2. Current overall state

There are two separate apps intended for comparison:

| Area | Native app | Viro app |
| --- | --- | --- |
| Name | Floor Frame | Floor Frame Viro |
| Stack | SwiftUI, RealityKit, ARKit | Expo 57, React Native 0.86, stock `@reactvision/react-viro` 3.0.3 |
| Platforms | iOS | iOS and Android enabled in Expo config; native Android operation remains unverified in this work |
| Placement | ARKit surface raycast | Viro plane/depth hit tests |
| Attachment | RealityKit entity attached directly to an ARAnchor | World-space ViroNode follows anchor callbacks through JavaScript |
| Floor orientation | Surface normal from ARKit hit | Plane-hit rotation, or normal estimated from three adjacent depth hits |
| Anchor count for row | One | One |
| Shareable AR diagnostics | Not implemented | Implemented, including collection after anchoring |
| Proven stability over a 20 m walk | Not established | Not established |

The reported problem is that placement looks correct near the start, but the row appears to sink into the floor as the user approaches farther rectangles. A supplied recording shows floor intersections/disappearing lower edges with **occlusion enabled**. No captured diagnostic log has yet established the cause or isolated an app-specific failure mechanism. The diagnostics commit adds observation, not a sinking fix.

## 3. Geometry and initial orientation shared by both apps

Both implementations build one rigid row in a single local coordinate frame:

- Width options are 0.2 m and 3 m; each rectangle's depth is `width * 0.45` and height is `width * 0.5`.
- The rectangle base is 1 mm above the chosen surface origin to reduce coincident-surface rendering artifacts.
- The first rectangle is centered at local X = 0. Copies alternate at `-width, +width, -2*width, +2*width, ...`. This is a row extending to both sides, rather than a row beginning at one endpoint.
- Count is 1–51, initially 11. Width and count can change after anchoring without choosing a new placement.
- All rectangles inherit the same orientation. None gets a separate floor fit or anchor. Transparent mint blocks have opaque red bounding edges, including bottom edges that expose intersections.

At 3 m width, the default 11 rectangles occupy 33 m total, but their centers only reach **15 m to either side** of the main rectangle, with outer edges at 16.5 m. Fifteen rectangles place centers as far as 21 m on each side. At 0.2 m width, even the current maximum 51 rectangles span only 10.2 m total; that mode cannot cover a 20 m walk from the main rectangle with the current count limit.

Both pose helpers currently construct a surface-aligned basis from a hit position `p`, floor normal `n`, and camera position `c`:

```text
n = normalized floor normal, flipped upward
towardUser = c - p
z = normalize(towardUser - dot(towardUser, n) * n)
x = normalize(cross(n, z))
y = n
pose = basis(x, y, z) plus translation p
```

This makes the long X edge perpendicular to the projected direction toward the camera and places the base parallel to the estimated floor. It is the current mechanism for viewer-facing placement and slope support. It uses camera **position**, not a copy of the camera's Euler pitch/roll. Phone aiming still affects which floor point is selected, and Viro uses camera-forward/up vectors to take nearby depth samples.

This construction is a full 3D surface basis. It does not explicitly extract horizontal user yaw and then independently apply a stored floor-pitch angle. On sloped ground, projection onto the floor is not automatically equivalent to every possible yaw-then-pitch convention. Exact composition must be checked against the user requirement when orientation changes are implemented.

Both pose helpers reject near-zero normals, normals with upward component `<= 0.5` (roughly slopes of 60 degrees or more), hits less than 5 cm below the camera, hits 8 m or farther away, and an undefined facing direction when the camera is almost directly above the hit. Viro additionally checks finite input values.

Why: the shared construction keeps the comparison close, supports inclines, rejects walls/overhead hits, and keeps all copies geometrically rigid. It provides no measurement of the ground along the entire row.

## 4. Native iOS app: current flow and reasons

Source: [FloorFrameApp.swift](FloorFrame/FloorFrameApp.swift), [SurfacePose.swift](FloorFrame/SurfacePose.swift).

1. **Session:** the app owns an ARSession through ARView. It enables horizontal plane detection and automatic environment texturing. On mesh-capable devices, mesh reconstruction runs when either LiDAR mesh or occlusion is enabled. Frame semantics are empty in the explicit configuration.
2. **Preview:** while active and unlocked, at most 20 times per second, the app requires normal tracking and raycasts through the screen center with `.estimatedPlane` and `.any` alignment. The first result supplies position and normal. `SurfacePose.make` computes the basis above. There is no app-level temporal averaging or broad-area floor-plane fit.
3. **Commit:** tapping Anchor rectangle creates one plain `ARAnchor` at the candidate transform. A RealityKit `AnchorEntity(anchor:)` receives the whole row as its child. This directly associates rendering with the ARKit anchor rather than manually copying transforms through another UI/runtime layer.
4. **After commit:** the preview guard stops all app-level placement raycasts and recomputation of viewer-facing orientation. The row's local transform stays attached to that anchor. ARKit/RealityKit continue tracking the camera and anchor; `locked` is not a guarantee of immutable world-transform numbers or zero physical drift. There is no explicit app-level pitch-only lock, correction filter, or 20 m stability solver.
5. **Occlusion:** the toggle sets RealityKit scene-understanding `.occlusion`. It is available only on mesh-capable devices. Changing it reapplies the session configuration without explicitly resetting tracking. Occlusion may keep reconstruction active even when the separate LiDAR mesh switch is off.
6. **Reposition/reset:** Reposition removes the individual anchor and returns to preview. LiDAR mode changes unanchor and reset tracking/anchors. Reset scan also clears placement and rebuilds tracking. An ended AR session interruption triggers reset; session errors disable the rendered block. Backgrounding pauses the session and returning resumes it through `start()`.

Why this implementation exists: it is the direct Apple-framework baseline, uses ARKit's surface estimates and RealityKit's native attachment, and exposes reconstruction/occlusion separately for comparison. No custom algorithm presently extends local floor accuracy across the whole chain.

## 5. Viro iOS/Android app: current flow and reasons

Source: [App.tsx](floor-frame-viro/App.tsx), [placement.ts](floor-frame-viro/src/placement.ts), [surfacePose.ts](floor-frame-viro/src/surfacePose.ts), [viroGeometry.ts](floor-frame-viro/src/viroGeometry.ts), [ARScene.tsx](floor-frame-viro/src/ARScene.tsx).

Viro owns the camera, session, depth, mesh and anchor APIs. This app currently contains **no custom ARKit session bridge, custom native module, patched Viro library or second AR session**. TypeScript owns placement decisions and transform arithmetic; React Native owns controls.

1. **Session:** ViroARSceneNavigator uses gravity alignment, depth and world mesh according to the depth setting, and `depthBased` occlusion when enabled. Depth/mesh start enabled; occlusion starts disabled. The settings request Viro capabilities; they do not prove which depth backend is active on a particular device. Hit telemetry can identify reported depth sources.
2. **Preview:** a 50 ms timer polls while the app is active with camera permission, without overlapping polls. With normal tracking and no locked placement, it obtains camera orientation and hit-tests the forward ray. It rejects feature points, allows depth hits when depth or occlusion is enabled, then selects the nearest eligible result. The pose helper still has the 8 m initial-hit limit.
3. **Floor tilt:** a plane hit supplies its rotated Y axis as normal. A depth hit requires two additional rays offset from camera forward using right/up vectors and factor 0.015. A cross product through the three depth points estimates the normal. Missing/coincident samples or neighbor distances above 15 cm are rejected. This establishes a local patch, not a robust fit across metres of floor. There is no temporal plane fit or slope calibration stage.
4. **Anchor candidate:** if placement used a depth hit, the app prefers a nearby eligible plane result within 10 cm for anchor creation; otherwise it uses the depth hit. The rendered placement and anchor candidate can therefore originate from different hits. This accommodates backend differences in synthetic-depth anchor creation.
5. **Commit:** `createAnchoredNode(hit)` must return an anchor ID. The app saves that ID, the candidate hit's initial transform, and the chosen placement pose. The returned node's actual transform is logged but is not used as the initial transform baseline. Whether those transforms differ materially is an open diagnostic question.

   Source inspection of the installed Viro 3.0.3 (not device-tested): on iOS, `createAnchoredNodeFromHitResult` (`VRTARSceneModule.mm`) returns the created anchor's own transform in `node.transform`, so the actual anchor baseline is already available to the app. Its `rotation` is filled with four quaternion values `[X, Y, Z, W]`, although the TypeScript type declares a three-number `ViroRotation`, and anchor callbacks use Euler degrees. Viro iOS creates the anchor from the older `ARHitTestResult` API, whereas the native app uses `ARRaycastQuery`. The Android return format was not found as readable source and is unverified.
6. **After commit:** placement preview stops changing the pose. Anchor callbacks matching the saved ID instead compute:

   ```text
   renderedPose = currentAnchor * inverse(initialAnchor) * placedPose
   ```

   This preserves the model's offset/orientation relative to the initial anchor while applying the anchor's **full rotation and translation**. Pitch, roll and yaw can all change in tracking coordinates. The code does not isolate floor-pitch refinement from coordinate-system correction. The row is rendered as a world-space ViroNode updated through JavaScript, rather than a direct React anchor-attachment component, because stock Viro 3.0.3 does not expose that component in this implementation.

7. **Occlusion and reconstruction:** occlusion changes update navigator props without intentionally unanchoring. The independent depth/mesh toggle is disabled while anchored and resets the navigator/session when changed. Occlusion can still use depth when that toggle is off; depth-only capability/backend equivalence to native ARKit is not established.
8. **Reposition/reset/loss:** Reposition clears session anchors with `resetARSession(false, true)` because this flow has no public remove-single-anchor API. Reset/depth changes recreate the navigator using a session key. Removal of the bound anchor returns to preview. Limited/unavailable tracking invalidates an unlocked preview; a locked model can remain visible. App backgrounding stops sampling; returning resumes polling without an intentional placement reset.

Why this implementation exists: it compares stock Viro with the native app, without masking differences through a custom Apple-only bridge. Its hit-normal estimation and JavaScript anchor-following path differ from native and require independent verification. Neither difference alone proves the reported sinking cause.

## 6. What diagnostics currently establish

The Viro app records camera and committed model poses, initial/current anchor transforms and corrections, tracking state/reason, floor/depth hits and normals, requested depth/occlusion settings, depth readiness/capabilities, mesh stats, lighting, point samples, lifecycle/errors and chain-end/corner heights. Collection continues after anchoring.

Use **Mark sinking now**, then **Debug logs → Copy log** or **Share full log**. Copy exports recent complete records up to 350,000 characters. Share opens the system share sheet with the full buffered JSONL text attachment. Logs remain in memory until exported; capture is lost when the process terminates. The rolling/pinned buffers are bounded and declare eviction/truncation. New export modules require native app rebuilds.

Up to four extra diagnostic rays per second inspect the chain center, both ends and nearest rectangle while tracking is normal. Targets outside 0.1–8 m or the forward cone are skipped. The diagnostic rays do not update placement. A negative normal-clearance value means an estimated surface lies above the model's bottom plane.

These measurements are Viro's estimates, not independent physical ground truth or a readback of occlusion depth-buffer pixels. Callback timing is not renderer FPS. The native Swift app has no equivalent shareable recorder yet. Detailed capture limits are in the [Viro README](floor-frame-viro/README.md#sinking-diagnostics-ios-and-android).

## 7. Unresolved sinking problem and gaps against the goal

The following mechanisms remain distinguishable possibilities, not confirmed causes:

| Mechanism | Consequence | Evidence needed |
| --- | --- | --- |
| Initial floor-angle error | Far rectangles intersect the floor even if the row never changes pose. | Initial normal/chain slope, stable subsequent pose, and independently checked floor inclination. |
| Anchor rotation/translation changes | An entire rigid chain changes pose; a small rotation is magnified far from its anchor. | Bound-anchor updates, pose deltas and video aligned with a sinking marker. |
| Camera/map estimation drift | Physical registration changes even if saved numeric model coordinates seem stable. | Camera/anchor trajectories tied to known physical reference points. |
| Vertical tracking drift | Estimated camera/anchor height relationships can change during walking and cause apparent sinking even with an accurate initial angle. Gravity constrains orientation but does not establish the dominant error or a drift magnitude in this app. Better initial calibration alone cannot remove later positional drift. | Independently referenced out-and-back runs on a known pitched route, comparing the same physical checkpoints over time. Path dependence supports drift; a static spatial gradient supports initial-angle bias. Neither pattern alone is conclusive, and both can coexist. |
| Updated/noisy occlusion depth | Lower edges disappear as the estimated occluding surface changes. | Settings, hit/depth-source/confidence/mesh telemetry and matching recording; exact occlusion-buffer evidence is not currently captured. |
| Ground changes inclination along the route | One rigid plane cannot remain flush with every part of the actual ground. | Measured ground profile along the row. |
| Viro anchor baseline mismatch | A correction can be wrong if initial hit and created-anchor frames are assumed identical when they are not. | Compare candidate transform, returned node transform and first matching anchor callback. |

For scale, a 0.1 degree angular error produces about 3.5 cm of height difference over 20 m; 0.5 degrees produces about 17.5 cm; 1 degree produces about 35 cm. These are geometric examples, not measurements from the recording.

Neither app currently implements a broad-area robust floor fit, separately stored yaw/floor-pitch calibration, explicit rejection of later floor-orientation changes, a constrained multi-reference solution, surveyed reference markers, terrain following, or a demonstrated drift bound over 20 m. Both currently rely on one placement anchor for the entire row. Using more anchors independently would also need a solution for preserving row rigidity; it is not an adopted fix.

Freezing all numeric transforms or discarding every anchor update has not been accepted as a fix: tracking-coordinate corrections may be necessary for apparent physical stability. Likewise, fitting each rectangle to newly observed terrain would change the stated rigid-placement behavior. Proposed changes must identify which error they address and preserve the required yaw, floor inclination, rigidity and walking direction.

## 8. Verification status and completion criteria

At the inspected diagnostics commit:

- Viro lint and TypeScript checks passed; all **18 tests** passed. Tests cover surface geometry, Euler transforms, anchor-follow arithmetic, depth-normal rejection, chain height/clearance calculations and diagnostic export/retention.
- Production JavaScript/assets exported successfully for **iOS and Android**. React Doctor reported **100/100** before the final small callback-wrapper/ray-normalization edits; final lint/typecheck/tests and both exports passed after those edits.
- Those checks do not establish native compilation, device clipboard/share behavior, tracking accuracy, occlusion accuracy or 20 m stability for the diagnostics build.
- Earlier README build/install reports are historical. Native Swift compilation/tests were not rerun in this Windows diagnostics work; iOS builds require the Apple toolchain. No comparative performance winner has been measured.

The stability goal is complete only after testing each rebuilt app on a physical device: place once with the main long edge perpendicular to the user's initial viewing direction, use the measured floor inclination, keep the row rigid, walk along its X direction for at least 20 m, inspect intermediate/far rectangles with occlusion enabled, and return toward the start. Capture matching video and that app's diagnostic log, including a sinking marker if it occurs. Viro already has a recorder; native Swift recording/export is planned in the first milestone and remains unimplemented. Use known nonzero/compound inclines as primary acceptance routes, measured zero pitch as an additional estimator edge case, and changing/uneven terrain as a separate condition. A full precision claim must meet the separately selected horizontal and height criteria with independent measurement uncertainty; a video/log alone is not sufficient.

The user has specified approximately **20 cm positional accuracy**, with floor pitch **as precise as possible** because its error grows over 20 m. Numeric angular and separate vertical tolerances have not been specified by the user. The [implementation plan](IMPLEMENTATION_PLAN.md) now treats 20 cm as a proposed horizontal criterion and proposes stricter height-evaluation targets (2 cm for large blocks, 5 mm for small blocks), subject to user agreement and physical feasibility. Its 0.10/0.05 degree angular research targets do not by themselves meet those height limits at 20 m. Comparable native/Viro logging and a measured out-and-back walk on a known pitched route precede full calibration work. A shared gravity-axis height correction is documented as a separate, unadopted experiment: it keeps the row rigid but can confuse tracking error with a parallel ground-height change. None of these planned improvements is implemented or demonstrated. Phone movement must not trigger intentional re-facing/replacement; numerical tracking corrections must be assessed by their physical result.

For the proposed tight height limits, the plan expects a surveyed/reference-aided workstream after the cheap baseline experiment unless measurements demonstrate a phone-only solution meets the same limits. Survey geometry, marker observations and the independent validation chain all need error budgets; a millimetre-accurate floor survey alone does not guarantee millimetre AR registration. The phone-only floor estimator is conditional research, not a mandatory investment before evaluating references. If external setup is unacceptable, the proposed height limits must be explicitly reconsidered rather than quietly claimed achievable.

The plan now specifies survey import, image-reference adapters, robust one-root fusion and reference-lifecycle modules/tests. A 2026-10-26 interface audit found native ARKit world-tracking image detection and installed Viro 3.0.3 named-image registration/callbacks, including incomplete Viro prop typing and a payload-free removal callback. This is source/documentation evidence only: no marker implementation, platform device test or precision result exists. See [implementation details and audit](IMPLEMENTATION_PLAN.md#8-concrete-code-changes).

The 2026-10-27 audit adds Viro's `numberOfTrackedImages` prop: its readable iOS bridge defaults to zero and forwards updates into the engine. The current app does not set it and has no image-marker workflow. The planned reference adapter must configure a supported positive count and test continuous updates and whether runtime prop changes reconfigure/reset the session. Apple's documented four-image simultaneous limit and zero/infrequent-update behavior apply to ARKit world tracking; Android behavior remains unverified. These findings change the plan, not runtime placement.

In the planned reference workflow, validated **surveyed floor-control points define floor tilt and origin height** in the surveyed frame. The phone supplies initial user yaw and checks floor consistency; image-marker observations locate that surveyed frame. Phone/survey disagreement changes precision/recovery status, not the committed pitch. An image board's plane is not automatically the floor plane. Invalid or out-of-extent survey data cannot silently fall back to a phone plane or horizontal ground while retaining a reference-mode precision claim. This authority rule is proposed implementation behavior, not a capability already present in either app.

The proposed phone-floor height-correction experiment is **disabled in surveyed reference mode**. A shadow estimate is logging-only and cannot change rendering, survey geometry or fusion weights, including during loss/recovery. Reference-based coordinate corrections remain a separate valid tracking path. Visible phone-driven height correction is eligible only in the explicitly selected experimental phone-only mode; switching placement modes requires a new commit and clears its offsets. This mode isolation is planned and has not yet been implemented or device-tested.

**Open validation blocker:** no accepted independent method currently measures the rendered model's physical height to approximately 1 mm uncertainty. A surveyed floor plus the app's own pose estimates cannot validate that independently. The proposed 5 mm pass remains blocked; the 2 cm pass also needs an independently demonstrated measurement chain suitable for its limit. The plan records this as a metrology feasibility question, not as solved by reference markers or a screenshot overlay.

## 9. Maintaining this reference

Update the affected sections whenever placement/orientation rules, anchor attachment, floor estimation, occlusion, diagnostic capability or verification status changes. Keep **required behavior**, **implemented behavior**, **hypotheses** and **measured results** separate. Update the inspected revision/date when implementation is re-audited. Code explains current mechanics; the user's explicit product requirements define the intended result. Build/operation details remain in the app READMEs.
