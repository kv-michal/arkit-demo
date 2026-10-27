import simd

typealias Vec3 = SIMD3<Double>
typealias Mat4 = simd_double4x4

/// Rigid-transform helpers shared by placement, calibration and survey code.
/// Matrices are column-major, matching the TypeScript `number[16]` layout.
enum MatrixMath {
    static let gravityUp = Vec3(0, 1, 0)
    static let identity = matrix_identity_double4x4

    static func array(_ m: Mat4) -> [Double] {
        (0..<4).flatMap { c in (0..<4).map { r in m[c][r] } }
    }
    static func matrix(_ a: [Double]) -> Mat4? {
        guard a.count == 16 else { return nil }
        return Mat4(columns: (SIMD4(a[0], a[1], a[2], a[3]), SIMD4(a[4], a[5], a[6], a[7]),
                              SIMD4(a[8], a[9], a[10], a[11]), SIMD4(a[12], a[13], a[14], a[15])))
    }
    static func make(x: Vec3, y: Vec3, z: Vec3, position: Vec3) -> Mat4 {
        Mat4(columns: (SIMD4(x, 0), SIMD4(y, 0), SIMD4(z, 0), SIMD4(position, 1)))
    }
    static func axis(_ m: Mat4, _ column: Int) -> Vec3 {
        Vec3(m[column].x, m[column].y, m[column].z)
    }
    static func position(_ m: Mat4) -> Vec3 { axis(m, 3) }
    static func transform(_ m: Mat4, _ p: Vec3) -> Vec3 {
        let r = m * SIMD4(p, 1)
        return Vec3(r.x, r.y, r.z)
    }
    static func rotate(_ m: Mat4, _ v: Vec3) -> Vec3 {
        let r = m * SIMD4(v, 0)
        return Vec3(r.x, r.y, r.z)
    }
    static func inverseRigid(_ m: Mat4) -> Mat4 {
        let x = axis(m, 0), y = axis(m, 1), z = axis(m, 2), p = position(m)
        return Mat4(columns: (SIMD4(x.x, y.x, z.x, 0), SIMD4(x.y, y.y, z.y, 0), SIMD4(x.z, y.z, z.z, 0),
                              SIMD4(-simd_dot(x, p), -simd_dot(y, p), -simd_dot(z, p), 1)))
    }
    static func translation(_ v: Vec3) -> Mat4 {
        var m = identity
        m.columns.3 = SIMD4(v, 1)
        return m
    }
    static func isRigid(_ a: [Double], tolerance: Double = 1e-4) -> Bool {
        guard a.count == 16, a.allSatisfy(\.isFinite), let m = matrix(a) else { return false }
        if abs(a[3]) + abs(a[7]) + abs(a[11]) > tolerance || abs(a[15] - 1) > tolerance { return false }
        let x = axis(m, 0), y = axis(m, 1), z = axis(m, 2)
        let checks = [simd_dot(x, x) - 1, simd_dot(y, y) - 1, simd_dot(z, z) - 1, simd_dot(x, y), simd_dot(x, z), simd_dot(y, z)]
        return checks.allSatisfy { abs($0) <= tolerance } && simd_dot(simd_cross(x, y), z) > 0
    }

    /// Shepperd's method, [x, y, z, w] with w >= 0 (same as the TypeScript port).
    static func quaternion(_ m: Mat4) -> SIMD4<Double> {
        let m00 = m[0][0], m10 = m[0][1], m20 = m[0][2]
        let m01 = m[1][0], m11 = m[1][1], m21 = m[1][2]
        let m02 = m[2][0], m12 = m[2][1], m22 = m[2][2]
        let trace = m00 + m11 + m22
        var q: SIMD4<Double>
        if trace > 0 {
            let s = (trace + 1).squareRoot() * 2
            q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]
        } else if m00 > m11 && m00 > m22 {
            let s = (1 + m00 - m11 - m22).squareRoot() * 2
            q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
        } else if m11 > m22 {
            let s = (1 + m11 - m00 - m22).squareRoot() * 2
            q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]
        } else {
            let s = (1 + m22 - m00 - m11).squareRoot() * 2
            q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]
        }
        let n = simd_length(q)
        return q / n * (q.w < 0 ? -1 : 1)
    }
    static func matrix(position: Vec3, quaternion input: SIMD4<Double>) -> Mat4? {
        let n = simd_length(input)
        guard n > 1e-6, input.x.isFinite, input.y.isFinite, input.z.isFinite, input.w.isFinite else { return nil }
        let q = input / n
        let (x, y, z, w) = (q.x, q.y, q.z, q.w)
        return make(x: Vec3(1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)),
                    y: Vec3(2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)),
                    z: Vec3(2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)),
                    position: position)
    }
    /// Position (m) and rotation (deg) difference between two rigid transforms.
    static func difference(_ a: Mat4, _ b: Mat4) -> (positionM: Double, rotationDeg: Double) {
        let relative = inverseRigid(a) * b
        let trace = relative[0][0] + relative[1][1] + relative[2][2]
        return (simd_distance(position(a), position(b)), acos(min(1, max(-1, (trace - 1) / 2))) * 180 / .pi)
    }
    static func float(_ m: Mat4) -> simd_float4x4 {
        simd_float4x4(columns: (SIMD4<Float>(m.columns.0), SIMD4<Float>(m.columns.1), SIMD4<Float>(m.columns.2), SIMD4<Float>(m.columns.3)))
    }
    static func double(_ m: simd_float4x4) -> Mat4 {
        Mat4(columns: (SIMD4<Double>(m.columns.0), SIMD4<Double>(m.columns.1), SIMD4<Double>(m.columns.2), SIMD4<Double>(m.columns.3)))
    }
    static func vector(_ v: Vec3) -> [Double] { [v.x, v.y, v.z] }
    static func vec(_ a: [Double]) -> Vec3? { a.count == 3 && a.allSatisfy(\.isFinite) ? Vec3(a[0], a[1], a[2]) : nil }
}
