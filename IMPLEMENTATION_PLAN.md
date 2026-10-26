# Implementation plan: stable floor placement over 20 metres

Date: **2026-10-26**. Based on the implementation described in [PROJECT_STATE.md](PROJECT_STATE.md), inspected at **8f450ba**.

**Status: design for future implementation.** This document does not mean these improvements exist or have met their accuracy targets. Current behavior remains in PROJECT_STATE.md. Numerical tuning values below are starting proposals, not measured sensor capabilities.

## 1. Requirements and proposed acceptance targets

The user places the main rectangle in front of them, with its long edge perpendicular to their initial viewing direction. User orientation supplies **yaw only**; floor geometry supplies inclination. The user then walks along the long-edge/row direction, including at least 20 m from the starting rectangle. The row remains one rigid object with stable physical registration. Occlusion stays enabled for the sinking test.

The user's positional accuracy requirement is approximately **20 cm**. Their angular requirement is floor pitch **as precise as possible**, because a small angular error becomes a large distant height error. The user has not specified an exact angular number. Adopt the following measurable engineering targets for implementation/evaluation:

| Quantity | Proposed target | Meaning |
| --- | --- | --- |
| Physical registration error | At most 0.20 m at measured checkpoints during a 20 m walk | Evaluate model reference points against independently known physical locations, not just changes in the root transform. Treat this as the proposed operational interpretation of the user's approximately 20 cm requirement. |
| Total along-row inclination error | At most 0.10 degrees | Actual rendered slope versus independently measured reference slope, including calibration and tracking effects. |
| Stretch inclination target | 0.05 degrees | Pursue only if repeatable physical measurements support it. |
| Root translation error allocation | At most 0.10 m | Internal budget stricter than the overall 20 cm target; leaves room for angular effects. |
| Full orientation error allocation at radius 20 m | At most 0.14 degrees | Includes heading, inclination and tracking effects together. Per-axis targets do not replace this combined check. |
| Heading error guide | About 0.10 degrees or better | Yaw error also creates lateral displacement at the far end; it cannot consume the entire positional allowance. |

For a near-level row extending a horizontal distance L, vertical error from inclination error is approximately `L * tan(angleError)`. For arbitrary 3D geometry, use the conservative rotation displacement bound `2 * R * sin(rotationError / 2)`, with R the distance of the tested vertex from the placement origin.

| Inclination error | Height error over 20 m, near level |
| --- | --- |
| 0.05 degrees | 1.75 cm |
| 0.10 degrees | 3.49 cm |
| 0.25 degrees | 8.73 cm |
| 0.50 degrees | 17.45 cm |
| 1.00 degree | 34.91 cm |

A 0.57 degree error already consumes approximately all 20 cm at 20 m before any translation or yaw error. It is not an appropriate pitch target.

Proposed conservative budget at R = 20 m: 10 cm root translation + approximately 4.9 cm from 0.14 degrees total rotation + 5 cm reserve = approximately 19.9 cm. These are allocations; they are not independent sensor guarantees. Occlusion errors and real ground curvature must also be reported separately rather than silently counted as model tracking accuracy.

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

After commit, new floor rays are diagnostics only. They cannot change `referenceFromRowAtCommit`, re-face the model toward the moving user, or fit individual rectangles to the ground. All rectangles share the same root transform.

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

Latch the origin candidate and initial heading **before asking the user to move during calibration**. Subsequent camera movement gathers evidence; it cannot redefine the user's chosen yaw. Gravity-zero tilt is an optional explicit level-floor mode, not an automatic replacement for a genuine incline.

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
7. Proposed initial gates: at least 30 occupied cells across multiple batches/views, at least 2 m along-row and 1 m across-row coverage, inlier fraction at least 80%, robust plane residual around 1 cm or less, inclination variation at most 0.05 degrees over the last second, and an estimated inclination interval within the 0.10 degree target. Tune against real devices and documented failure cases.

The 30-cell proposal requires accumulated coverage over multiple 25-ray batches; repeated hits in the same cells do not count again. These gates are heuristics for accepting a calibration attempt. Low residuals, repeatable biased depths and narrow bootstrap intervals **do not prove absolute 0.10 degree accuracy**. Validate absolute slope independently before using the quality badge as a product accuracy claim.

A 2 m baseline changes height by only about 3.5 mm for a 0.10 degree angle. That illustrates why spatial baseline, sensor bias and independent validation matter; averaging a tiny patch cannot promise the target. Local calibration also cannot establish that the next 20 m of pavement share the same plane. Report a non-planar route separately from tracking failure. Keep the row rigid rather than changing its design to fit newly observed terrain.

## 6. Anchor creation and transport

### Native app

Keep direct `AnchorEntity(anchor:)` attachment. Create the reference anchor after calibration and store the row's relationship to that actual anchor. A plain ARAnchor remains the baseline; floor detection may continue for understanding/occlusion without changing the committed calibration. Apple documents anchors as improving tracking in their local area, not as an accuracy guarantee over an arbitrary distance. [ARAnchor](https://developer.apple.com/documentation/arkit/aranchor).

### Viro app

Replace the assumption that the hit-test pose is the created anchor's initial pose:

1. Save the intended calibrated world pose and request creation using an eligible hit.
2. Wait for a usable transform associated with the returned anchor ID: validate the returned node transform against the first matching anchor callback. Log both and verify the installed API's semantics.
3. Establish the anchor and desired placement in a consistent coordinate epoch. If the asynchronous creation spans a tracking discontinuity, restart/recover the transaction instead of multiplying transforms from different frames.
4. Store `anchorFromRow = inverse(worldFromAnchorAtCommit) * worldFromRowAtCommit`.
5. For matching updates, render `worldFromAnchorNow * anchorFromRow` for the whole row. Never assign each rectangle its own unconstrained correction.

If stock Viro cannot provide a consistent anchor pose transaction, treat that as a capability gap. Evaluate native render attachment or a small adapter on both platforms in an explicitly named improved mode. Preserve a stock-Viro comparison mode; a custom adapter changes the comparison architecture and must be documented in PROJECT_STATE.md when adopted.

A correct baseline prevents a transform bookkeeping error; it does not eliminate genuine SLAM drift. Smoothing is only for rendering jitter after the transform semantics are correct. It must not accumulate lag, bypass tracking-loss status or be sold as improved absolute accuracy.

## 7. Twenty-metre tracking strategy and escalation

**First milestone:** robust calibration plus a correct single-anchor attachment, then measure. A single reference is a testable baseline, not the guaranteed final long-range solution. ARCore recommends keeping objects within about 8 m of their anchor and warns that separate anchors can move relative to each other. [Anchor distance and rigidity guidance](https://developers.google.com/ar/develop/anchors).

If physical tests exceed the budget, add evidence before adding correction logic:

- Capture the initial placement, checkpoints and return-to-start error. Check for an initial angle bias versus a growing map error.
- Extra virtual anchors alone do not supply independent ground truth. Creating a far anchor at a location predicted by the same drifting map can preserve that error.
- For a higher-assurance mode, investigate independently located visual references near the start and along the route, such as surveyed fiducial boards with known geometry. Size, placement, detector support and measurement error need device testing. This adds setup and is an explicit product tradeoff.
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

- Recover known flat and inclined planes under controlled noise, uneven sampling, gross outliers, depth discontinuities and source bias; reject collinear/insufficient support. Include biased fixtures that remain low-residual so the quality gate is not mistaken for absolute truth.
- Verify yaw in horizontal plan view at several headings and compound floor inclines. Changing camera height/downward angle while retaining the selected location/heading must not introduce phone pitch/roll into placement.
- Feed identical synthetic fixtures to Swift and TS. Compare plane normal, long-axis heading, origin, along-row inclination and corner positions with declared numeric tolerances.
- Exercise anchor creation where hit pose and actual anchor pose differ. First render must preserve the intended placement rather than jump. Replay coordinate-frame corrections and verify relative geometry remains invariant.
- Reject asynchronous/stale samples across reset, reference loss and incompatible epochs. Test tracking limitation/recovery without accidental re-facing or floor refitting.
- At the real call site, prove locked diagnostic hits cannot mutate the committed placement. Verify all rectangle transforms remain `root * fixedLocalTransform`.
- Recompute range/angle budget when width/count changes, including the 15 x 3 m layout and large 51-rectangle cases.

### Physical gates

Use independently measured, repeatable control points along a known planar route at approximately 0, 5, 10, 15 and 20 m. Establish the floor's actual inclination and reference frame using a suitable survey/leveling method with substantially smaller uncertainty than the target. For example, 0.10 degrees corresponds to about 3.5 cm over 20 m; the reference measurement should resolve height differences comfortably below that. Record the reference instrument/method and uncertainty.

Use at least 15 rectangles at 3 m width for centers beyond 20 m. Place the main rectangle once, capture the initial pose, walk along local X to 20 m, inspect each checkpoint with occlusion enabled, turn/view from another angle, and return to the start. Include the opposite row direction where physically possible. A video alone is not a metric 3D registration measurement; use measured targets/visual references and a recorded coordinate-alignment procedure. References used for the test must not feed the tracking algorithm unless this is explicitly an external-reference-mode test.

Run at least five independent placements per app/device/route condition as an initial evaluation. Report every run, maximum and percentile registration errors, measured inclination bias/drift, heading error, uncertainty, tracking losses and completion rate. Five runs are an engineering screen, not a production reliability estimate. All measured checkpoints in a passing run must meet the proposed 20 cm positional and 0.10 degree inclination criteria; do not hide failures in an average.

Evaluate native iOS, Viro iOS and Viro Android separately. Separate LiDAR/depth backends, level ground, a known consistent incline, lighting/texture conditions and changing terrain. Include the original dark/reflective-pavement condition as a difficult scenario; a pass on a bright textured floor does not establish a pass there. Report unsupported or inadequate calibration explicitly.

Observe positional alignment and floor clipping as different outcomes. A registered rigid model can intersect real non-planar pavement; noisy occlusion can also clip it. Meeting the position budget alone does not certify the occlusion depth model.

## 10. Delivery sequence and definition of done

1. **Baseline evidence:** obtain current diagnostic logs and physical reference measurements. Completion: at least one recorded reproduction with checkpoint/reference data, or a documented non-reproduction condition.
2. **Math and fixtures:** implement/test explicit yaw composition and broad-plane calibration. Completion: shared Swift/TS fixtures pass, including rejection and bias cases.
3. **Creation transaction:** correct/verify Viro anchor baseline and compare with native attachment. Completion: offset-anchor and world-coordinate-change replay tests pass without placement jumps.
4. **Calibration UI and immutable commit:** implement state machine, latch user yaw, quality gates and locked diagnostics separation. Completion: real call-site tests pass and both app flows operate on physical devices.
5. **20 m evaluation:** run independent physical tests against the proposed budgets. Completion: per-device results are recorded, including failures and limits; unsupported accuracy claims remain disabled.
6. **Escalation if necessary:** prototype independent references or a documented native Viro adapter when evidence shows a specific capability/accuracy gap. Completion: comparative measurements show whether it actually improves the failed metric while preserving one rigid row.

Update PROJECT_STATE.md after each implemented milestone. An implementation is not complete because the row stops visibly moving in tracking coordinates or because a filter makes it look smoother. Completion requires measured physical registration around the user's 20 cm target and demonstrated angular accuracy over the required span, with the original yaw/floor-inclination contract preserved.
