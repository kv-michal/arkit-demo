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
    private var candidate: simd_float4x4?
    private var lastUpdate: TimeInterval = 0
    private var active = false
    var width: Float { large ? 3 : 0.2 }
    var dimensions: String { large ? "3 × 1.35 × 1.5 m" : "20 × 9 × 10 cm" }

    override init() {
        super.init()
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
        active = true
        cameraDenied = false
    }

    func pause() { view.session.pause(); active = false; ready = false; candidate = nil }

    func changeMode() {
        unanchor()
        // Reset because old mesh anchors must not influence camera-only placement.
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        config.environmentTexturing = .automatic
        config.sceneReconstruction = (lidar || occlusion) && supportsLiDAR ? .mesh : []
        view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        active = true
        message = "Scan the floor again"
    }

    func changeOcclusion() {
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
        // Opaque bounding edges, including the underside, reveal floor penetration.
        let depth = width * 0.45
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
    }

    private func updatePreview() {
        guard active, !locked, CACurrentMediaTime() - lastUpdate > 1.0 / 20 else { return }
        lastUpdate = CACurrentMediaTime()
        guard let frame = view.session.currentFrame else { return }
        guard case .normal = frame.camera.trackingState else {
            invalidate("Move slowly · tracking the room"); return
        }
        let point = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        guard let query = view.makeRaycastQuery(from: point, allowing: .estimatedPlane, alignment: .any),
              let hit = view.session.raycast(query).first else {
            invalidate("Aim at a textured floor and move slowly"); return
        }
        var normal = simd_normalize(SIMD3<Float>(hit.worldTransform.columns.1.x, hit.worldTransform.columns.1.y, hit.worldTransform.columns.1.z))
        if normal.y < 0 { normal = -normal }
        // Accept walkable inclines up to 60 degrees; reject walls and ceilings.
        let position = SIMD3<Float>(hit.worldTransform.columns.3.x, hit.worldTransform.columns.3.y, hit.worldTransform.columns.3.z)
        let camera = SIMD3<Float>(frame.camera.transform.columns.3.x, frame.camera.transform.columns.3.y, frame.camera.transform.columns.3.z)
        guard let transform = SurfacePose.make(position: position, normal: normal, camera: camera) else {
            invalidate("Point down at a floor or slope"); return
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
        candidate = nil; ready = false; block.isEnabled = false
        message = text; detail = "Aim the center target at a floor or slope"
    }

    func anchor() {
        guard ready, let transform = candidate, !locked else { return }
        let anchor = ARAnchor(name: "FloorFrame", transform: transform)
        view.session.add(anchor: anchor)
        let entity = AnchorEntity(anchor: anchor)
        arAnchor = anchor; fixed = entity
        view.scene.addAnchor(entity)
        block.removeFromParent(); entity.addChild(block)
        locked = true
        message = "Anchored in place"
        detail = "Walk around it · tap Reposition to move it"
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    func unanchor() {
        if let arAnchor { view.session.remove(anchor: arAnchor) }
        block.removeFromParent(); fixed?.removeFromParent()
        fixed = nil; arAnchor = nil; locked = false; ready = false; candidate = nil
        preview.addChild(block); block.isEnabled = false
        message = "Aim at the floor to reposition"
    }

    func reset() {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { start(); return }
        unanchor(); active = false
        view.session.run(ARWorldTrackingConfiguration(), options: [.resetTracking, .removeExistingAnchors])
        start()
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        ready = false; candidate = nil; block.isEnabled = false; active = false
        message = "AR session stopped"; detail = error.localizedDescription
    }
    func sessionWasInterrupted(_ session: ARSession) {
        ready = false; candidate = nil; message = "Session interrupted"; detail = "Return to the app to continue"
    }
    func sessionInterruptionEnded(_ session: ARSession) { reset() }
}

struct CameraView: UIViewRepresentable {
    let model: PlacementModel
    func makeUIView(context: Context) -> ARView { model.view }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct ContentView: View {
    @StateObject private var model = PlacementModel()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                CameraView(model: model).ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom).ignoresSafeArea().allowsHitTesting(false)
                Image(systemName: model.locked ? "lock.fill" : "plus")
                    .font(.system(size: 25, weight: .light)).foregroundStyle(model.ready || model.locked ? Color.mint : .white)
                    .shadow(radius: 4).accessibilityHidden(true)
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
                    Spacer()
                    VStack(spacing: 14) {
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
        .preferredColorScheme(.dark)
        .onAppear { model.start() }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .active { model.start() }
            else { model.pause() }
        }
    }
}
