import Foundation
import simd

/// IMPLEMENTATION_PLAN section 7: candidate gated rigid height correction.
/// Unadopted experiment; port of heightCorrection.ts. One shared gravity-axis
/// offset for the whole row, applied only in the explicitly selected
/// experimental mode and always zero otherwise. Constants are untuned proposals.
final class HeightCorrector {
    static let windowS = 3.0
    static let minResiduals = 3
    static let minCycles = 2
    static let minDenominator = 0.5
    static let maxNormalAngleDeg = 10.0
    static let maxTargetMissM = 0.5
    static let maxResidualM = 0.3
    static let deadbandM = 0.005
    static let rateMPerS = 0.02
    static let capM = 0.25

    struct Observation {
        var point: Vec3
        var normal: Vec3?
        var source: String
        var targetMissM: Double
        var cycle: Int
    }
    struct Update {
        var residuals: [(source: String, residualM: Double, cycle: Int)] = []
        var rejected: [(source: String, reason: String)] = []
        var proposedDeltaM: Double?
        var appliedDeltaM = 0.0
        var applying = false
        var stale = false
        var windowCount = 0

        var dictionary: [String: Any] {
            ["residuals": residuals.map { ["source": $0.source, "residualM": $0.residualM, "cycle": $0.cycle] },
             "rejected": rejected.map { ["source": $0.source, "reason": $0.reason] },
             "proposedDeltaM": proposedDeltaM.map { $0 as Any } ?? NSNull(), "appliedDeltaM": appliedDeltaM,
             "applying": applying, "stale": stale, "windowCount": windowCount]
        }
    }

    private var window: [(time: Double, residual: Double, cycle: Int)] = []
    private(set) var appliedDeltaM = 0.0
    private(set) var stale = false
    private var lastTime: Double?

    /// Gravity-axis offset that raises the plane (local y = 0 of base) to p.
    static func residual(base: Mat4, point: Vec3, gravityUp: Vec3 = MatrixMath.gravityUp) -> Double? {
        let n = simd_normalize(MatrixMath.axis(base, 1))
        let denominator = simd_dot(n, simd_normalize(gravityUp))
        guard denominator > minDenominator else { return nil }
        return simd_dot(n, point - MatrixMath.position(base)) / denominator
    }
    static func corrected(base: Mat4, appliedDeltaM: Double, gravityUp: Vec3 = MatrixMath.gravityUp) -> Mat4 {
        appliedDeltaM == 0 ? base : MatrixMath.translation(simd_normalize(gravityUp) * appliedDeltaM) * base
    }

    /// Clears offsets; required on a new commit or placement-mode change.
    func reset() { window = []; appliedDeltaM = 0; stale = false; lastTime = nil }
    /// Tracking/reference loss: stop updating and drop the old coordinate epoch.
    func markStale() { stale = true; window = []; lastTime = nil }

    func update(base: Mat4, observations: [Observation], now: Double, apply: Bool,
                gravityUp: Vec3 = MatrixMath.gravityUp) -> Update {
        let rowNormal = simd_normalize(MatrixMath.axis(base, 1))
        var update = Update()
        for o in observations {
            func reject(_ reason: String) { update.rejected.append((o.source, reason)) }
            guard o.point.x.isFinite, o.point.y.isFinite, o.point.z.isFinite else { reject("non-finite"); continue }
            if o.source == "FeaturePoint" { reject("feature point has no surface"); continue }
            if o.targetMissM > Self.maxTargetMissM { reject("depth discontinuity / target miss"); continue }
            if let normal = o.normal, abs(simd_dot(simd_normalize(normal), rowNormal)) < cos(Self.maxNormalAngleDeg * .pi / 180) {
                reject("normal disagrees with committed floor"); continue
            }
            guard let residual = Self.residual(base: base, point: o.point, gravityUp: gravityUp) else {
                reject("insufficient upward denominator"); continue
            }
            if abs(residual) > Self.maxResidualM { reject("residual exceeds gate"); continue }
            update.residuals.append((o.source, residual, o.cycle))
            window.append((now, residual, o.cycle))
        }
        window = window.filter { now - $0.time <= Self.windowS }
        let cycles = Set(window.map(\.cycle)).count
        if window.count >= Self.minResiduals && cycles >= Self.minCycles {
            let sorted = window.map(\.residual).sorted()
            let mid = sorted.count / 2
            update.proposedDeltaM = sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
            // Recovered epoch: enough fresh residuals after a loss.
            stale = false
        }
        let dt = lastTime.map { min(1, max(0, now - $0)) } ?? 0
        lastTime = now
        if !apply {
            appliedDeltaM = 0
        } else if let proposed = update.proposedDeltaM, !stale {
            let target = max(-Self.capM, min(Self.capM, proposed))
            let difference = target - appliedDeltaM
            if abs(difference) >= Self.deadbandM {
                let step = Self.rateMPerS * dt
                appliedDeltaM += max(-step, min(step, difference))
            }
        }
        update.appliedDeltaM = appliedDeltaM
        update.applying = apply
        update.stale = stale
        update.windowCount = window.count
        return update
    }
}
