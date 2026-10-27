import simd

/// IMPLEMENTATION_PLAN section 5 sampling adapter: bounded batches stored in
/// the calibration reference (anchor) frame, tagged with batch and coordinate
/// epoch so stale batches are rejected by the fit. Port of
/// floor-frame-viro/src/calibrationSampler.ts.
enum CalibrationSampler {
    /// Screen-fraction sample grid within the aim area (0..1).
    static func grid(size: Int) -> [(Double, Double)] {
        (0..<size).flatMap { row in
            (0..<size).map { col in
                (0.1 + 0.8 * Double(col) / Double(size - 1), 0.1 + 0.8 * Double(row) / Double(size - 1))
            }
        }
    }
}

struct ReferenceSample {
    var point: Vec3
    var camera: Vec3
    var source: String
    var captureTimestamp: Double?
    var confidence: Double?
}

/// Accumulates samples in the reference frame and keeps the fit history.
final class CalibrationSession {
    let origin: Vec3
    let heading: Vec3
    let gravityUp: Vec3
    let epoch: Int
    private(set) var observations: [FloorCalibration.Observation] = []
    private(set) var batch = 0
    private var history: [(time: Double, inclination: Double)] = []
    private(set) var last: FloorCalibration.Result?
    private(set) var gridSize = 5

    init(origin: Vec3, heading: Vec3, gravityUp: Vec3, epoch: Int) {
        self.origin = origin; self.heading = heading; self.gravityUp = gravityUp; self.epoch = epoch
    }

    @discardableResult
    func addBatch(_ samples: [ReferenceSample], now: Double, durationS: Double) -> Int {
        batch += 1
        for s in samples {
            observations.append(.init(point: s.point, camera: s.camera, source: s.source, batch: batch, epoch: epoch,
                                      receivedTimestamp: now, captureTimestamp: s.captureTimestamp, confidence: s.confidence))
        }
        if observations.count > FloorCalibration.maxObservations {
            observations = Array(observations.suffix(FloorCalibration.maxObservations))
        }
        // Adaptive reduction on slow devices; recover once batches are fast again.
        gridSize = durationS > 0.3 ? 3 : durationS < 0.15 ? 5 : gridSize
        return batch
    }

    func fit(now: Double) -> FloorCalibration.Result {
        history = history.filter { now - $0.time <= FloorCalibration.stabilityWindowS }
        let result = FloorCalibration.fit(observations: observations, origin: origin, heading: heading,
                                          gravityUp: gravityUp, epoch: epoch, recentInclinations: history.map(\.inclination))
        if let inclination = result.alongRowInclination, result.status != .insufficient {
            history.append((now, inclination))
        }
        last = result
        return result
    }
}
