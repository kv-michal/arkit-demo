/// Purple spheres at hit-test results so the user can see where rays landed:
/// the current preview hit, accumulated calibration samples, and the latest
/// locked surface-probe cycle. Display only; never used for placement.
/// Port of floor-frame-viro/src/hitMarkers.ts.
struct HitMarkerBuffer {
    static let maxCalibration = 200
    static let maxTotal = 256
    static func radius(width: Double) -> Double { width >= 1 ? 0.03 : 0.012 }

    private var preview: [Vec3] = []
    private var calibration: [Vec3] = []
    private var probe: [Vec3] = []
    private(set) var version = 0

    private static func finite(_ points: [Vec3]) -> [Vec3] {
        points.filter { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }
    }
    mutating func setPreview(_ points: [Vec3]) { preview = Self.finite(points); version += 1 }
    mutating func addCalibration(_ points: [Vec3]) {
        calibration = Array((calibration + Self.finite(points)).suffix(Self.maxCalibration)); version += 1
    }
    mutating func setProbes(_ points: [Vec3]) { probe = Self.finite(points); version += 1 }
    mutating func clear() { preview = []; calibration = []; probe = []; version += 1 }
    var all: [Vec3] { Array((calibration + probe + preview).suffix(Self.maxTotal)) }
}
