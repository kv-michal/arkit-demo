import simd

/// IMPLEMENTATION_PLAN section 8: preserves the committed survey-relative row
/// and drives one root. Surveyed floor control defines floor tilt and origin
/// height; the user supplies yaw only. Phone floor observations never feed
/// this controller's pose. Port of referenceFrameController.ts.
final class ReferenceFrameController {
    enum State: String { case unavailable, searching, tracking, stale, inconsistent }

    let manifest: SurveyManifest?
    private(set) var observations: [String: ReferenceFusion.Observation] = [:]
    private(set) var state: State
    private(set) var worldFromSurvey: Mat4?
    private(set) var surveyFromRow: Mat4?
    private(set) var anchorFromSurvey: Mat4?
    private(set) var lastFusion: ReferenceFusion.Result?

    init(manifest: SurveyManifest?) {
        self.manifest = manifest
        state = manifest == nil ? .unavailable : .searching
    }

    func observe(_ observation: ReferenceFusion.Observation) { observations[observation.id] = observation }

    func remove(_ id: String) {
        guard let o = observations[id] else { return }
        observations[id] = .init(id: o.id, worldFromMarker: o.worldFromMarker, timestamp: o.timestamp, epoch: o.epoch, tracking: false)
    }

    func reset() {
        observations = [:]; worldFromSurvey = nil; surveyFromRow = nil; anchorFromSurvey = nil; lastFusion = nil
        state = manifest == nil ? .unavailable : .searching
    }

    /// New commit or reposition: drop the row relation, keep board observations.
    func clearPlacement() { surveyFromRow = nil; anchorFromSurvey = nil }

    @discardableResult
    func update(now: Double, epoch: Int, worldFromAnchorNow: Mat4?) -> State {
        guard let manifest else { state = .unavailable; return state }
        let fusion = ReferenceFusion.fuse(manifest: manifest, observations: Array(observations.values), now: now, epoch: epoch)
        lastFusion = fusion
        if let fused = fusion.worldFromSurvey {
            worldFromSurvey = fused
            if let anchor = worldFromAnchorNow { anchorFromSurvey = MatrixMath.inverseRigid(anchor) * fused }
            state = .tracking
            return state
        }
        let disagreement = fusion.rejected.contains { $0.reason.contains("disagree") || $0.reason.contains("inconsistent") }
        // Transport through the ordinary anchor only while its survey relation is known.
        if let anchorFromSurvey, let anchor = worldFromAnchorNow { worldFromSurvey = anchor * anchorFromSurvey }
        state = disagreement ? .inconsistent : (worldFromSurvey == nil ? .searching : .stale)
        return state
    }

    enum Placement { case placed(Mat4), rejected(String) }

    /// Row placement in the survey frame from an aimed world point and camera.
    func placeRow(hitWorld: Vec3, cameraWorld: Vec3) -> Placement {
        guard let manifest else { return .rejected("no survey loaded") }
        guard state == .tracking, let worldFromSurvey else { return .rejected("survey boards not tracked") }
        let surveyFromWorld = MatrixMath.inverseRigid(worldFromSurvey)
        let hit = MatrixMath.transform(surveyFromWorld, hitWorld)
        let camera = MatrixMath.transform(surveyFromWorld, cameraWorld)
        let g = MatrixMath.rotate(surveyFromWorld, MatrixMath.gravityUp)
        let normal = manifest.floor.normal, point = manifest.floor.point
        let denominator = simd_dot(normal, g)
        guard denominator > 0.5 else { return .rejected("survey floor too steep for gravity") }
        let origin = hit + g * (simd_dot(normal, point - hit) / denominator)
        let offset = origin - point
        guard simd_length(offset - normal * simd_dot(offset, normal)) <= manifest.floor.extentRadiusM else {
            return .rejected("outside surveyed floor extent")
        }
        guard let heading = SurfacePose.horizontalHeading(origin: origin, camera: camera, gravityUp: g),
              let frame = SurfacePose.rowFrame(origin: origin, normal: normal, heading: heading, gravityUp: g) else {
            return .rejected("row orientation undefined")
        }
        return .placed(frame.matrix)
    }

    func commit(surveyFromRow: Mat4, worldFromAnchorNow: Mat4?) {
        self.surveyFromRow = surveyFromRow
        if let worldFromSurvey, let anchor = worldFromAnchorNow {
            anchorFromSurvey = MatrixMath.inverseRigid(anchor) * worldFromSurvey
        }
    }

    var worldFromRow: Mat4? {
        guard let worldFromSurvey, let surveyFromRow else { return nil }
        return worldFromSurvey * surveyFromRow
    }
}
