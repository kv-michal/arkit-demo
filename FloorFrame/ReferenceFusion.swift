import Foundation
import simd

/// IMPLEMENTATION_PLAN section 8: fuse accepted marker observations into one
/// rigid world-from-survey transform. Quaternion averaging, never Euler.
/// Port of referenceFusion.ts.
enum ReferenceFusion {
    static let maxAgeS = 0.5
    static let outlierPositionM = 0.1
    static let outlierRotationDeg = 2.0

    struct Observation {
        let id: String
        let worldFromMarker: Mat4
        /// Receipt time in seconds.
        let timestamp: Double
        let epoch: Int
        let tracking: Bool
    }
    struct Result {
        var worldFromSurvey: Mat4?
        var used: [String] = []
        var rejected: [(id: String, reason: String)] = []
        var residuals: [(id: String, positionM: Double, rotationDeg: Double)] = []
        var validation: [(id: String, positionM: Double, rotationDeg: Double)] = []
        var observability = "none"
        var weights: [String: Double] = [:]

        var dictionary: [String: Any] {
            ["worldFromSurvey": worldFromSurvey.map(MatrixMath.array) ?? NSNull(), "used": used,
             "rejected": rejected.map { ["id": $0.id, "reason": $0.reason] },
             "residuals": residuals.map { ["id": $0.id, "positionM": $0.positionM, "rotationDeg": $0.rotationDeg] },
             "validation": validation.map { ["id": $0.id, "positionM": $0.positionM, "rotationDeg": $0.rotationDeg] },
             "observability": observability, "weights": weights]
        }
    }

    static func fuse(manifest: SurveyManifest, observations: [Observation], now: Double, epoch: Int) -> Result {
        var result = Result()
        // One observation per board: repeated correlated callbacks must not add confidence.
        var latest: [String: Observation] = [:]
        for o in observations where latest[o.id].map({ o.timestamp >= $0.timestamp }) ?? true { latest[o.id] = o }
        struct Candidate { let id: String; let matrix: Mat4; let weightP: Double; let weightR: Double }
        var candidates: [Candidate] = []
        for id in latest.keys.sorted() {
            let o = latest[id]!
            guard let reference = manifest.references.first(where: { $0.id == id }) else { result.rejected.append((id, "unknown id")); continue }
            if reference.role != .correction { continue }
            if o.epoch != epoch { result.rejected.append((id, "stale epoch")); continue }
            if !o.tracking { result.rejected.append((id, "not tracking")); continue }
            if now - o.timestamp > maxAgeS { result.rejected.append((id, "stale observation")); continue }
            if !MatrixMath.isRigid(MatrixMath.array(o.worldFromMarker), tolerance: 1e-3) { result.rejected.append((id, "non-rigid pose")); continue }
            candidates.append(Candidate(id: id, matrix: o.worldFromMarker * MatrixMath.inverseRigid(reference.surveyFromMarker),
                                        weightP: 1 / pow(reference.positionUncertaintyM, 2),
                                        weightR: 1 / pow(reference.rotationUncertaintyDeg, 2)))
        }
        var accepted = candidates
        if candidates.count >= 2 {
            // Most central candidate as robust reference; reject boards that disagree with it.
            func cost(_ c: Candidate) -> Double {
                candidates.reduce(0) { sum, other in
                    let d = MatrixMath.difference(c.matrix, other.matrix)
                    return sum + d.positionM / outlierPositionM + d.rotationDeg / outlierRotationDeg
                }
            }
            let center = candidates.sorted { cost($0) != cost($1) ? cost($0) < cost($1) : $0.id < $1.id }[0]
            accepted = candidates.filter { c in
                let d = MatrixMath.difference(center.matrix, c.matrix)
                let ok = d.positionM <= outlierPositionM && d.rotationDeg <= outlierRotationDeg
                if !ok { result.rejected.append((c.id, "inconsistent with other boards")) }
                return ok
            }
            if candidates.count == 2 && accepted.count < 2 {
                result.rejected += accepted.map { ($0.id, "two boards disagree") }
                accepted = []
            }
        }
        guard !accepted.isEmpty else { return result }
        let totalP = accepted.reduce(0) { $0 + $1.weightP }, totalR = accepted.reduce(0) { $0 + $1.weightR }
        let position = accepted.reduce(Vec3.zero) { $0 + MatrixMath.position($1.matrix) * $1.weightP } / totalP
        let reference = MatrixMath.quaternion(accepted[0].matrix)
        var q = SIMD4<Double>.zero
        for c in accepted {
            let qi = MatrixMath.quaternion(c.matrix)
            let sign: Double = simd_dot(qi, reference) < 0 ? -1 : 1
            q += sign * qi * (c.weightR / totalR)
        }
        guard let fused = MatrixMath.matrix(position: position, quaternion: q) else { return result }
        result.worldFromSurvey = fused
        result.used = accepted.map(\.id)
        result.weights = Dictionary(uniqueKeysWithValues: accepted.map { ($0.id, $0.weightP / totalP) })
        result.observability = accepted.count >= 2 ? "multi-board" : "single-board"
        result.residuals = accepted.map { c in let d = MatrixMath.difference(fused, c.matrix); return (c.id, d.positionM, d.rotationDeg) }
        // Held-out boards never drive the pose; they only report validation residuals.
        for (id, o) in latest.sorted(by: { $0.key < $1.key }) {
            guard let reference = manifest.references.first(where: { $0.id == id }), reference.role == .heldOutValidation, o.epoch == epoch else { continue }
            let d = MatrixMath.difference(fused * reference.surveyFromMarker, o.worldFromMarker)
            result.validation.append((id, d.positionM, d.rotationDeg))
        }
        return result
    }
}
