import SwiftUI
import RealityKit
import ARKit
import Combine
import AVFoundation

@main
struct FloorFrameApp: App {
    var body: some SwiftUI.Scene { WindowGroup { ContentView() } }
}

final class PlacementModel: NSObject, ObservableObject, ARSessionDelegate {
    @Published var large = false
    @Published var rectangleCount = 11
    @Published var followAnchorUpdates = true
    @Published var occlusion = false
    @Published var lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    @Published var locked = false
    @Published var ready = false
    @Published var message = "Move your phone slowly to find the floor"
    @Published var detail = "Aim the center target at a floor or slope"
    @Published var cameraDenied = false
    let supportsLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private var subscription: Cancellable?
    private var preview = AnchorEntity(world: .zero)
    private var block = Entity()
    private var fixed: AnchorEntity?
    private var arAnchor: ARAnchor?
    private var latestAnchorTransform: simd_float4x4?
    private var candidate: simd_float4x4?
    private var lastUpdate: TimeInterval = 0
    private var aimPointInWindow: CGPoint?
    private var active = false
    private let diagnostics = DiagnosticLog()
    private var initialPlacement: simd_float4x4?
    private var previousFrameTime: TimeInterval?
    private var latestFrameGap: TimeInterval = 0
    private var lastTrackingState = ""
    private var lastPlacementDecision = ""

    var width: Float { large ? 3 : 0.2 }
    var dimensions: String { large ? "3 × 1.35 × 1.5 m" : "20 × 9 × 10 cm" }

    override init() {
        super.init()
        diagnostics.record("app_start", [
            "renderer": "RealityKit / ARKit", "osVersion": UIDevice.current.systemVersion,
            "deviceModel": UIDevice.current.model, "deviceHardware": Self.hardwareModel,
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "unknown",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") ?? "unknown",
            "supportsLiDAR": supportsLiDAR, "snapshotHz": 5, "surfaceProbeHz": 1,
            "limits": "6 million bytes plus 100 pinned events / 500,000 bytes; oldest records evicted",
            "unavailable": ["occlusion depth-buffer pixels", "independent surface ground truth"]
        ], pin: true)
        view.session.delegate = self
        view.session.delegateQueue = .main
        // Prevent ARView from independently enabling scene reconstruction.
        view.environment.sceneUnderstanding.options = []
        view.scene.addAnchor(preview)
        rebuildBlock()
        block.isEnabled = false
        subscription = view.scene.subscribe(to: SceneEvents.Update.self) { [weak self] _ in
            // RealityKit update callbacks are delivered on the rendering thread.
            DispatchQueue.main.async { self?.updatePreview() }
        }
    }

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

    private func runSession() {
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        config.environmentTexturing = .automatic
        config.sceneReconstruction = (lidar || occlusion) && supportsLiDAR ? .mesh : []
        config.frameSemantics = []
        view.session.run(config)
        diagnostics.record("session_run", configurationSnapshot(config), pin: true)
        active = true
        cameraDenied = false
    }

    func pause() {
        diagnostics.record("app_inactive", debugSnapshot(), pin: true)
        view.session.pause(); active = false; ready = false; candidate = nil; previousFrameTime = nil
    }

    func changeMode() {
        diagnostics.record("depth_mode_change", debugSnapshot(), pin: true)
        unanchor()
        // Reset because old mesh anchors must not influence camera-only placement.
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        config.environmentTexturing = .automatic
        config.sceneReconstruction = (lidar || occlusion) && supportsLiDAR ? .mesh : []
        view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        diagnostics.record("session_reset", configurationSnapshot(config), pin: true)
        active = true
        message = "Scan the floor again"
    }

    func changeOcclusion() {
        diagnostics.record("occlusion_change", debugSnapshot(), pin: true)
        view.environment.sceneUnderstanding.options = occlusion ? [.occlusion] : []
        if active { runSession() }
    }

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
            let side: Float = index % 2 == 1 ? -1 : 1
            copy.position.x = side * Float((index + 1) / 2) * width
            block.addChild(copy)
        }
        (fixed ?? preview).addChild(block)
        block.isEnabled = locked || ready
        diagnostics.record("geometry_changed", debugSnapshot(), pin: true)
    }

    private func updatePreview() {
        guard active, !locked, CACurrentMediaTime() - lastUpdate > 1.0 / 20 else { return }
        lastUpdate = CACurrentMediaTime()
        guard let frame = view.session.currentFrame else { return }
        guard case .normal = frame.camera.trackingState else {
            invalidate("Move slowly · tracking the room"); return
        }
        guard let aimPointInWindow, view.window != nil else { return }
        let point = view.convert(aimPointInWindow, from: nil)
        guard view.bounds.contains(point) else { return }
        guard let query = view.makeRaycastQuery(from: point, allowing: .estimatedPlane, alignment: .any),
              let hit = view.session.raycast(query).first else {
            invalidate("Aim at a textured floor and move slowly"); return
        }
        if diagnostics.due("preview_hit", interval: 0.2) {
            diagnostics.record("preview_hit", hitSnapshot(hit))
        }
        var normal = simd_normalize(SIMD3<Float>(hit.worldTransform.columns.1.x, hit.worldTransform.columns.1.y, hit.worldTransform.columns.1.z))
        if normal.y < 0 { normal = -normal }
        // Accept walkable inclines up to 60 degrees; reject walls and ceilings.
        let position = SIMD3<Float>(hit.worldTransform.columns.3.x, hit.worldTransform.columns.3.y, hit.worldTransform.columns.3.z)
        let camera = SIMD3<Float>(frame.camera.transform.columns.3.x, frame.camera.transform.columns.3.y, frame.camera.transform.columns.3.z)
        guard let transform = SurfacePose.make(position: position, normal: normal, camera: camera) else {
            invalidate("Point down at a floor or slope"); return
        }
        if lastPlacementDecision != "accepted" {
            diagnostics.record("placement_decision", ["accepted": true, "transform": Self.matrix(transform)])
            lastPlacementDecision = "accepted"
        }
        candidate = transform
        preview.transform = Transform(matrix: transform)
        block.isEnabled = true
        ready = true
        message = "Ready to anchor"
        let pitch = acos(min(1, max(-1, normal.y))) * 180 / .pi
        detail = String(format: "%.1f m away · %.0f° slope", simd_distance(camera, position), pitch)
    }

    private func invalidate(_ text: String) {
        if lastPlacementDecision != text {
            diagnostics.record("placement_decision", ["accepted": false, "reason": text])
            lastPlacementDecision = text
        }
        candidate = nil; ready = false; block.isEnabled = false
        message = text; detail = "Aim the center target at a floor or slope"
    }

    func anchor() {
        guard ready, let transform = candidate, !locked else { return }
        let anchor = ARAnchor(name: "FloorFrame", transform: transform)
        view.session.add(anchor: anchor)
        // A world anchor lets us explicitly opt out of ARAnchor corrections.
        let entity = AnchorEntity(world: transform)
        latestAnchorTransform = transform
        arAnchor = anchor; fixed = entity
        view.scene.addAnchor(entity)
        block.removeFromParent(); entity.addChild(block)
        locked = true
        initialPlacement = transform
        diagnostics.record("placement_anchored", debugSnapshot(), pin: true)
        message = "Anchored in place"
        detail = "Walk around it · tap Reposition to move it"
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    func changeAnchorFollowing() {
        if followAnchorUpdates, let latestAnchorTransform, let fixed {
            fixed.setTransformMatrix(latestAnchorTransform, relativeTo: nil)
        }
        diagnostics.record("anchor_following_changed", debugSnapshot(), pin: true)
    }

    func unanchor() {
        diagnostics.record("placement_reposition", debugSnapshot(), pin: true)
        initialPlacement = nil
        latestAnchorTransform = nil
        if let arAnchor { view.session.remove(anchor: arAnchor) }
        block.removeFromParent(); fixed?.removeFromParent()
        fixed = nil; arAnchor = nil; locked = false; ready = false; candidate = nil
        preview.addChild(block); block.isEnabled = false
        message = "Aim at the floor to reposition"
    }

    func reset() {
        diagnostics.record("reset_requested", debugSnapshot(), pin: true)
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { start(); return }
        unanchor(); active = false
        view.session.run(ARWorldTrackingConfiguration(), options: [.resetTracking, .removeExistingAnchors])
        start()
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        diagnostics.record("session_error", ["error": error.localizedDescription, "snapshot": debugSnapshot()], pin: true)
        ready = false; candidate = nil; block.isEnabled = false; active = false
        message = "AR session stopped"; detail = error.localizedDescription
    }
    func sessionWasInterrupted(_ session: ARSession) {
        diagnostics.record("session_interrupted", debugSnapshot(), pin: true)
        ready = false; candidate = nil; message = "Session interrupted"; detail = "Return to the app to continue"
    }
    func sessionInterruptionEnded(_ session: ARSession) {
        diagnostics.record("session_interruption_ended", debugSnapshot(), pin: true)
        reset()
    }
    private static var hardwareModel: String {
        var info = utsname(); uname(&info)
        return withUnsafeBytes(of: &info.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    private static func vector(_ v: SIMD3<Float>) -> [Float] { [v.x, v.y, v.z] }
    private static func matrix(_ m: simd_float4x4) -> [Float] {
        (0..<4).flatMap { c in (0..<4).map { r in m[c][r] } }
    }
    private static func position(_ m: simd_float4x4) -> SIMD3<Float> {
        SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
    }
    private static func point(_ m: simd_float4x4, _ p: SIMD3<Float>) -> SIMD3<Float> {
        let result = m * SIMD4(p, 1)
        return SIMD3(result.x, result.y, result.z)
    }
    private func configurationSnapshot(_ config: ARWorldTrackingConfiguration) -> [String: Any] {
        ["lidarRequested": lidar, "occlusionRequested": occlusion,
         "sceneReconstruction": config.sceneReconstruction.rawValue,
         "frameSemantics": config.frameSemantics.rawValue,
         "planeDetection": config.planeDetection.rawValue,
         "realityKitOcclusion": view.environment.sceneUnderstanding.options.contains(.occlusion)]
    }
    private func hitSnapshot(_ hit: ARRaycastResult) -> [String: Any] {
        ["transform": Self.matrix(hit.worldTransform), "target": hit.target.rawValue,
         "alignment": hit.targetAlignment.rawValue, "anchorID": hit.anchor?.identifier.uuidString ?? "none"]
    }

    func debugSnapshot() -> [String: Any] {
        var data: [String: Any] = ["active": active, "locked": locked, "ready": ready,
            "cameraDenied": cameraDenied, "message": message, "widthM": width,
            "rectangleCount": rectangleCount, "lidarRequested": lidar, "occlusionRequested": occlusion,
            "supportsLiDAR": supportsLiDAR, "callbackGapMs": latestFrameGap * 1000,
            "placementOrigin": "camera-facing bottom edge", "followAnchorUpdates": followAnchorUpdates]
        if let aimPointInWindow {
            let point = view.convert(aimPointInWindow, from: nil)
            data["aimScreenPoint"] = ["x": point.x, "y": point.y, "viewWidth": view.bounds.width, "viewHeight": view.bounds.height]
        }
        if let config = view.session.configuration as? ARWorldTrackingConfiguration {
            data["configuration"] = configurationSnapshot(config)
        }
        if let candidate { data["previewTransform"] = Self.matrix(candidate) }
        if let frame = view.session.currentFrame {
            data["frameTimestamp"] = frame.timestamp
            data["cameraTransform"] = Self.matrix(frame.camera.transform)
            data["cameraIntrinsics"] = (0..<3).flatMap { c in (0..<3).map { r in frame.camera.intrinsics[c][r] } }
            data["trackingState"] = String(describing: frame.camera.trackingState)
            data["worldMappingStatus"] = frame.worldMappingStatus.rawValue
            data["depthAvailable"] = frame.sceneDepth != nil
            data["smoothedDepthAvailable"] = frame.smoothedSceneDepth != nil
        }
        if locked, let fixed {
            let current = fixed.transformMatrix(relativeTo: nil)
            data["anchorID"] = arAnchor?.identifier.uuidString ?? "none"
            data["currentPlacementTransform"] = Self.matrix(current)
            data["renderedBlockTransform"] = Self.matrix(block.transformMatrix(relativeTo: nil))
            data["bottomCornersWorld"] = chainCorners(current).map(Self.vector)
            if let initialPlacement {
                data["initialPlacementTransform"] = Self.matrix(initialPlacement)
                let a = Self.position(initialPlacement), b = Self.position(current)
                let initialNormal = simd_normalize(SIMD3(initialPlacement.columns.1.x, initialPlacement.columns.1.y, initialPlacement.columns.1.z))
                let currentNormal = simd_normalize(SIMD3(current.columns.1.x, current.columns.1.y, current.columns.1.z))
                data["poseDelta"] = ["verticalM": b.y - a.y, "translationM": simd_distance(a, b),
                    "normalAngleDeg": acos(min(1, max(-1, simd_dot(initialNormal, currentNormal)))) * 180 / .pi]
            }
        }
        return data
    }

    func setAimPoint(_ point: CGPoint) {
        guard aimPointInWindow != point else { return }
        aimPointInWindow = point
        diagnostics.record("aim_point_changed", ["windowX": point.x, "windowY": point.y])
        if !locked { candidate = nil; ready = false; block.isEnabled = false }
    }

    func markSinking() { diagnostics.record("USER_MARKED_SINKING", debugSnapshot(), pin: true) }
    func exportDiagnostics(_ event: String, maxBytes: Int? = nil) -> (text: String, truncated: Bool) {
        diagnostics.record(event, debugSnapshot(), pin: true)
        return diagnostics.export(maxBytes: maxBytes)
    }

    private func chainBounds() -> (Float, Float) {
        RectangleGeometry.bounds(width: width, count: rectangleCount)
    }
    private func chainCorners(_ pose: simd_float4x4) -> [SIMD3<Float>] {
        RectangleGeometry.bottomCorners(width: width, count: rectangleCount).map { Self.point(pose, $0) }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard active else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let previousFrameTime { latestFrameGap = now - previousFrameTime }
        previousFrameTime = now
        let tracking = String(describing: frame.camera.trackingState)
        if tracking != lastTrackingState {
            diagnostics.record("tracking_changed", ["state": tracking], pin: true)
            lastTrackingState = tracking
        }
        if diagnostics.due("snapshot", interval: 0.2) { diagnostics.record("frame_snapshot", debugSnapshot()) }
        if diagnostics.due("environment", interval: 1) {
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
        if locked, diagnostics.due("surface_probes", interval: 1) { probeSurfaces(frame) }
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        for anchor in anchors where anchor.identifier == arAnchor?.identifier {
            latestAnchorTransform = anchor.transform
            if followAnchorUpdates { fixed?.setTransformMatrix(anchor.transform, relativeTo: nil) }
            diagnostics.record("bound_anchor_updated", ["id": anchor.identifier.uuidString,
                "anchorTransform": Self.matrix(anchor.transform), "snapshot": debugSnapshot()])
        }
    }
    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        for anchor in anchors where anchor.identifier == arAnchor?.identifier {
            diagnostics.record("bound_anchor_found", ["id": anchor.identifier.uuidString,
                "anchorTransform": Self.matrix(anchor.transform)], pin: true)
        }
    }
    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for anchor in anchors where anchor.identifier == arAnchor?.identifier {
            diagnostics.record("bound_anchor_removed", ["id": anchor.identifier.uuidString], pin: true)
        }
    }

    /// Read-only ARKit estimates; never feed results back into placement.
    private func probeSurfaces(_ frame: ARFrame) {
        guard let fixed else { return }
        let pose = fixed.transformMatrix(relativeTo: nil)
        let camera = Self.position(frame.camera.transform)
        let forward = -SIMD3(frame.camera.transform.columns.2.x, frame.camera.transform.columns.2.y, frame.camera.transform.columns.2.z)
        let normal = simd_normalize(SIMD3(pose.columns.1.x, pose.columns.1.y, pose.columns.1.z))
        let bottom = Self.point(pose, [0, 0.001, 0])
        let (left, right) = chainBounds()
        let nearest = (0..<rectangleCount).map { i -> Float in
            i == 0 ? 0 : (i % 2 == 1 ? -1 : 1) * Float((i + 1) / 2) * width
        }.min { simd_distance(camera, Self.point(pose, [$0, 0.001, RectangleGeometry.centerZ(width: width)])) < simd_distance(camera, Self.point(pose, [$1, 0.001, RectangleGeometry.centerZ(width: width)])) } ?? 0
        for (name, x) in [("center", Float(0)), ("leftEnd", left), ("rightEnd", right), ("nearestRectangle", nearest)] {
            let target = Self.point(pose, [x, 0.001, RectangleGeometry.centerZ(width: width)])
            let offset = target - camera, distance = simd_length(offset)
            var data: [String: Any] = ["target": name, "targetWorld": Self.vector(target), "distanceM": distance]
            guard distance >= 0.1, distance <= 8, simd_dot(offset / distance, forward) >= 0.5 else {
                data["skipped"] = "outside 0.1–8 m or 60 degree forward cone"
                diagnostics.record("surface_probe", data); continue
            }
            let query = ARRaycastQuery(origin: camera, direction: offset / distance, allowing: .estimatedPlane, alignment: .any)
            let hits = view.session.raycast(query)
            data["hitCount"] = hits.count
            data["hits"] = hits.prefix(32).map { hit -> [String: Any] in
                var result = hitSnapshot(hit)
                let position = Self.position(hit.worldTransform)
                result["normalClearanceM"] = simd_dot(normal, bottom - position)
                result["targetErrorM"] = simd_distance(position, target)
                return result
            }
            diagnostics.record("surface_probe", data)
        }
    }

}

struct CameraView: UIViewRepresentable {
    let model: PlacementModel
    func makeUIView(context: Context) -> ARView { model.view }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct ContentView: View {
    @StateObject private var model = PlacementModel()
    @Environment(\.scenePhase) private var phase
    @State private var diagnosticsPresented = false
    @State private var sinkingMarked = false
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                CameraView(model: model).ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom).ignoresSafeArea().allowsHitTesting(false)
                VStack(spacing: 16) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("FLOOR FRAME").font(.system(.headline, design: .rounded)).tracking(2)
                            Text(model.locked ? "FIXED IN YOUR SPACE" : "SURFACE PREVIEW").font(.caption2).tracking(1.5).foregroundStyle(.white.opacity(0.65))
                        }
                        Spacer()
                        Button(action: model.reset) { Image(systemName: "arrow.counterclockwise").padding(13).background(.ultraThinMaterial, in: Circle()) }
                            .accessibilityLabel("Reset scan").accessibilityIdentifier("reset")
                    }
                    Color.clear
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .overlay {
                            Image(systemName: model.locked ? "lock.fill" : "plus")
                                .font(.system(size: 25, weight: .light))
                                .foregroundStyle(model.ready || model.locked ? Color.mint : .white)
                                .shadow(radius: 4).accessibilityHidden(true)
                        }
                        .background {
                            GeometryReader { target in
                                Color.clear.preference(key: AimPointPreference.self, value: target.frame(in: .global))
                            }
                        }
                        .allowsHitTesting(false)
                    VStack(spacing: 14) {
                        HStack {
                            Button("Mark sinking now") { model.markSinking(); sinkingMarked = true }
                                .accessibilityIdentifier("markSinking")
                            Button("Debug logs") { diagnosticsPresented = true }
                                .accessibilityIdentifier("debugLogs")
                        }.buttonStyle(.bordered).tint(.mint).controlSize(.regular)

                        VStack(spacing: 5) {
                            Label(model.message, systemImage: model.locked ? "checkmark.circle.fill" : (model.ready ? "scope" : "viewfinder"))
                                .font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
                            Text(model.detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }.accessibilityIdentifier("placementStatus")
                        Picker("Rectangle width", selection: $model.large) {
                            Text("20 cm wide").tag(false)
                            Text("3 m wide").tag(true)
                        }.pickerStyle(.segmented).accessibilityIdentifier("widthPicker")
                            .onChange(of: model.large) { _, _ in model.rebuildBlock() }
                        Stepper("Rectangles: \(model.rectangleCount)", value: $model.rectangleCount, in: 1...51)
                            .font(.subheadline).accessibilityIdentifier("rectangleCountStepper")
                            .onChange(of: model.rectangleCount) { _, _ in model.rebuildBlock() }
                        Toggle("Follow anchor updates", isOn: $model.followAnchorUpdates)
                            .font(.subheadline).tint(.mint)
                            .accessibilityIdentifier("followAnchorToggle")
                            .onChange(of: model.followAnchorUpdates) { _, _ in model.changeAnchorFollowing() }
                        Toggle("Occlusion", isOn: $model.occlusion)
                            .font(.subheadline).tint(.mint)
                            .disabled(!model.supportsLiDAR)
                            .accessibilityIdentifier("occlusionToggle")
                            .onChange(of: model.occlusion) { _, _ in model.changeOcclusion() }
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("LiDAR mesh").font(.subheadline.weight(.medium))
                                Text(model.supportsLiDAR ? (model.lidar ? "Depth-assisted surfaces" : (model.occlusion ? "Mesh active for occlusion" : "Standard ARKit surfaces")) : "Unavailable · using standard ARKit").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Toggle("LiDAR mesh", isOn: $model.lidar).labelsHidden().tint(.mint)
                                .disabled(!model.supportsLiDAR || model.locked || model.cameraDenied)
                                .accessibilityIdentifier("lidarToggle")
                                .onChange(of: model.lidar) { _, _ in model.changeMode() }
                        }
                        Text(model.dimensions).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        if model.cameraDenied {
                            Button("Open Camera Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }.buttonStyle(.borderedProminent).tint(.mint)
                        } else {
                            Button(action: { model.locked ? model.unanchor() : model.anchor() }) {
                                Label(model.locked ? "Reposition" : "Anchor rectangle", systemImage: model.locked ? "move.3d" : "pin.fill")
                                    .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 9)
                            }.buttonStyle(.borderedProminent).tint(.mint).foregroundStyle(.black)
                                .disabled(!model.locked && !model.ready).accessibilityIdentifier("anchorButton")
                        }
                    }
                    .padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26))
                    .frame(maxWidth: 440)
                }
                .padding(.horizontal, 20).padding(.vertical, geometry.size.height < 500 ? 4 : 12)
            }
        }
        .onPreferenceChange(AimPointPreference.self) { frame in
            if frame.width > 0 && frame.height > 0 { model.setAimPoint(CGPoint(x: frame.midX, y: frame.midY)) }
        }
        .sheet(isPresented: $diagnosticsPresented) { DiagnosticsPanel(model: model) }
        .alert("Sinking marked", isPresented: $sinkingMarked) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Timestamp and current placement saved. Use Debug logs to copy or share the capture.")
        }
        .preferredColorScheme(.dark)
        .onAppear { model.start() }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .active { model.start() }
            else { model.pause() }
        }
    }
}

private struct AimPointPreference: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}
