# Implementation plan: stable floor placement over 20 metres

Date: **2026-10-26**. Based on the implementation described in [PROJECT_STATE.md](PROJECT_STATE.md), inspected at **8f450ba**.

**Status: design for future implementation.** This document does not mean these improvements exist or have met their accuracy targets. Current behavior remains in PROJECT_STATE.md. Numerical tuning values below are starting proposals, not measured sensor capabilities.

## 1. Requirements and proposed acceptance targets

The user places the main rectangle in front of them, with its long edge perpendicular to their initial viewing direction. User orientation supplies **yaw only**; floor geometry supplies inclination. The user then walks along the long-edge/row direction, including at least 20 m from the starting rectangle. The row remains one rigid object with stable physical registration. Occlusion stays enabled for the sinking test.

**Always treat the floor as potentially pitched.** Use one placement/calibration flow that measures the real floor inclination. Gravity defines the vertical reference for yaw and angle measurement; it does not determine the floor normal. There is no separate level-ground mode or horizontal fallback in this plan. If the floor inclination cannot be measured adequately, report insufficient calibration rather than assume zero pitch. A zero-pitch result is valid only when supported by floor measurements.

The user's positional accuracy requirement is approximately **20 cm**. Their angular requirement is floor pitch **as precise as possible**, because a small angular error becomes a large distant height error. The user has not specified an exact angular number. Adopt the following measurable engineering targets for implementation/evaluation:

| Quantity | Proposed target | Meaning |
| --- | --- | --- |
| Horizontal registration error | At most 0.20 m at measured checkpoints during a 20 m walk | Along-row and cross-row error of model reference points against independently known physical locations, not just changes in the root transform. Treat this as the proposed operational interpretation of the user's approximately 20 cm requirement. |
| Vertical registration error | Proposed: at most 0.02 m for 3 m blocks; 0.005 m for 20 cm blocks | Signed vertical separation between the intended bottom plane and independently measured floor at each checkpoint. These are size-specific evaluation targets, not user-approved requirements or demonstrated capabilities. |
| Total along-row inclination error | At most 0.10 degrees | Actual rendered slope versus independently measured reference slope, including calibration and tracking effects. |
| Stretch inclination target | 0.05 degrees | Pursue only if repeatable physical measurements support it. |
| Root horizontal translation error allocation | At most 0.10 m | Internal horizontal budget; this does not permit 10 cm of vertical translation. |
| Full orientation diagnostic | Report displacement at radius 20 m | 0.14 degrees produces about 4.9 cm of 3D displacement. This illustrative number is not sufficient to pass the tighter vertical criterion. |
| Heading error guide | About 0.10 degrees or better | Yaw error also creates lateral displacement at the far end; it cannot consume the entire positional allowance. |

For a row on a pitched plane, the vertical component of an angular error depends on the actual inclination. Use the slope-independent rotation displacement bound `2 * R * sin(rotationError / 2)`, with R the distance of the tested vertex from the placement origin. This bounds the 3D displacement from rotation on any plane inclination and therefore also bounds its vertical component. It does not assume level ground.

| Inclination error | Maximum rotation-induced displacement at radius 20 m |
| --- | --- |
| 0.05 degrees | 1.75 cm |
| 0.10 degrees | 3.49 cm |
| 0.25 degrees | 8.73 cm |
| 0.50 degrees | 17.45 cm |
| 1.00 degree | 34.91 cm |

A 0.57 degree error already consumes approximately all 20 cm at 20 m before any translation or yaw error. It is not an appropriate pitch target.

Illustrative horizontal allocation at R = 20 m: 10 cm root horizontal translation + at most about 5 cm rotation-induced horizontal displacement + 5 cm reserve = 20 cm. This is not a shared 3D budget: vertical error must pass its own tighter limit. Occlusion errors and real ground curvature must also be reported separately rather than silently counted as model tracking accuracy.

### Split vertical and horizontal budgets

A single 20 cm bound is too loose for the reported symptom. Sinking is a vertical error judged against the floor right next to the user: 20 cm buries a large part of a 1.5 m-tall 3 m block and exceeds the whole 10 cm height of a 20 cm block. Horizontal and vertical error are therefore budgeted and reported separately.

- **Horizontal:** the 20 cm allocation above applies to along-row and cross-row error.
- **Vertical:** for a row length L, initial along-row inclination alpha and angle error delta, the endpoint's height change due to angle alone is `L * (sin(alpha + delta) - sin(alpha))`. Add origin-height and vertical tracking errors, with conservative absolute bounds instead of assuming their signs cancel. The earlier `L * tan(delta)` shortcut applies approximately near zero inclination; it must not be treated as the formula for every pitched plane.
- **Large blocks, proposed 2 cm:** a 0.10 degree error can contribute 3.49 cm at 20 m and therefore already exceeds this vertical target. If half the 2 cm allowance goes to angle, its conservative allowance at radius 20 m is about 0.029 degrees; the remaining 1 cm must cover origin height, tracking drift and measurement uncertainty.
- **Small blocks, proposed 5 mm:** the 10 cm-tall blocks need a stricter visible-clipping criterion. The current small-block row cannot reach 20 m; test its actual rendered radius. These targets require independent measurement and may be infeasible with the available hardware.

The height limits are proposals for evaluating visible sinking, not established product tolerances. Confirm them with the user before presenting them as a product acceptance contract. Keep 0.10/0.05 degrees as intermediate calibration research targets, not sufficient conditions for a height pass. Local calibration may not meet even those angular targets: the first physical tests must measure that before building the full estimator. A run passes only the criteria it actually meets; unused horizontal allowance cannot absorb vertical error. Even 2 cm of clipping can remain visible, so record geometric error and occlusion appearance separately.

**Planning decision for these proposed tight limits:** after the cheap baseline test, treat surveyed reference geometry and independently observed references as the expected precision workstream, unless evidence demonstrates a phone-only method meets the same limits. The phone-only estimator remains an exploratory, lower-setup comparison; its success is not assumed and it is not a prerequisite for building the reference-aided prototype. This chooses where to investigate, not a guarantee that marker tracking can deliver 2 cm/5 mm or authorization to silently change the product workflow. If external setup is unacceptable, agree a looser measured height target explicitly instead of promising the tight one.

For scale, assigning half the height budget to angular displacement at R = 20 m gives about 0.029 degrees for a 2 cm total height limit, but about 0.0072 degrees for a 5 mm total limit. On a 2 m calibration baseline those correspond to approximately 1 mm and 0.25 mm of angular height signal. The small-block mode currently has a much shorter maximum row; apply its allowance at its actual radius. These examples explain the expected reference-aided workstream; they are not sensor-resolution claims.

Recompute the angular allowance for the **actual farthest rendered point**:

```text
rotationAllowance = 2 * asin(rotationDisplacementBudget / (2 * R))
```

For example, 15 rectangles at 3 m width extend 22.5 m to their outer X edges, even though the farthest centers are at 21 m. Certification for a 20 m checkpoint does not automatically certify every vertex of a much longer row. Width/count changes after anchoring must update the displayed validated range and angle budget; they must not silently claim the longer row meets the old accuracy target.

## 2. Architecture: frozen design geometry, tracked physical reference

Separate the problem into three modules:

1. **FloorCalibration** estimates a sufficiently broad, stable floor plane before final placement.
2. **PlacementDefinition** stores immutable origin, initial heading, floor plane, row layout and row-to-reference transform at commit.
3. **TrackingReference** supplies the current transform of that physical reference into the tracking world. It transports the whole rigid row as the tracking system updates.

```text
worldFromRow(t) = worldFromReference(t) * referenceFromRowAtCommit
worldFromRectangle_i(t) = worldFromRow(t) * rowFromRectangle_i
```

In the baseline mode, post-commit floor rays are diagnostics only. They cannot change `referenceFromRowAtCommit`, re-face the model toward the moving user, or fit individual rectangles to the ground. All rectangles share the same root transform. Section 7 specifies a separate proposed experiment that applies one shared gravity-axis height correction, without changing the committed yaw, inclination or local layout. Its terrain-following tradeoff remains an explicit product decision; listing the experiment does not adopt it as normal behavior.

**Freeze the chosen relationship, not every numeric world coordinate.** Anchor updates may be necessary to maintain physical registration as tracking coordinates change. ARCore explicitly distinguishes a session/world anchor from attachment to a refining trackable surface. Prefer a free/session anchor for the rigid placement where the framework permits it, rather than intentionally welding the model to subsequent floor-plane refinements. [ARCore anchor behavior](https://developers.google.com/ar/develop/anchors).

Do not implement “pitch lock” by dropping X/Z Euler rotations from arbitrary anchor callbacks. That can discard legitimate coordinate corrections, depends on Euler convention, and confuses slope changes with map updates. With only one estimated anchor pose, those causes may be observationally indistinguishable. Preserve the calibrated local relationship and use independent evidence to decide whether additional drift correction is justified.

## 3. Define initial yaw and floor inclination explicitly

Proposed convention: the 90 degree relationship is measured in the **horizontal plan view**. The long edge's horizontal projection stays perpendicular to the initial user-to-placement direction. The fitted floor plane supplies the tilt. This makes the yaw rule testable; it is a design clarification to verify against the user's intended interaction on slopes.

Let `g` be gravity-up, `p` the intended origin, `c` the initial camera position, and `n` the calibrated upward floor normal. Use vectors/matrices or quaternions internally:

```text
zHorizontal = normalize((c - p) - dot(c - p, g) * g)
xHorizontal = normalize(cross(g, zHorizontal))

# Lift the chosen long-edge heading onto the floor while preserving its
# horizontal projection. Require dot(n, g) above the allowed slope limit.
x = normalize(xHorizontal - g * dot(n, xHorizontal) / dot(n, g))
y = n
z = normalize(cross(x, y))
rotation = basis(x, y, z)
```

Validate orthogonality, determinant +1, finite values, and upward normal. This differs from the current projection of the camera-to-hit vector onto the floor: that projection can alter the long edge's horizontal yaw on compound slopes.

Define `alongRowInclination = atan2(dot(x, g), length(x - dot(x, g) * g))`. This is the height-changing angle relevant when walking along local X. Record the complete floor normal and cross-slope too. A full floor normal can introduce multiple Euler components; no component may originate from copying the user's phone pitch/roll. Do not mistakenly assume the model's X-axis Euler “pitch” alone controls vertical change along the row.

Latch the origin candidate and initial heading **before asking the user to move during calibration**. Subsequent camera movement gathers evidence; it cannot redefine the user's chosen yaw. Preserve the measured floor inclination, including a genuine nonzero pitch. Gravity supplies the coordinate reference only; insufficient floor evidence must never substitute a gravity-horizontal model.

## 4. Calibration state machine

```text
SEARCHING -> CALIBRATING -> READY_TO_COMMIT -> LOCKED
                   |              |
                   +-- insufficient evidence: remain calibrating
LOCKED -> TRACKING_LIMITED -> LOCKED after reference recovery
LOCKED/TRACKING_LIMITED -> LOST if the physical reference cannot be recovered
Any state -> SEARCHING on explicit reset/reposition
```

- **SEARCHING:** live target and preliminary preview. Existing surface rejection rules remain.
- **CALIBRATING:** a placement/calibration action latches heading and a provisional origin/reference. Collect spatially distributed floor samples while the user slowly scans nearby ground. Show a provisional row and a simple progress/quality indication.
- **READY_TO_COMMIT:** show the calibrated rigid preview and its estimated angular uncertainty. Final Anchor action stores the immutable placement. Prevent committing a target-quality claim when evidence is inadequate.
- **LOCKED:** stop calibration updates. Keep physical tracking, occlusion and diagnostics active.
- **TRACKING_LIMITED:** retain the last placement definition, indicate reduced confidence and exclude poor-quality observations. Continuing rendering from a stale transform cannot be described as guaranteed physical accuracy.
- **LOST:** report placement unavailable or clearly uncertain; require explicit recovery/reposition rather than silently adopting a new floor or origin.

The desired immediate “place, then walk” interaction is retained whenever calibration can complete locally. A pre-walk along all 20 m is not a hidden prerequisite. If local evidence cannot support the angular target, report the limitation and offer longer calibration or an explicit external-reference mode.

## 5. Floor-plane estimator

**Conditional workstream:** implement this full estimator only after the early out-and-back experiment in section 10 shows an initial-angle problem and a smaller sampling prototype demonstrates useful improvement. Do not build RANSAC, a new placement state machine and duplicate production estimators in both languages merely to discover that the dominant error was vertical translation during walking. First replay captured data in one small offline prototype; port validated math using shared fixtures only when justified.

### Sampling and coordinate consistency

Collect points across a floor region, not just three adjacent depth rays. Proposed initial region: approximately 2–4 m across the row direction and at least 1 m across its depth direction, within locally reliable sensing range. Actual coverage is measured from valid points; a sampling grid alone does not establish a physical baseline.

Use up to a 5 x 5 spatial grid at 2–5 collection batches per second during calibration, with a strict time/in-flight budget and adaptive reduction on slow devices. Prefer samples around 0.5–4 m from the phone for initial experiments. These are tuning proposals; never present them as universal depth accuracy specifications. Every sample records source, timestamp/receipt time, camera pose, reference pose, confidence when exposed and spatial cell.

Store samples in a stable calibration-reference frame. Ideally:

```text
pointReference = inverse(worldFromReference_atSample) * pointWorld_atSample
```

Use hit, camera and anchor transforms from the same frame/coordinate epoch where available. AR maps evolve; appending old world-space points to new world-space points without frame transport can corrupt the fit. A missing timestamp must remain missing, not be fabricated from JS callback receipt time. Invalidate incompatible batches after session changes, anchor loss or unresolved coordinate discontinuity.

For stock Viro, explicitly audit what timestamps and coordinate guarantees each public API actually exposes. JS callbacks alone do not establish atomic camera/hit/anchor sampling. If that prevents a trustworthy precision assessment, expose the limitation and evaluate a separate native sampling adapter; do not claim native-equivalent timing from asynchronous JS events.

### Robust fit and quality gate

1. Filter non-finite, out-of-range, wall/overhead and clearly low-confidence samples. Keep source-specific groups; do not blindly mix LiDAR, monocular-depth and plane-derived measurements as equally accurate independent observations.
2. Downsample into spatial cells and cap each cell/frame's weight. Thousands of observations of one small patch must not overpower a few measurements spanning the region.
3. Use deterministic-seeded RANSAC to identify a plane consensus, followed by robust weighted total-least-squares/PCA refinement. The fitted normal is the smallest-eigenvalue direction of the centered covariance; normalize it upward.
4. Verify coverage along both in-plane directions and reject near-collinear support. Log eigenvalues, robust residual distribution, inlier fraction, point count, occupied cells and observed baselines.
5. Estimate temporal stability and uncertainty using held-out spatial cells and frame-block resampling. Resampling neighboring pixels as independent points would overstate confidence. Check separate acquisition sweeps for agreement.
6. Fit origin height from the calibrated plane at the selected horizontal position. Avoid independently accepting a noisy final hit height after the plane has converged.
7. **Research consistency gates only:** at least 30 occupied cells across multiple batches/views, at least 2 m along-row and 1 m across-row coverage, inlier fraction at least 80%, robust plane residual around 1 cm or less, inclination variation at most 0.05 degrees over the last second, and an estimated inclination interval within the 0.10 degree intermediate research target. Passing may label the fit `RESEARCH_CONSISTENT`; it cannot label the placement ready for the 2 cm/5 mm height claim. A 1 cm fit residual and 0.10 degree interval are not precision acceptance thresholds.
8. **Separate precision gate:** derive angular and height uncertainty allocations from the selected size, actual radius and vertical budget in section 1. Require independently validated bounds on absolute inclination/origin bias, expected tracking error and measurement uncertainty; their conservative combined height bound must fit the selected limit. For example, the large-block half-budget angle allocation at 20 m is about 0.029 degrees, not 0.10 degrees. Tightening fit residuals alone is insufficient: source bias and later drift remain. Until validation supports a runtime quality predictor and the required reference evidence is available, report precision unverified even if research gates pass.

The 30-cell proposal requires accumulated coverage over multiple 25-ray batches; repeated hits in the same cells do not count again. These gates are heuristics for accepting a calibration attempt. Low residuals, repeatable biased depths and narrow bootstrap intervals **do not prove absolute 0.10 degree accuracy**. Validate absolute slope independently before using the quality badge as a product accuracy claim.

A 2 m baseline changes height by only about 3.5 mm for a 0.10 degree angle. That illustrates why spatial baseline, sensor bias and independent validation matter; averaging a tiny patch cannot promise the target. Local calibration also cannot establish that the next 20 m of pavement share the same plane. Report a non-planar route separately from tracking failure. Keep the row rigid rather than changing its design to fit newly observed terrain.

## 6. Anchor creation and transport

### Native app

Keep direct `AnchorEntity(anchor:)` attachment. Create the reference anchor after calibration and store the row's relationship to that actual anchor. A plain ARAnchor remains the baseline; floor detection may continue for understanding/occlusion without changing the committed calibration. Apple documents anchors as improving tracking in their local area, not as an accuracy guarantee over an arbitrary distance. [ARAnchor](https://developer.apple.com/documentation/arkit/aranchor).

### Viro app

Replace the assumption that the hit-test pose is the created anchor's initial pose.

**Finding from the installed Viro 3.0.3 source** (inspected, not yet tested on a device): on iOS, `createAnchoredNodeFromHitResult` in `VRTARSceneModule.mm` creates the anchor via `createAnchoredNodeAtHitLocation()` and already returns that anchor's own transform in `node.transform`, read from `anchor->getTransform()`. The current app logs this value but builds `anchorBinding.initial` from the hit transform instead (`placement.ts`). Format differences must be handled before using it:

- iOS fills `transform.rotation` with four quaternion values `[X, Y, Z, W]`. The TypeScript type `ViroARNodeReference.transform.rotation` declares `ViroRotation`, a three-number tuple, and the anchor callbacks deliver Euler degrees that `transformMatrix` consumes. Passing the returned rotation into `transformMatrix` unchanged would be wrong.
- Viro on iOS creates anchors from the older `ARHitTestResult` API. The native app uses `ARRaycastQuery`. This is a comparison difference, not by itself a defect.
- The Android implementation was not found as readable source in the installed package; its return format must be checked on a device.

Steps:

1. Save the intended calibrated world pose and request creation using an eligible hit.
2. Build the baseline from the actual anchor: convert `node.transform` (quaternion on iOS) to a matrix, and validate it against the hit transform and the first matching anchor callback. Log all three. If they disagree beyond tolerance, prefer the anchor's own transform and record the difference; that difference measures the current baseline-mismatch hypothesis directly.
3. Establish the anchor and desired placement in a consistent coordinate epoch. If the asynchronous creation spans a tracking discontinuity, restart/recover the transaction instead of multiplying transforms from different frames.
4. Store `anchorFromRow = inverse(worldFromAnchorAtCommit) * worldFromRowAtCommit`.
5. For matching updates, render `worldFromAnchorNow * anchorFromRow` for the whole row. Never assign each rectangle its own unconstrained correction.

If stock Viro cannot provide a consistent anchor pose transaction, treat that as a capability gap. Evaluate native render attachment or a small adapter on both platforms in an explicitly named improved mode. Preserve a stock-Viro comparison mode; a custom adapter changes the comparison architecture and must be documented in PROJECT_STATE.md when adopted.

A correct baseline prevents a transform bookkeeping error; it does not eliminate genuine SLAM drift. Smoothing is only for rendering jitter after the transform semantics are correct. It must not accumulate lag, bypass tracking-loss status or be sold as improved absolute accuracy.

## 7. Twenty-metre tracking strategy and escalation

### Vertical tracking drift: the main unaddressed hypothesis

Gravity constrains tracking orientation, but this does not guarantee negligible tilt error, nor does it establish which error dominates in these apps. Height/position, heading and anchor pose errors can all affect registration. Even with a correct initial floor angle, a change in the estimated camera/anchor vertical relationship can make farther rectangles appear to sink or float. Whether the error is 5–15 cm, smaller, or larger must be measured; no drift magnitude or monotonic growth with distance is assumed. World-coordinate corrections can also change numeric poses without worsening physical registration. [ARKit world-tracking limitations](https://developer.apple.com/documentation/arkit/understanding-world-tracking), [ARCore coordinate updates](https://developers.google.com/ar/reference/java/com/google/ar/core/Pose).

This is a hypothesis, not a measured cause. It matters because better initial inclination addresses the initial angular contribution, not vertical position changes that occur later. Investigate it with the walk-and-return test (section 10, step 2):

- **Initial angle bias:** a spatial error gradient is consistent with the measured initial inclination error. At the same physical checkpoint, a pure static bias is similar outbound and inbound. Calibration can vary across placements; repeatability between runs is not required.
- **Vertical drift:** the same physical checkpoint changes error with path/time, including on return, or camera/anchor registration changes despite an independently verified initial angle. Return-to-start recovery supports a drift hypothesis but does not prove it; no recovery does not rule it out.
- **Occlusion discrepancy:** independently checked model geometry aligns with the reference while visible edges/faces are hidden incorrectly. Keep occlusion enabled for the normal experiment; logs do not currently read back its exact depth buffer.
- **Mixed/undetermined:** angle bias, tracking errors, terrain and occlusion can coexist. An out-and-back walk provides discrimination, not guaranteed causal identification without physical references.

**Candidate mitigation, not adopted: gated rigid height correction.** While locked, use the floor observed near the user (diagnostic rays already exist in the Viro app) to estimate one shared vertical offset for the whole row, and apply it to the root transform only. This keeps the row rigid, never changes yaw or inclination, and never fits individual rectangles. It conflicts with the current "post-commit floor rays are diagnostics only" rule (section 2) and cannot tell tracking drift apart from a real change in ground height or slope along the route. Adopting it is a product decision for the user. If evaluated, it must:

- run in an explicitly named mode, with the uncorrected mode kept for comparison;
- correct translation along gravity only, with a rate limit and an uncertainty gate;
- reject observations with unstable normals, depth discontinuities, poor tracking, stale coordinate epochs or inadequate spatial support; slope disagreement can flag terrain change but slope agreement cannot prove an unchanged plane;
- log every correction, and be judged by measured vertical error at checkpoints, not by visual smoothness.

Implement the candidate as a separate scalar correction composed after ordinary anchor transport:

```text
baseWorldFromRow = worldFromReferenceNow * referenceFromRowAtCommit
correctedWorldFromRow = translation(gravityUpNow * deltaY) * baseWorldFromRow
worldFromRectangle_i = correctedWorldFromRow * rowFromRectangle_i
```

Compute residuals against the **uncorrected** bottom plane in the same current coordinate epoch. For a plane `n dot p + d = 0` and floor observation p, the gravity-axis offset that raises the plane to p is `r = (n dot p + d) / dot(n, gravityUp)`. Estimate an absolute deltaY from a robust, time-bounded group of accepted residuals, not by repeatedly adding residuals and creating an integrator. Preserve the existing 1 mm base offset explicitly in the residual convention. Require a sufficient upward denominator, source-specific confidence/support, an empirically tuned deadband, a rate limit and a cumulative correction cap. Log raw residuals, proposed/applied offsets, gate failures, timestamps and source. Keep a shadow estimate with no rendering effect before enabling corrections.

Do not encode unmeasured filter constants as accuracy claims. On tracking/reference loss, stop updates and mark the correction stale; recover its coordinate epoch before resuming. A single vertical offset can improve the nearby floor match while worsening the start or far end. Measure all checkpoints in both modes, not just the user's current location. A parallel step or depth bias can produce the same residual as drift even when normals agree: the experiment explicitly assumes the original pitched plane continues. That ambiguity cannot be removed by a gate using the same floor measurements.

The requirement against “lifting the row” means adding an arbitrary fixed clearance to hide penetration. This experiment instead proposes a measured, signed correction that can move the row up or down. It is not exempt from the fixed-placement requirement by definition: accepting that measured translation still changes the product's post-commit behavior and remains an explicit decision. Leave the normal mode unchanged until that decision and comparative validation are recorded in PROJECT_STATE.md.

**First milestone:** comparable logs and an independently referenced out-and-back test using the existing placement flow. Preserve the current pitched-floor estimate for this baseline; do not introduce a level-floor placement mode. Then choose a workstream from the evidence. A single reference is a testable baseline, not the guaranteed final long-range solution. ARCore recommends keeping objects within about 8 m of their anchor and warns that separate anchors can move relative to each other. [Anchor distance and rigidity guidance](https://developers.google.com/ar/develop/anchors).

If physical tests exceed the budget, add evidence before adding correction logic:

- Capture the initial placement, checkpoints and return-to-start error. Check for an initial angle bias versus a growing map error.
- Extra virtual anchors alone do not supply independent ground truth. Creating a far anchor at a location predicted by the same drifting map can preserve that error.
- For the proposed tight-height route, plan independently located visual references near the start and along the route as the expected workstream in delivery step 3, such as surveyed fiducial boards with known geometry. Size, placement, detector support and pose-measurement error need device testing; a surveyed board does not guarantee equally accurate camera localization. This adds setup and is an explicit product tradeoff.
- Use multiple references to estimate **one rigid world-from-row transform**. Keep known reference positions/orientations in a common surveyed frame. Robustly minimize positional/orientation residuals with uncertainty weights; reject inconsistent or stale detections. Independent poses must be transformed to a common acquisition epoch before fusion.
- Require observable geometry: collinear point references alone do not determine every rotational degree of freedom. Use non-collinear points, orientation-bearing markers, and/or a separately validated floor constraint.
- Gate corrections by estimated uncertainty and known tracking state. Reacquire uncertain references; do not cap a necessary world correction to a tiny angle and silently leave the model misregistered. Apply one shared correction to the row.

Automatic local-anchor handoff may be evaluated as an experiment. It must preserve the row's rigid frame across overlap, demonstrate actual accuracy improvement, and account for the fact that nearby anchors can still disagree. It is not a substitute for independent calibration or a default proven fix.

## 8. Concrete code changes

These files/modules are **planned**, except for the existing files named as edit targets:

| Area | Native Swift | Viro/TypeScript | Responsibility |
| --- | --- | --- | --- |
| Calibration math | New `FloorFrame/FloorCalibration.swift` | New `floor-frame-viro/src/floorCalibration.ts` | Spatial filtering, robust plane fit, covariance/coverage/uncertainty outputs. |
| Sampling adapter | New `FloorFrame/CalibrationSampler.swift` | New `floor-frame-viro/src/calibrationSampler.ts` | Frame/source metadata, bounded sampling, coordinate transport and stale-batch rejection. |
| Pose convention | Edit `FloorFrame/SurfacePose.swift` | Edit `floor-frame-viro/src/surfacePose.ts` | Explicit latched horizontal yaw plus calibrated floor inclination; no device pitch/roll input. |
| Placement lifecycle | Edit `FloorFrame/FloorFrameApp.swift` | Edit `floor-frame-viro/src/placement.ts` | Calibration states, immutable placement, anchor creation transaction and recovery. |
| Anchor arithmetic | Native anchor/local transform code | Edit `floor-frame-viro/src/viroGeometry.ts` | Actual-anchor baseline and verified transform composition. |
| Rendering/UI | Native ContentView/ARView | Edit `floor-frame-viro/App.tsx` and `src/ARScene.tsx` | Calibration progress, uncertainty/loss status, one shared rigid row. |
| Diagnostics | New native recorder/export controls | Extend existing diagnostics files | Comparable calibration, reference, transport and physical-test evidence. |
| Shared fixtures | New versioned JSON fixtures under `Tests/fixtures/` | Consume the same fixtures in TS tests | Numeric parity across stacks with explicit axis/units conventions. |

Suggested records:

```text
SurfaceObservation:
  pointReference, source, confidence?, captureTimestamp?, receivedTimestamp,
  frameId?, sessionId, referenceId, coordinateEpoch, cameraPose?, spatialCell

CalibrationResult:
  normalReference, planeOffset, originReference, initialHeadingReference,
  alongRowInclination, crossSlope, coverage, residuals, effectiveSampleCount,
  uncertaintyEstimate, qualityStatus, limitations

CommittedPlacement:
  placementId, sessionId, referenceId, referenceFromRow,
  calibrationResult, yawConventionVersion, validatedRadius,
  width, rectangleCount, committedTimestamp
```

Any added SDK/API must be verified against the installed version before implementation. For native ARKit, broad-region raycasting can use the existing estimated-plane path; mesh vertices are an optional adapter source, transformed from each mesh anchor's local space. Mesh-derived samples must remain a documented mode, not assumed available on non-LiDAR hardware. [ARKit estimated-plane behavior](https://developer.apple.com/documentation/arkit/arraycastquery/target-swift.enum/estimatedplane), [ARMeshGeometry](https://developer.apple.com/documentation/arkit/armeshgeometry).

## 9. Tests and measurement protocol

### Automated gates

- Recover known pitched planes, including compound inclines, under controlled noise, uneven sampling, gross outliers, depth discontinuities and source bias; reject collinear/insufficient support. Include zero pitch as a measured edge case of the same estimator, not a separate placement mode. Include biased fixtures that remain low-residual so the quality gate is not mistaken for absolute truth.
- Verify yaw in horizontal plan view at several headings and compound floor inclines. Changing camera height/downward angle while retaining the selected location/heading must not introduce phone pitch/roll into placement.
- Feed identical synthetic fixtures to Swift and TS. Compare plane normal, long-axis heading, origin, along-row inclination and corner positions with declared numeric tolerances.
- Exercise anchor creation where hit pose and actual anchor pose differ. First render must preserve the intended placement rather than jump. Replay coordinate-frame corrections and verify relative geometry remains invariant.
- Reject asynchronous/stale samples across reset, reference loss and incompatible epochs. Test tracking limitation/recovery without accidental re-facing or floor refitting.
- At the real call site, prove locked diagnostic hits cannot mutate the committed placement. Verify all rectangle transforms remain `root * fixedLocalTransform`.
- Recompute range/angle budget when width/count changes, including the 15 x 3 m layout and large 51-rectangle cases.

### Physical gates

Use independently measured, repeatable control points along a known pitched planar route at approximately 0, 5, 10, 15 and 20 m. Size the reference measurement to the **height criterion**, not the intermediate 0.10 degree research target. Proposed validation budget: expanded vertical uncertainty of approximately 1 mm or better at each evaluated floor/model reference point for the 5 mm criterion; aim for the same reference network for large-block comparisons. Specify the confidence/coverage convention, include relative height-difference uncertainty when deriving inclination, and account for correlated errors. The 2 cm criterion permits a larger budget only if explicitly justified and included in the pass calculation.

Plan for survey-grade differential/digital leveling with appropriate calibrated staffs and stable control points, or an equivalently validated measurement method. A phone inclinometer, ordinary construction laser or a millimetre display readout alone does not establish millimetre measurement uncertainty. Survey practice requires instrument/rod calibration, field procedure and closure checks; these matter in addition to instrument specifications. [NGS geodetic leveling guidance](https://www.ngs.noaa.gov/leveling/). A professional survey or suitable equipment access is a real validation dependency; no purchase or specific instrument is assumed.

Include the full measurement chain: surveyed floor/reference geometry, marker/target center offsets and motion, camera/pose calibration, reconstruction of the rendered model's location, timestamp alignment and route-frame registration. Millimetre floor heights alone do not make the model-error measurement millimetre accurate. Record instrument, calibration, repeat observations, loop closure, surface roughness, uncertainty propagation and confidence convention. Use `abs(measuredHeightError) + expandedMeasurementUncertainty <= selectedHeightLimit` as a conservative pass rule under that stated convention. If this uncertainty cannot be established, record the run as insufficiently measured for the tight target; it can still diagnose centimetre-scale drift. Surveyed markers that also drive correction must be separate from held-out validation checkpoints.

Use at least 15 rectangles at 3 m width for centers beyond 20 m. Place the main rectangle once, capture the initial pose, walk along local X to 20 m, inspect each checkpoint with occlusion enabled, turn/view from another angle, and return to the start. Include the opposite row direction where physically possible. A video alone is not a metric 3D registration measurement; use measured targets/visual references and a recorded coordinate-alignment procedure. References used for the test must not feed the tracking algorithm unless this is explicitly an external-reference-mode test.

Run at least five independent placements per app/device/route condition as an initial evaluation. Report every run, maximum and percentile registration errors, measured inclination bias/drift, heading error, uncertainty, tracking losses and completion rate. Five runs are an engineering screen, not a production reliability estimate. A height-acceptance pass requires both the horizontal target and the applicable proposed vertical target, including measurement uncertainty. Merely meeting the intermediate 0.10 degree angle target does not establish a vertical pass. Do not hide failures in an average.

Evaluate native iOS, Viro iOS and Viro Android separately. Make known nonzero inclines and compound inclines primary acceptance scenarios; include measured zero pitch as an additional estimator edge case. Separate LiDAR/depth backends, lighting/texture conditions and changing terrain. Include the original dark/reflective-pavement condition as a difficult scenario; a pass on a bright textured floor does not establish a pass there. Report unsupported or inadequate calibration explicitly.

Report horizontal and vertical error separately at every checkpoint, against their separate budgets. Record vertical error on the way out and on return to the start, so that initial-angle bias and vertical drift can be told apart (section 7).

Observe positional alignment and floor clipping as different outcomes. A registered rigid model can intersect real non-planar pavement; noisy occlusion can also clip it. Meeting the position budget alone does not certify the occlusion depth model.

## 10. Delivery sequence and definition of done

1. **Minimum comparable instrumentation:** implement a small native Swift recorder/exporter before changing placement algorithms. Match Viro's JSONL schema/version, units, monotonic/UTC timestamps and shared event meanings for camera/anchor poses, initial/committed placement, tracking changes, chain-bottom geometry, user marker and copy/share. Keep engine-specific data namespaced, and distinguish native frame timestamps from JS receipt times. The existing Viro recorder can support an immediate first walk; do not delay that useful measurement until the native recorder is complete. Completion: both rebuilt apps can export a physical-device capture that a common reader can align with the recording; native compilation and device export are actually checked. This is explicitly part of the first milestone, not a late table entry.
2. **Cheap out-and-back experiment:** using the existing flow, place once on a measured route with a known consistent **nonzero pitch**, walk 20 m along X and return, with occlusion enabled. Measure repeat visits to 0/5/10/15/20 m checkpoints and mark symptoms in both apps. Keep yaw/width/count/settings consistent. Completion: comparable logs and independent checkpoint evidence support an initial-angle, vertical/heading-drift, anchor-baseline, occlusion, mixed or undetermined classification. A documented non-reproduction is also a result. No full plane fitter, calibration UI or dual-language estimator is a prerequisite.
3. **Choose a precision route and focused workstream:** for the proposed 2 cm/5 mm limits, make surveyed reference geometry and a reference-aided prototype the expected next path, with independent held-out validation points and explicit setup costs. Skip that path only if early phone-only measurements demonstrate the same limits with adequate uncertainty. If external setup is unacceptable, explicitly revise the proposed height target before investing in a phone-only precision promise. If slope bias dominates, a small offline plane-fit replay can still quantify whether cheap improvement is available; it does not need a production estimator in both languages. Verify/fix anchor bookkeeping separately when indicated. For path-dependent vertical error, evaluate a no-rendering height-correction shadow estimator without asserting it resolves terrain ambiguity. Completion: record the route, evidence, expected metric and required setup; do not automatically build every workstream.
4. **Smallest justified implementation:** add explicit yaw-composition math with fixtures; add the broader floor estimator/state machine only if the prototype measurably helps. Port validated math across Swift/TS using shared fixtures. If the height experiment is selected, retain an uncorrected comparison mode and make its terrain assumption explicit before adopting it as product behavior. Completion: real call-site tests preserve one rigid root, chosen yaw/inclination and correct anchor transport; neither production app gains an unexplained architecture change.
5. **Repeat independent 20 m evaluation:** measure both apps/device backends against separate horizontal and height budgets, including outbound/inbound checkpoint differences and uncertainty. Completion: per-run results identify improvements, regressions, failure cases and unverified targets. Angle/position claims remain limited to measured results.
6. **Resolve remaining capability gaps:** surveyed references already belong to step 3 for the tight-height route; they are not deferred until this final step. Evaluate native sampling/attachment adapters or constrained reference fusion for a remaining identified error. Completion: controlled comparisons improve that physical metric while preserving one rigid row. A smoother animation, extra anchors alone or a lower fit residual does not complete this step.

Update PROJECT_STATE.md after each implemented milestone. An implementation is not complete because the row stops visibly moving in tracking coordinates or because a filter makes it look smoother. Under this proposed acceptance profile, completion requires measured horizontal registration within 20 cm **and** height error within the selected size-specific limit (2 cm for large blocks, 5 mm for small blocks), including declared measurement uncertainty at every required checkpoint. Also demonstrate an angular error budget compatible with that height limit at the actual rendered radius, and preserve the original yaw/measured-floor-inclination/rigidity contract. The numeric height limits require user agreement before becoming product requirements. If the agreed profile is changed, update sections 1 and 9 and this definition together; neither an intermediate 0.10 degree calibration result nor a passed horizontal test substitutes for a height pass.
