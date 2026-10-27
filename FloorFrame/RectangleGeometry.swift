import simd

/// The aimed surface point is the middle of the camera-facing bottom edge.
/// Local +Z faces the viewer, so the entire footprint extends along -Z.
enum RectangleGeometry {
    static func depth(width: Float) -> Float { width * 0.45 }
    static func centerZ(width: Float) -> Float { -depth(width: width) / 2 }
    static func offset(index: Int, width: Float) -> Float {
        index == 0 ? 0 : (index % 2 == 1 ? -1 : 1) * Float((index + 1) / 2) * width
    }
    static func bounds(width: Float, count: Int) -> (Float, Float) {
        let offsets = (0..<count).map { offset(index: $0, width: width) }
        return ((offsets.min() ?? 0) - width / 2, (offsets.max() ?? 0) + width / 2)
    }
    static func bottomCorners(width: Float, count: Int) -> [SIMD3<Float>] {
        let (left, right) = bounds(width: width, count: count)
        return [left, right].flatMap { x in [-depth(width: width), 0].map { z in SIMD3(x, 0.001, z) } }
    }
}
