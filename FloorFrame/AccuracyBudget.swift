import Foundation

/// IMPLEMENTATION_PLAN section 1. Proposed evaluation targets, not measured
/// capabilities or user-approved product tolerances. Port of accuracyBudget.ts.
struct AccuracyBudget {
    static let horizontalM = 0.2
    static let largeVerticalM = 0.02
    static let smallVerticalM = 0.005
    static let horizontalRotationShareM = 0.05

    let width: Double
    let rectangleCount: Int
    let radiusM: Double
    let verticalLimitM: Double
    let verticalAngleAllocationM: Double
    let verticalAngleAllowanceDeg: Double
    let horizontalRotationAllowanceDeg: Double

    init(width: Double, rectangleCount: Int) {
        self.width = width
        self.rectangleCount = rectangleCount
        radiusM = Self.farthestRadius(width: width, count: rectangleCount)
        verticalLimitM = width >= 1 ? Self.largeVerticalM : Self.smallVerticalM
        verticalAngleAllocationM = verticalLimitM / 2
        verticalAngleAllowanceDeg = Self.rotationAllowanceDeg(verticalAngleAllocationM, radiusM)
        horizontalRotationAllowanceDeg = Self.rotationAllowanceDeg(Self.horizontalRotationShareM, radiusM)
    }

    /// Farthest vertex of the rendered row from the placement origin.
    static func farthestRadius(width: Double, count: Int) -> Double {
        let offsets = (0..<max(1, count)).map { i in i == 0 ? 0 : (i % 2 == 1 ? -1.0 : 1.0) * Double((i + 1) / 2) * width }
        var radius = 0.0
        for x in [offsets.min()! - width / 2, offsets.max()! + width / 2] {
            for y in [0.001, width * 0.5 + 0.001] {
                for z in [-width * 0.45, 0] { radius = max(radius, (x * x + y * y + z * z).squareRoot()) }
            }
        }
        return radius
    }
    /// rotationAllowance = 2 * asin(displacement / (2R)), degrees.
    static func rotationAllowanceDeg(_ displacementM: Double, _ radiusM: Double) -> Double {
        guard radiusM > 0 else { return .infinity }
        return 2 * asin(min(1, displacementM / (2 * radiusM))) * 180 / .pi
    }
    /// Slope-independent bound on displacement from a rotation error, metres.
    static func rotationDisplacementM(_ errorDeg: Double, _ radiusM: Double) -> Double {
        2 * radiusM * sin(errorDeg * .pi / 360)
    }

    func summary(uncertaintyDeg: Double? = nil) -> String {
        let base = String(format: "Reach %.1f m · height budget ±%.3f°", radiusM, verticalAngleAllowanceDeg)
        guard let uncertaintyDeg, uncertaintyDeg.isFinite else { return "\(base) · precision unverified" }
        let within = uncertaintyDeg <= verticalAngleAllowanceDeg
        return "\(base) · fit ±\(String(format: "%.3f", uncertaintyDeg))° \(within ? "inside" : "exceeds") · unverified"
    }

    var dictionary: [String: Any] {
        ["width": width, "rectangleCount": rectangleCount, "radiusM": radiusM, "verticalLimitM": verticalLimitM,
         "verticalAngleAllocationM": verticalAngleAllocationM, "verticalAngleAllowanceDeg": verticalAngleAllowanceDeg,
         "horizontalRotationAllowanceDeg": horizontalRotationAllowanceDeg]
    }
}
