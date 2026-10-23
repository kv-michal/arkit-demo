import ExpoModulesCore
import ARKit

public class FloorFrameSessionModule: Module {
  private weak var session: ARSession?
  private var lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
  private var occlusion = false
  private var anchor: ARAnchor?

  public func definition() -> ModuleDefinition {
    Name("FloorFrameSession")
    Constant("supportsLiDAR") { ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) }

    AsyncFunction("configure") { (lidar: Bool, reset: Bool, occlusion: Bool) in
      self.lidar = lidar
      self.occlusion = occlusion
      if reset { self.anchor = nil }
      if let session = FFSessionAccess.currentSession() {
        self.session = session
        self.configure(session, reset: reset)
      }
    }.runOnQueue(.main)

    AsyncFunction("sample") { () -> [String: Any] in
      guard let session = FFSessionAccess.currentSession(), let frame = session.currentFrame else {
        return ["status": "starting"]
      }
      if self.session !== session {
        self.session = session
        self.anchor = nil
        self.configure(session, reset: false)
        return ["status": "starting"]
      }
      // Viro can re-run its own saved configuration on foregrounding. Restore
      // the selected mesh mode on the same session without resetting anchors.
      let wanted: ARConfiguration.SceneReconstruction = (self.lidar || self.occlusion) && ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) ? .mesh : []
      if let config = session.configuration as? ARWorldTrackingConfiguration,
         config.sceneReconstruction != wanted {
        self.configure(session, reset: false)
      }
      guard case .normal = frame.camera.trackingState else { return ["status": "tracking"] }
      if let anchor = self.anchor {
        guard let tracked = frame.anchors.first(where: { $0.identifier == anchor.identifier }) else {
          return ["status": "anchorPending"]
        }
        return ["status": "anchored", "matrix": self.flatten(tracked.transform)]
      }
      let cameraTransform = frame.camera.transform
      let camera = SIMD3<Float>(cameraTransform.columns.3.x, cameraTransform.columns.3.y, cameraTransform.columns.3.z)
      let direction = -SIMD3<Float>(cameraTransform.columns.2.x, cameraTransform.columns.2.y, cameraTransform.columns.2.z)
      let query = ARRaycastQuery(origin: camera, direction: direction, allowing: .estimatedPlane, alignment: .any)
      guard let hit = session.raycast(query).first else { return ["status": "noSurface"] }
      return ["status": "hit", "matrix": self.flatten(hit.worldTransform), "camera": [camera.x, camera.y, camera.z]]
    }.runOnQueue(.main)

    AsyncFunction("anchor") { (values: [Float]) -> Bool in
      guard values.count == 16, values.allSatisfy({ $0.isFinite }), let session = self.session,
            let frame = session.currentFrame, case .normal = frame.camera.trackingState else { return false }
      self.removeAnchor()
      let matrix = simd_float4x4(columns: (
        SIMD4(values[0], values[1], values[2], values[3]),
        SIMD4(values[4], values[5], values[6], values[7]),
        SIMD4(values[8], values[9], values[10], values[11]),
        SIMD4(values[12], values[13], values[14], values[15])
      ))
      let anchor = ARAnchor(name: "FloorFrameViro", transform: matrix)
      self.anchor = anchor
      session.add(anchor: anchor)
      return true
    }.runOnQueue(.main)

    AsyncFunction("unanchor") { self.removeAnchor() }.runOnQueue(.main)
    OnDestroy { [weak self] in
      DispatchQueue.main.async { self?.removeAnchor() }
    }
  }

  private func configure(_ session: ARSession, reset: Bool) {
    let config = (session.configuration?.copy() as? ARWorldTrackingConfiguration) ?? ARWorldTrackingConfiguration()
    config.planeDetection = [.horizontal]
    config.environmentTexturing = .automatic
    config.sceneReconstruction = (lidar || occlusion) && ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) ? .mesh : []
    // Keep Viro's depth renderer supplied when it reconfigures the shared session.
    if occlusion && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
      config.frameSemantics.insert(.sceneDepth)
    } else {
      config.frameSemantics = []
    }
    session.run(config, options: reset ? [.resetTracking, .removeExistingAnchors] : [])
  }
  private func removeAnchor() {
    if let anchor { session?.remove(anchor: anchor) }
    anchor = nil
  }
  private func flatten(_ m: simd_float4x4) -> [Float] {
    (0..<4).flatMap { c in (0..<4).map { r in m[c][r] } }
  }
}
