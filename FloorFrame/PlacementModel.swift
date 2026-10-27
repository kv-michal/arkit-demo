import SwiftUI
import RealityKit
import ARKit
import Combine
import AVFoundation

enum PlacementMode: String, CaseIterable, Identifiable {
    case baseline, calibrated, heightExperiment, surveyed
    var id: String { rawValue }
    var label: String {
        switch self {
        case .baseline: "Single hit"
        case .calibrated: "Calibrate"
        case .heightExperiment: "Height exp."
        case .surveyed: "Survey"
        }
    }
}

/// IMPLEMENTATION_PLAN section 4 state machine.
enum PlacementPhase: String {
    case searching, calibrating, readyToCommit, locked, trackingLimited, lost
    var isLocked: Bool { self == .locked || self == .trackingLimited || self == .lost }
    var isCalibrating: Bool { self == .calibrating || self == .readyToCommit }
}

/// Native placement controller. Mirrors floor-frame-viro/src/placement.ts:
/// same modes, phases, transforms, gates, diagnostics events and hit markers.
final class PlacementModel: NSObject, ObservableObject, ARSessionDelegate {
    static let yawConventionVersion = 2

    @Published var mode = PlacementMode.baseline
    @Published private(set) var phase = PlacementPhase.searching
    @Published var large = false
    @Published var rectangleCount = 11
    @Published var followAnchorUpdates = true
    @Published var occlusion = false
    @Published var lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    @Published private(set) var locked = false
    @Published private(set) var ready = false
    @Published private(set) var busy = false
    @Published var message = "Move your phone slowly to find the floor"
    @Published var detail = "Aim the center target at a floor or slope"
    @Published var quality = ""
    @Published var budget = AccuracyBudget(width: 0.2, rectangleCount: 11).summary()
    @Published var cameraDenied = false
    @Published private(set) var referenceState = "unavailable"
    let supportsLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)

    private struct Reference {
        let anchor: ARAnchor
        let baseline: Mat4
        var latest: Mat4?
        /// Matrix that transports the row; frozen while Follow anchor updates is off.
        var transport: Mat4
        var firstCallback = false
    }

    private var subscription: Cancellable?
    private var preview = AnchorEntity(world: .zero)
    private var block = Entity()
    private var fixed: AnchorEntity?
    private var reference: Reference?
    private var referenceFromRow: Mat4?
    private var candidate: simd_float4x4?
    private var candidateHit: simd_float4x4?
    private var candidateCamera: Vec3?
    private var lastUpdate: TimeInterval = 0
    private var aimRectInWindow: CGRect?
    private var active = false
    /// Coordinate epoch: changes on resets, session changes and reference loss.
    private var epoch = 0
    private var calibration: CalibrationSession?
    private var lastBatchTime: TimeInterval = 0
    private var probeCycle = 0
    private var committed: [String: Any]?
    private let corrector = HeightCorrector()
    private let survey: SurveyManifest?
    private let referenceController: ReferenceFrameController
    private let imageAdapter: ImageReferenceAdapter?
    private var hits = HitMarkerBuffer()
    private let hitRoot = AnchorEntity(world: .zero)
    private var hitPool: [ModelEntity] = []
    private var hitMaterial = UnlitMaterial(color: UIColor(red: 0.627, green: 0.125, blue: 0.941, alpha: 1))
    private var hitRadius: Float = 0
    private var lastHitFlush: TimeInterval = 0
    private var shownHitVersion = -1
    let diagnostics = DiagnosticLog()
    private var previousFrameTime: TimeInterval?
    private var latestFrameGap: TimeInterval = 0
    private var lastTrackingState = ""
    private var trackingNormal = false
    private var lastPlacementDecision = ""

    var width: Float { large ? 3 : 0.2 }
    var dimensions: String { large ? "3 × 1.35 × 1.5 m" : "20 × 9 × 10 cm" }
    var surveyAvailable: Bool { survey != nil }

    override init() {
        let loaded = ImageReferenceAdapter.loadBundledSurvey()
        survey = loaded.manifest
        referenceController = ReferenceFrameController(manifest: loaded.manifest)
        imageAdapter = loaded.manifest.map(ImageReferenceAdapter.init(manifest:))
        super.init()
        referenceState = referenceController.state.rawValue
        diagnostics.record("app_start", [
            "renderer": "RealityKit / ARKit", "osVersion": UIDevice.current.systemVersion,
            "deviceModel": UIDevice.current.model, "deviceHardware": Self.hardwareModel,
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "unknown",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") ?? "unknown",
            "supportsLiDAR": supportsLiDAR, "snapshotHz": 5, "surfaceProbeHz": 1, "previewHz": 20,
            "limits": "6 million bytes plus 100 pinned events / 500,000 bytes; oldest records evicted",
            "unavailable": ["occlusion depth-buffer pixels", "independent surface ground truth"]
        ], pin: true)
        diagnostics.record(loaded.event, loaded.data, pin: true)
        if let imageAdapter {
            diagnostics.record("reference_targets_registered", ["ids": imageAdapter.registeredIDs, "missingImages": imageAdapter.missingIDs], pin: true)
        }
        view.session.delegate = self
        view.session.delegateQueue = .main
        // Prevent ARView from independently enabling scene reconstruction.
        view.environment.sceneUnderstanding.options = []
        view.scene.addAnchor(preview)
        view.scene.addAnchor(hitRoot)
        rebuildBlock()
        block.isEnabled = false
        subscription = view.scene.subscribe(to: SceneEvents.Update.self) { [weak self] _ in
            // RealityKit update callbacks are delivered on the rendering thread.
            DispatchQueue.main.async { self?.tick() }
        }
    }

    // MARK: Session

    func start() {
        guard !active else { return }
        guard ARWorldTrackingConfiguration.isSupported else {
            message = "AR world tracking is unavailable on this device"; return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: runSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
                DispatchQueue.main.async {
                    if allowed { self?.runSession() }
                    else { self?.cameraDenied = true; self?.message = "Camera access is required" }
                }
            }
        default: cameraDenied = true; message = "Camera access is required"
        }
    }

    private func configuration() -> ARWorldTrackingConfiguration {
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        config.environmentTexturing = .automatic
        config.sceneReconstruction = (lidar || occlusion) && supportsLiDAR ? .mesh : []
        config.frameSemantics = []
        // Configured before any placement and never toggled at runtime.
        imageAdapter?.configure(config)
        return config
    }

    private func runSession() {
        let config = configuration()
        view.session.run(config)
        diagnostics.record("session_run", configurationSnapshot(config), pin: true)
        active = true
        cameraDenied = false
    }

    func pause() {
        diagnostics.record("app_inactive", debugSnapshot(), pin: true)
        view.session.pause(); active = false; candidate = nil; previousFrameTime = nil
        if phase == .searching { ready = false }
    }

    func changeMode() {
        diagnostics.record("depth_mode_change", debugSnapshot(), pin: true)
        // Reset because old mesh anchors must not influence camera-only placement.
        resetPlacement("Scan the floor again")
        referenceController.reset()
        let config = configuration()
        view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        diagnostics.record("session_reset", configurationSnapshot(config), pin: true)
        active = true
    }

    func changeOcclusion() {
        diagnostics.record("occlusion_change", debugSnapshot(), pin: true)
        view.environment.sceneUnderstanding.options = occlusion ? [.occlusion] : []
        if active { runSession() }
    }

    func reset() {
        diagnostics.record("reset_requested", debugSnapshot(), pin: true)
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { start(); return }
        resetPlacement("Scan the floor again")
        referenceController.reset()
        active = false
        view.session.run(configuration(), options: [.resetTracking, .removeExistingAnchors])
        start()
    }

    // MARK: Geometry

    func rebuildBlock() {
        block.removeFromParent()
        let height = width * 0.5
        var material = PhysicallyBasedMaterial()
        material.baseColor = .init(tint: UIColor(red: 0.2, green: 0.85, blue: 0.72, alpha: 1))
        material.roughness = 0.6
        material.blending = .transparent(opacity: 0.6)
        let rectangle = ModelEntity(mesh: .generateBox(width: width, height: height, depth: width * 0.45, cornerRadius: height * 0.15), materials: [material])
        // The origin is on the underside, just above the surface to avoid z-fighting.
        rectangle.position.y = height / 2 + 0.001
        rectangle.position.z = RectangleGeometry.centerZ(width: width)
        // Opaque bounding edges, including the underside, reveal floor penetration.
        let depth = RectangleGeometry.depth(width: width)
        let thickness = min(Float(0.03), max(Float(0.003), width * 0.015))
        let halfX = (width - thickness) / 2
        let halfY = (height - thickness) / 2
        let halfZ = (depth - thickness) / 2
        let edgeMaterial = UnlitMaterial(color: .red)
        func addEdge(size: SIMD3<Float>, position: SIMD3<Float>) {
            let edge = ModelEntity(mesh: .generateBox(size: size), materials: [edgeMaterial])
            edge.position = position
            rectangle.addChild(edge)
        }
        for a: Float in [-1, 1] {
            for b: Float in [-1, 1] {
                addEdge(size: [width, thickness, thickness], position: [0, a * halfY, b * halfZ])
                addEdge(size: [thickness, height, thickness], position: [a * halfX, 0, b * halfZ])
                addEdge(size: [thickness, thickness, depth], position: [a * halfX, b * halfY, 0])
            }
        }
        block = Entity()
        block.addChild(rectangle)
        // Keep the placed rectangle at the origin and alternate left/right.
        for index in 1..<rectangleCount {
            let copy = rectangle.clone(recursive: true)
            copy.position.x = RectangleGeometry.offset(index: index, width: width)
            block.addChild(copy)
        }
        (fixed ?? preview).addChild(block)
        block.isEnabled = phase != .searching || ready
        diagnostics.record("geometry_changed", debugSnapshot(), pin: true)
        updateBudget()
        shownHitVersion = -1
        flushHits(force: true)
    }

    private func updateBudget() {
        let b = AccuracyBudget(width: Double(width), rectangleCount: rectangleCount)
        let uncertainty = calibration?.last?.uncertaintyDeg
        let summary = b.summary(uncertaintyDeg: uncertainty)
        if summary != budget {
            diagnostics.record("accuracy_budget", ["budget": b.dictionary, "calibrationUncertaintyDeg": uncertainty ?? NSNull(), "summary": summary], pin: true)
            budget = summary
        }
    }

    // MARK: Rendering

    private func setPhase(_ next: PlacementPhase, _ reason: String) {
        if next != phase {
            diagnostics.record("placement_state_changed", ["previous": phase.rawValue, "phase": next.rawValue, "reason": reason, "mode": mode.rawValue, "epoch": epoch], pin: true)
        }
        phase = next
        locked = next.isLocked
    }

    private func attachRowEntity() {
        guard fixed == nil else { return }
        let entity = AnchorEntity(world: .zero)
        view.scene.addAnchor(entity)
        block.removeFromParent(); entity.addChild(block)
        block.isEnabled = true
        fixed = entity
    }

    /// Uncorrected root: worldFromReference(t) * referenceFromRowAtCommit.
    private func baseWorldFromRow() -> Mat4? {
        if mode == .surveyed && phase.isLocked { return referenceController.worldFromRow }
        guard let reference, let referenceFromRow else { return nil }
        return reference.transport * referenceFromRow
    }

    /// The phone height offset applies only in the experimental mode; zero elsewhere.
    private func renderRow() {
        guard let base = baseWorldFromRow(), let fixed else { return }
        let applied = mode == .heightExperiment && phase.isLocked ? corrector.appliedDeltaM : 0
        fixed.setTransformMatrix(MatrixMath.float(HeightCorrector.corrected(base: base, appliedDeltaM: applied)), relativeTo: nil)
    }

    private func currentAnchorMatrix() -> Mat4? {
        guard let reference else { return nil }
        return reference.latest ?? reference.baseline
    }

    private func flushHits(force: Bool = false) {
        let now = CACurrentMediaTime()
        guard force || now - lastHitFlush >= 0.2, hits.version != shownHitVersion else { return }
        lastHitFlush = now
        shownHitVersion = hits.version
        let radius = Float(HitMarkerBuffer.radius(width: Double(width)))
        if radius != hitRadius {
            hitRadius = radius
            let mesh = MeshResource.generateSphere(radius: radius)
            hitPool.forEach { $0.model?.mesh = mesh }
        }
        let points = hits.all
        while hitPool.count < points.count {
            let sphere = ModelEntity(mesh: .generateSphere(radius: radius), materials: [hitMaterial])
            hitRoot.addChild(sphere)
            hitPool.append(sphere)
        }
        for (index, sphere) in hitPool.enumerated() {
            if index < points.count {
                sphere.position = SIMD3<Float>(points[index])
                sphere.isEnabled = true
            } else {
                sphere.isEnabled = false
            }
        }
    }

    // MARK: Frame loop

    private func tick() {
        guard active, CACurrentMediaTime() - lastUpdate > 1.0 / 20 else { return }
        lastUpdate = CACurrentMediaTime()
        guard let frame = view.session.currentFrame else { return }
        if survey != nil {
            let previous = referenceController.state
            let state = referenceController.update(now: frame.timestamp, epoch: epoch, worldFromAnchorNow: currentAnchorMatrix())
            if state != previous {
                diagnostics.record("reference_state_changed", ["previous": previous.rawValue, "state": state.rawValue,
                    "fusion": referenceController.lastFusion?.dictionary ?? NSNull()], pin: true)
            } else if diagnostics.due("reference_fusion", interval: 1) {
                diagnostics.record("reference_fusion", ["state": state.rawValue, "fusion": referenceController.lastFusion?.dictionary ?? NSNull()])
            }
            referenceState = state.rawValue
            if mode == .surveyed, phase.isLocked, followAnchorUpdates { renderRow() }
        }
        guard trackingNormal else { return }
        switch phase {
        case .searching: updatePreview(frame)
        case .calibrating, .readyToCommit: sampleCalibration(frame)
        default: break
        }
        flushHits()
    }

    private func raycast(_ windowPoint: CGPoint) -> ARRaycastResult? {
        let point = view.convert(windowPoint, from: nil)
        guard view.bounds.contains(point),
              let query = view.makeRaycastQuery(from: point, allowing: .estimatedPlane, alignment: .any) else { return nil }
        return view.session.raycast(query).first
    }

    private func updatePreview(_ frame: ARFrame) {
        guard let aimRectInWindow, view.window != nil else { return }
        guard let hit = raycast(CGPoint(x: aimRectInWindow.midX, y: aimRectInWindow.midY)) else {
            invalidate("Aim at a textured floor and move slowly"); return
        }
        if diagnostics.due("preview_hit", interval: 0.2) {
            diagnostics.record("preview_hit", hitSnapshot(hit))
        }
        let position = MatrixMath.position(MatrixMath.double(hit.worldTransform))
        hits.setPreview([position])
        let normal = MatrixMath.axis(MatrixMath.double(hit.worldTransform), 1)
        let camera = MatrixMath.position(MatrixMath.double(frame.camera.transform))
        // Accept walkable inclines up to 60 degrees; reject walls and ceilings.
        guard let pose = SurfacePose.pose(position: position, normal: normal, camera: camera) else {
            invalidate("Point down at a floor or slope", keepHits: true); return
        }
        let transform = MatrixMath.float(pose)
        if lastPlacementDecision != "accepted" {
            diagnostics.record("placement_decision", ["accepted": true, "transform": Self.matrix(transform)])
            lastPlacementDecision = "accepted"
        }
        candidate = transform
        candidateHit = hit.worldTransform
        candidateCamera = camera
        preview.transform = Transform(matrix: transform)
        block.isEnabled = true
        let surveyBlocked = mode == .surveyed && referenceController.state != .tracking
        ready = !surveyBlocked
        message = surveyBlocked ? "Point at a survey board" : (mode == .baseline || mode == .surveyed ? "Ready to anchor" : "Ready to calibrate")
        let slope = acos(min(1, max(-1, simd_normalize(normal).y.magnitude))) * 180 / .pi
        detail = String(format: "%.1f m away · %.0f° slope", simd_distance(camera, position), slope)
    }

    private func invalidate(_ text: String, keepHits: Bool = false) {
        if lastPlacementDecision != text {
            diagnostics.record("placement_decision", ["accepted": false, "reason": text])
            lastPlacementDecision = text
        }
        if !keepHits { hits.setPreview([]) }
        flushHits(force: true)
        candidate = nil; ready = false; block.isEnabled = false
        message = text; detail = "Aim the center target at a floor or slope"
    }

    // MARK: Placement actions

    private func makeReference(_ pose: simd_float4x4) -> Reference {
        let anchor = ARAnchor(name: "FloorFrameReference", transform: pose)
        view.session.add(anchor: anchor)
        let baseline = MatrixMath.double(pose)
        let hit = candidateHit.map(MatrixMath.double)
        // Native anchors are created at the exact candidate pose; the hit differs by the viewer-facing rotation.
        diagnostics.record("anchor_baseline", [
            "anchorId": anchor.identifier.uuidString, "baselineSource": "ARAnchor(transform:) candidate pose",
            "hitMatrix": hit.map(MatrixMath.array) ?? NSNull(), "nodeMatrix": MatrixMath.array(baseline),
            "hitVsNode": hit.map { let d = MatrixMath.difference($0, baseline); return ["positionM": d.positionM, "rotationDeg": d.rotationDeg] as [String: Any] } ?? NSNull(),
        ], pin: true)
        return Reference(anchor: anchor, baseline: baseline, latest: nil, transport: baseline)
    }

    func primaryAction() {
        diagnostics.record("placement_requested", debugSnapshot(), pin: true)
        guard !busy else { return }
        if phase.isLocked { reposition(); return }
        if phase == .readyToCommit {
            guard let result = calibration?.last, let matrix = result.matrix, result.status != .insufficient else { return }
            referenceFromRow = matrix
            commitRecord(result)
            calibration = nil
            lockPlacement(result.status == .research_consistent ? "Anchored · research gates met" : "Anchored · floor measured")
            quality = "Precision unverified"
            return
        }
        guard phase == .searching, ready, let pose = candidate, trackingNormal else { return }
        switch mode {
        case .baseline:
            reference = makeReference(pose)
            // Store the row relative to the actual anchor, so the first render cannot jump.
            referenceFromRow = MatrixMath.inverseRigid(reference!.baseline) * MatrixMath.double(pose)
            attachRowEntity()
            commitRecord(nil)
            lockPlacement("Anchored in place")
        case .surveyed:
            guard let hit = candidateHit, let camera = candidateCamera else { return }
            switch referenceController.placeRow(hitWorld: MatrixMath.position(MatrixMath.double(hit)), cameraWorld: camera) {
            case .rejected(let error):
                diagnostics.record("survey_placement_rejected", ["error": error, "state": referenceController.state.rawValue], pin: true)
                message = "Cannot anchor to survey"; detail = error
            case .placed(let surveyFromRow):
                // An ordinary anchor only carries the survey relation while boards are out of view.
                reference = makeReference(pose)
                referenceFromRow = nil
                referenceController.commit(surveyFromRow: surveyFromRow, worldFromAnchorNow: reference!.baseline)
                attachRowEntity()
                commitRecord(nil)
                lockPlacement("Anchored to survey")
            }
        case .calibrated, .heightExperiment:
            startCalibration(pose)
        }
    }

    private func startCalibration(_ pose: simd_float4x4) {
        guard let camera = candidateCamera else { return }
        let created = makeReference(pose)
        // Latch origin and heading before the user moves; movement only gathers evidence.
        let referenceFromWorld = MatrixMath.inverseRigid(created.baseline)
        let origin = MatrixMath.transform(referenceFromWorld, MatrixMath.position(created.baseline))
        let cameraRef = MatrixMath.transform(referenceFromWorld, camera)
        let gravity = MatrixMath.rotate(referenceFromWorld, MatrixMath.gravityUp)
        guard let heading = SurfacePose.horizontalHeading(origin: origin, camera: cameraRef, gravityUp: gravity) else {
            view.session.remove(anchor: created.anchor)
            message = "Step back from the target"; detail = "The initial facing direction is undefined"
            return
        }
        reference = created
        referenceFromRow = referenceFromWorld * MatrixMath.double(pose)
        calibration = CalibrationSession(origin: origin, heading: heading, gravityUp: gravity, epoch: epoch)
        lastBatchTime = 0
        hits.setPreview([])
        attachRowEntity()
        diagnostics.record("calibration_started", [
            "referenceId": created.anchor.identifier.uuidString, "originReference": MatrixMath.vector(origin),
            "cameraReference": MatrixMath.vector(cameraRef), "headingReference": MatrixMath.vector(heading),
            "gravityReference": MatrixMath.vector(gravity), "provisionalPose": Self.matrix(pose), "epoch": epoch,
        ], pin: true)
        setPhase(.calibrating, "calibration started")
        message = "Calibrating floor · scan nearby ground slowly"
        detail = "Sweep the target across the floor around and beside the row"
        quality = ""
        renderRow()
    }

    private func sampleCalibration(_ frame: ARFrame) {
        let now = CACurrentMediaTime()
        guard let session = calibration, let aimRectInWindow, let reference, now - lastBatchTime >= 0.4 else { return }
        lastBatchTime = now
        let worldFromReference = frame.anchors.first { $0.identifier == reference.anchor.identifier }
            .map { MatrixMath.double($0.transform) } ?? currentAnchorMatrix()!
        let referenceFromWorld = MatrixMath.inverseRigid(worldFromReference)
        let camera = MatrixMath.position(MatrixMath.double(frame.camera.transform))
        let cameraRef = MatrixMath.transform(referenceFromWorld, camera)
        let grid = CalibrationSampler.grid(size: session.gridSize)
        var samples: [ReferenceSample] = []
        var worldPoints: [Vec3] = []
        for (fx, fy) in grid {
            let point = CGPoint(x: aimRectInWindow.minX + fx * aimRectInWindow.width, y: aimRectInWindow.minY + fy * aimRectInWindow.height)
            guard let hit = raycast(point) else { continue }
            let world = MatrixMath.position(MatrixMath.double(hit.worldTransform))
            worldPoints.append(world)
            samples.append(ReferenceSample(point: MatrixMath.transform(referenceFromWorld, world), camera: cameraRef,
                                           source: Self.targetName(hit.target), captureTimestamp: frame.timestamp))
        }
        let duration = CACurrentMediaTime() - now
        let batch = session.addBatch(samples, now: frame.timestamp, durationS: duration)
        hits.addCalibration(worldPoints)
        let previousStatus = session.last?.status
        let result = session.fit(now: frame.timestamp)
        diagnostics.record("calibration_batch", ["batch": batch, "grid": grid.count, "accepted": samples.count, "durationS": duration,
            "gridSize": session.gridSize, "worldFromReference": MatrixMath.array(worldFromReference),
            "timing": "native ARFrame timestamp per sample"])
        if diagnostics.due("calibration_fit", interval: 1) || result.status != previousStatus {
            diagnostics.record("calibration_fit", result.dictionary, pin: result.status != .insufficient)
        }
        if let matrix = result.matrix, result.status != .insufficient {
            referenceFromRow = matrix
            if phase == .calibrating { setPhase(.readyToCommit, "calibration measured") }
        } else if phase == .readyToCommit {
            setPhase(.calibrating, "calibration evidence insufficient")
        }
        renderRow()
        updateBudget()
        switch result.status {
        case .insufficient: message = "Calibrating floor · scan nearby ground slowly"
        case .research_consistent: message = "Floor calibrated · research gates met"
        case .measured: message = "Floor measured · ready to anchor"
        }
        detail = Self.calibrationDetail(result)
        quality = result.status == .insufficient ? result.reasons.prefix(3).joined(separator: " · ") : "Precision unverified"
    }

    private static func calibrationDetail(_ result: FloorCalibration.Result) -> String {
        var parts = ["\(result.occupiedCells) cells", String(format: "%.1f×%.1f m", result.alongExtentM, result.acrossExtentM)]
        if let incline = result.alongRowInclination { parts.append(String(format: "row %.2f°", incline)) }
        if let uncertainty = result.uncertaintyDeg { parts.append(String(format: "±%.3f°", uncertainty)) }
        return parts.joined(separator: " · ")
    }

    private func commitRecord(_ result: FloorCalibration.Result?) {
        let b = AccuracyBudget(width: Double(width), rectangleCount: rectangleCount)
        let record: [String: Any] = [
            "placementId": "\(epoch)-\(Int(Date().timeIntervalSince1970 * 1000))",
            "sessionId": view.session.identifier.uuidString, "mode": mode.rawValue,
            "referenceId": reference?.anchor.identifier.uuidString ?? NSNull(),
            "referenceBaselineSource": "ARAnchor(transform:) candidate pose",
            "referenceFromRow": referenceFromRow.map(MatrixMath.array) ?? NSNull(),
            "surveyFromRow": referenceController.surveyFromRow.map(MatrixMath.array) ?? NSNull(),
            "calibrationResult": result?.dictionary ?? NSNull(),
            "yawConventionVersion": Self.yawConventionVersion, "validatedRadius": b.radiusM, "budget": b.dictionary,
            "width": width, "rectangleCount": rectangleCount,
            "committedTimestamp": Int(Date().timeIntervalSince1970 * 1000), "epoch": epoch,
        ]
        committed = record
        diagnostics.record("placement_committed", record, pin: true)
    }

    private func lockPlacement(_ text: String) {
        corrector.reset()
        hits.setPreview([])
        flushHits(force: true)
        setPhase(.locked, text)
        message = text
        detail = "Walk along the row · tap Reposition to move it"
        renderRow()
        diagnostics.record("placement_anchored", debugSnapshot(), pin: true)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    func setMode(_ next: PlacementMode) {
        guard !busy, phase == .searching, next != mode, next != .surveyed || survey != nil else { return }
        diagnostics.record("placement_mode_changed", ["previous": mode.rawValue, "mode": next.rawValue], pin: true)
        // A mode change always needs a new commit and clears experimental offsets.
        corrector.reset()
        mode = next
        quality = ""
        invalidate("Aim the target at a floor or slope")
    }

    func changeAnchorFollowing() {
        if followAnchorUpdates, var reference {
            reference.transport = reference.latest ?? reference.baseline
            self.reference = reference
            renderRow()
        }
        diagnostics.record("anchor_following_changed", debugSnapshot(), pin: true)
    }

    /// Clears the reference anchor and any calibration or placement.
    func reposition(_ text: String = "Aim at the floor to reposition") {
        diagnostics.record("unanchor_requested", ["id": reference?.anchor.identifier.uuidString ?? NSNull(), "phase": phase.rawValue], pin: true)
        resetPlacement(text)
    }

    private func resetPlacement(_ text: String) {
        diagnostics.record("placement_reset", debugSnapshot(), pin: true)
        if let anchor = reference?.anchor { view.session.remove(anchor: anchor) }
        epoch += 1
        reference = nil; referenceFromRow = nil; calibration = nil; committed = nil
        corrector.reset()
        referenceController.clearPlacement()
        block.removeFromParent(); fixed?.removeFromParent(); fixed = nil
        preview.addChild(block)
        hits.clear()
        quality = ""
        setPhase(.searching, text)
        updateBudget()
        invalidate(text)
    }

    // MARK: Session delegate

    func session(_ session: ARSession, didFailWithError error: Error) {
        diagnostics.record("session_error", ["error": error.localizedDescription, "snapshot": debugSnapshot()], pin: true)
        candidate = nil; active = false
        if phase == .searching { ready = false; block.isEnabled = false }
        message = "AR session stopped"; detail = error.localizedDescription
    }
    func sessionWasInterrupted(_ session: ARSession) {
        diagnostics.record("session_interrupted", debugSnapshot(), pin: true)
        candidate = nil; message = "Session interrupted"; detail = "Return to the app to continue"
        if phase == .searching { ready = false }
    }
    func sessionInterruptionEnded(_ session: ARSession) {
        diagnostics.record("session_interruption_ended", debugSnapshot(), pin: true)
        reset()
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard active else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let previousFrameTime { latestFrameGap = now - previousFrameTime }
        previousFrameTime = now
        let tracking = String(describing: frame.camera.trackingState)
        if tracking != lastTrackingState {
            diagnostics.record("tracking_changed", ["state": tracking, "phase": phase.rawValue], pin: true)
            lastTrackingState = tracking
            trackingChanged(frame.camera.trackingState)
        }
        if diagnostics.due("snapshot", interval: 0.2) { diagnostics.record("frame_snapshot", debugSnapshot()) }
        if diagnostics.due("environment", interval: 1) { recordEnvironment(frame) }
        if locked, trackingNormal, diagnostics.due("surface_probes", interval: 1) { probeSurfaces(frame) }
    }

    private func trackingChanged(_ state: ARCamera.TrackingState) {
        if case .normal = state { trackingNormal = true } else { trackingNormal = false }
        if !trackingNormal {
            corrector.markStale()
            switch phase {
            case .locked:
                setPhase(.trackingLimited, "tracking limited")
                message = "Tracking limited · placement confidence reduced"
                detail = "Move slowly; the row keeps its last placement"
            case .searching: invalidate("Move slowly · tracking the room")
            case .calibrating, .readyToCommit:
                message = "Tracking limited · calibration paused"; detail = "Move slowly until tracking recovers"
            default: break
            }
        } else if phase == .trackingLimited {
            setPhase(.locked, "tracking recovered")
            message = "Tracking recovered"; detail = "Walk along the row · tap Reposition to move it"
        }
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        for anchor in anchors {
            if let image = anchor as? ARImageAnchor { observeImage(image); continue }
            guard var reference, anchor.identifier == reference.anchor.identifier else { continue }
            let matrix = MatrixMath.double(anchor.transform)
            if !reference.firstCallback {
                reference.firstCallback = true
                let d = MatrixMath.difference(reference.baseline, matrix)
                diagnostics.record("anchor_baseline_callback", ["anchorId": anchor.identifier.uuidString,
                    "baseline": MatrixMath.array(reference.baseline), "baselineSource": "ARAnchor(transform:) candidate pose",
                    "callback": MatrixMath.array(matrix), "callbackFormat": "matrix",
                    "difference": ["positionM": d.positionM, "rotationDeg": d.rotationDeg]], pin: true)
            }
            reference.latest = matrix
            if followAnchorUpdates { reference.transport = matrix }
            self.reference = reference
            let before = fixed.map { Self.matrix($0.transformMatrix(relativeTo: nil)) }
            renderRow()
            let d = MatrixMath.difference(reference.baseline, matrix)
            diagnostics.record("bound_anchor_updated", ["id": anchor.identifier.uuidString,
                "anchorTransform": Self.matrix(anchor.transform), "baseline": MatrixMath.array(reference.baseline),
                "transport": MatrixMath.array(reference.transport), "referenceFromRow": referenceFromRow.map(MatrixMath.array) ?? NSNull(),
                "followAnchorUpdates": followAnchorUpdates, "renderedBefore": before ?? NSNull(),
                "renderedAfter": fixed.map { Self.matrix($0.transformMatrix(relativeTo: nil)) } ?? NSNull(),
                "deltaFromBaseline": ["positionM": d.positionM, "rotationDeg": d.rotationDeg]])
        }
    }
    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        for anchor in anchors {
            if let image = anchor as? ARImageAnchor { observeImage(image); continue }
            if anchor.identifier == reference?.anchor.identifier {
                diagnostics.record("bound_anchor_found", ["id": anchor.identifier.uuidString, "anchorTransform": Self.matrix(anchor.transform)], pin: true)
                self.session(session, didUpdate: [anchor])
            }
        }
    }
    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for anchor in anchors {
            if let image = anchor as? ARImageAnchor, let id = image.referenceImage.name {
                referenceController.remove(id)
                diagnostics.record("reference_removed", ["id": id], pin: true)
                continue
            }
            guard anchor.identifier == reference?.anchor.identifier else { continue }
            diagnostics.record("bound_anchor_removed", ["id": anchor.identifier.uuidString], pin: true)
            epoch += 1
            corrector.markStale()
            if phase.isCalibrating {
                reference = nil
                resetPlacement("Reference anchor lost · calibrate again")
            } else if phase.isLocked {
                // Keep the last placement visible but never adopt a new floor or origin silently.
                setPhase(.lost, "reference anchor removed")
                message = "Placement lost · tap Reposition"
                detail = "The tracking reference was removed; this position is uncertain"
            }
        }
    }

    private func observeImage(_ image: ARImageAnchor) {
        guard let observation = imageAdapter?.observation(image, timestamp: view.session.currentFrame?.timestamp ?? 0, epoch: epoch) else { return }
        referenceController.observe(observation)
        if diagnostics.due("marker:\(observation.id)", interval: 0.5) {
            diagnostics.record("reference_observation", ["id": observation.id, "transform": Self.matrix(image.transform),
                "isTracked": image.isTracked, "estimatedScaleFactor": image.estimatedScaleFactor, "epoch": epoch,
                "timing": "ARFrame timestamp at callback"])
        }
    }

    // MARK: Locked probes

    /// Diagnostic probes; their results only reach the gated height experiment.
    private func probeSurfaces(_ frame: ARFrame) {
        guard let base = baseWorldFromRow() else { return }
        let pose = MatrixMath.float(base)
        let cycle = probeCycle + 1
        probeCycle = cycle
        let camera = Self.position(frame.camera.transform)
        let forward = -SIMD3(frame.camera.transform.columns.2.x, frame.camera.transform.columns.2.y, frame.camera.transform.columns.2.z)
        let normal = simd_normalize(SIMD3(pose.columns.1.x, pose.columns.1.y, pose.columns.1.z))
        let bottom = Self.point(pose, [0, 0.001, 0])
        let (left, right) = RectangleGeometry.bounds(width: width, count: rectangleCount)
        let centerZ = RectangleGeometry.centerZ(width: width)
        let nearest = (0..<rectangleCount).map { RectangleGeometry.offset(index: $0, width: width) }
            .min { simd_distance(camera, Self.point(pose, [$0, 0.001, centerZ])) < simd_distance(camera, Self.point(pose, [$1, 0.001, centerZ])) } ?? 0
        var observations: [HeightCorrector.Observation] = []
        var probePoints: [Vec3] = []
        for (name, x) in [("center", Float(0)), ("leftEnd", left), ("rightEnd", right), ("nearestRectangle", nearest)] {
            let target = Self.point(pose, [x, 0.001, centerZ])
            let offset = target - camera, distance = simd_length(offset)
            var data: [String: Any] = ["target": name, "targetWorld": Self.vector(target), "distanceM": distance]
            guard distance >= 0.1, distance <= 8, simd_dot(offset / distance, forward) >= 0.5 else {
                data["skipped"] = "outside 0.1–8 m or 60 degree forward cone"
                diagnostics.record("surface_probe", data); continue
            }
            let query = ARRaycastQuery(origin: camera, direction: offset / distance, allowing: .estimatedPlane, alignment: .any)
            let results = view.session.raycast(query)
            data["hitCount"] = results.count
            data["hits"] = results.prefix(32).map { hit -> [String: Any] in
                var result = hitSnapshot(hit)
                let position = Self.position(hit.worldTransform)
                result["normalClearanceM"] = simd_dot(normal, bottom - position)
                result["targetErrorM"] = simd_distance(position, target)
                return result
            }
            for hit in results.prefix(4) {
                let world = MatrixMath.double(hit.worldTransform)
                probePoints.append(MatrixMath.position(world))
                observations.append(.init(point: MatrixMath.position(world), normal: MatrixMath.axis(world, 1),
                    source: Self.targetName(hit.target), targetMissM: simd_distance(MatrixMath.position(world), Vec3(target)), cycle: cycle))
            }
            diagnostics.record("surface_probe", data)
        }
        hits.setProbes(probePoints)
        flushHits(force: true)
        // Shadow estimate in every locked mode; applied only in the experiment.
        let update = corrector.update(base: base, observations: observations, now: frame.timestamp, apply: mode == .heightExperiment)
        diagnostics.record("height_correction", ["mode": mode.rawValue, "cycle": cycle, "update": update.dictionary,
            "applied": mode == .heightExperiment ? corrector.appliedDeltaM : 0, "shadowOnly": mode != .heightExperiment,
            "surveyState": referenceController.state.rawValue, "epoch": epoch])
        renderRow()
        if mode == .heightExperiment {
            quality = String(format: "Height exp. · applied %.1f cm", corrector.appliedDeltaM * 100)
                + (update.proposedDeltaM.map { String(format: " · proposed %.1f cm", $0 * 100) } ?? " · waiting for floor")
        }
    }

    // MARK: Diagnostics

    private func recordEnvironment(_ frame: ARFrame) {
        let planes = frame.anchors.compactMap { $0 as? ARPlaneAnchor }
        let meshes = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        var summary: [String: Any] = ["anchorCount": frame.anchors.count, "planeCount": planes.count,
            "meshCount": meshes.count, "meshVertices": meshes.reduce(0) { $0 + $1.geometry.vertices.count },
            "meshFaces": meshes.reduce(0) { $0 + $1.geometry.faces.count }]
        summary["planes"] = planes.prefix(32).map { plane -> [String: Any] in
            let vertices = plane.geometry.vertices
            return ["id": plane.identifier.uuidString, "transform": Self.matrix(plane.transform),
                "center": Self.vector(plane.center), "alignment": plane.alignment.rawValue,
                "classification": String(describing: plane.classification),
                "vertexCount": vertices.count, "vertices": vertices.prefix(64).map(Self.vector)]
        }
        if let light = frame.lightEstimate {
            summary["light"] = ["ambientIntensity": light.ambientIntensity, "colorTemperature": light.ambientColorTemperature]
        }
        if let points = frame.rawFeaturePoints {
            summary["featureCount"] = points.points.count
            summary["featureSamples"] = points.points.prefix(64).map(Self.vector)
        }
        diagnostics.record("environment_summary", summary)
    }

    private static var hardwareModel: String {
        var info = utsname(); uname(&info)
        return withUnsafeBytes(of: &info.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
    static func targetName(_ target: ARRaycastQuery.Target) -> String {
        switch target {
        case .estimatedPlane: "estimatedPlane"
        case .existingPlaneGeometry: "existingPlaneGeometry"
        case .existingPlaneInfinite: "existingPlaneInfinite"
        @unknown default: "unknown"
        }
    }
    static func vector(_ v: SIMD3<Float>) -> [Float] { [v.x, v.y, v.z] }
    static func matrix(_ m: simd_float4x4) -> [Float] {
        (0..<4).flatMap { c in (0..<4).map { r in m[c][r] } }
    }
    static func position(_ m: simd_float4x4) -> SIMD3<Float> {
        SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
    }
    static func point(_ m: simd_float4x4, _ p: SIMD3<Float>) -> SIMD3<Float> {
        let result = m * SIMD4(p, 1)
        return SIMD3(result.x, result.y, result.z)
    }
    private func configurationSnapshot(_ config: ARWorldTrackingConfiguration) -> [String: Any] {
        ["lidarRequested": lidar, "occlusionRequested": occlusion,
         "sceneReconstruction": config.sceneReconstruction.rawValue,
         "frameSemantics": config.frameSemantics.rawValue,
         "planeDetection": config.planeDetection.rawValue,
         "detectionImages": config.detectionImages?.count ?? 0,
         "maximumNumberOfTrackedImages": config.maximumNumberOfTrackedImages,
         "realityKitOcclusion": view.environment.sceneUnderstanding.options.contains(.occlusion)]
    }
    private func hitSnapshot(_ hit: ARRaycastResult) -> [String: Any] {
        ["transform": Self.matrix(hit.worldTransform), "target": Self.targetName(hit.target),
         "alignment": hit.targetAlignment.rawValue, "anchorID": hit.anchor?.identifier.uuidString ?? "none"]
    }

    func debugSnapshot() -> [String: Any] {
        var data: [String: Any] = ["active": active, "mode": mode.rawValue, "phase": phase.rawValue, "epoch": epoch,
            "locked": locked, "ready": ready, "cameraDenied": cameraDenied, "message": message, "widthM": width,
            "rectangleCount": rectangleCount, "lidarRequested": lidar, "occlusionRequested": occlusion,
            "supportsLiDAR": supportsLiDAR, "callbackGapMs": latestFrameGap * 1000,
            "placementOrigin": "camera-facing bottom edge", "followAnchorUpdates": followAnchorUpdates,
            "heightCorrection": ["appliedDeltaM": corrector.appliedDeltaM, "stale": corrector.stale],
            "survey": ["state": referenceController.state.rawValue,
                       "worldFromSurvey": referenceController.worldFromSurvey.map(MatrixMath.array) ?? NSNull(),
                       "surveyFromRow": referenceController.surveyFromRow.map(MatrixMath.array) ?? NSNull()],
            "budget": AccuracyBudget(width: Double(width), rectangleCount: rectangleCount).dictionary]
        if let aimRectInWindow {
            let point = view.convert(CGPoint(x: aimRectInWindow.midX, y: aimRectInWindow.midY), from: nil)
            data["aimScreenPoint"] = ["x": point.x, "y": point.y, "viewWidth": view.bounds.width, "viewHeight": view.bounds.height]
        }
        if let config = view.session.configuration as? ARWorldTrackingConfiguration {
            data["configuration"] = configurationSnapshot(config)
        }
        if let candidate { data["previewTransform"] = Self.matrix(candidate) }
        if let reference {
            data["reference"] = ["id": reference.anchor.identifier.uuidString, "baseline": MatrixMath.array(reference.baseline),
                                 "latest": reference.latest.map(MatrixMath.array) ?? NSNull(), "transport": MatrixMath.array(reference.transport)]
        }
        if let referenceFromRow { data["referenceFromRow"] = MatrixMath.array(referenceFromRow) }
        if let calibration {
            data["calibration"] = ["batches": calibration.batch, "observations": calibration.observations.count,
                                   "gridSize": calibration.gridSize, "last": calibration.last?.dictionary ?? NSNull()]
        }
        if let committed { data["committed"] = committed }
        if let frame = view.session.currentFrame {
            data["frameTimestamp"] = frame.timestamp
            data["cameraTransform"] = Self.matrix(frame.camera.transform)
            data["cameraIntrinsics"] = (0..<3).flatMap { c in (0..<3).map { r in frame.camera.intrinsics[c][r] } }
            data["trackingState"] = String(describing: frame.camera.trackingState)
            data["worldMappingStatus"] = frame.worldMappingStatus.rawValue
            data["depthAvailable"] = frame.sceneDepth != nil
            data["smoothedDepthAvailable"] = frame.smoothedSceneDepth != nil
        }
        if let fixed, phase != .searching {
            let current = fixed.transformMatrix(relativeTo: nil)
            data["currentPlacementTransform"] = Self.matrix(current)
            data["renderedBlockTransform"] = Self.matrix(block.transformMatrix(relativeTo: nil))
            data["bottomCornersWorld"] = RectangleGeometry.bottomCorners(width: width, count: rectangleCount).map { Self.vector(Self.point(current, $0)) }
            if let base = baseWorldFromRow(), let reference {
                let initial = reference.baseline * (referenceFromRow ?? MatrixMath.identity)
                let a = MatrixMath.position(initial), b = MatrixMath.position(base)
                let d = MatrixMath.difference(initial, base)
                data["poseDelta"] = ["verticalM": b.y - a.y, "translationM": simd_distance(a, b), "rotationDeg": d.rotationDeg]
            }
        }
        return data
    }

    func setAimRect(_ rect: CGRect) {
        guard aimRectInWindow != rect else { return }
        aimRectInWindow = rect
        diagnostics.record("aim_point_changed", ["windowX": rect.midX, "windowY": rect.midY, "width": rect.width, "height": rect.height])
        if phase == .searching { candidate = nil; ready = false; block.isEnabled = false }
    }

    func markSinking() { diagnostics.record("USER_MARKED_SINKING", debugSnapshot(), pin: true) }
    func exportDiagnostics(_ event: String, maxBytes: Int? = nil) -> (text: String, truncated: Bool) {
        diagnostics.record(event, debugSnapshot(), pin: true)
        return diagnostics.export(maxBytes: maxBytes)
    }
}
