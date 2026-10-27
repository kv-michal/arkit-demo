import simd

/// Viewer-facing floor pose. IMPLEMENTATION_PLAN section 3: yaw comes from the
/// latched horizontal (plan-view) heading toward the user; inclination comes
/// from the measured floor normal. Phone pitch/roll never enter the pose.
/// Port of floor-frame-viro/src/surfacePose.ts.
enum SurfacePose {
    struct RowFrame {
        let matrix: Mat4
        /// Height-changing angle when walking along local X, degrees.
        let alongRowInclination: Double
        /// Inclination of local Z (toward the user), degrees.
        let crossSlope: Double
    }

    static func horizontalHeading(origin: Vec3, camera: Vec3, gravityUp: Vec3 = MatrixMath.gravityUp) -> Vec3? {
        let values = [origin.x, origin.y, origin.z, camera.x, camera.y, camera.z, gravityUp.x, gravityUp.y, gravityUp.z]
        guard values.allSatisfy(\.isFinite) else { return nil }
        let g = simd_normalize(gravityUp)
        let toCamera = camera - origin
        let horizontal = toCamera - g * simd_dot(toCamera, g)
        guard simd_length(horizontal) > 0.03 else { return nil }
        return simd_normalize(horizontal)
    }

    static func rowFrame(origin: Vec3, normal input: Vec3, heading: Vec3, gravityUp: Vec3 = MatrixMath.gravityUp) -> RowFrame? {
        let values = [origin, input, heading, gravityUp].flatMap { [$0.x, $0.y, $0.z] }
        guard values.allSatisfy(\.isFinite), simd_length(input) >= 0.001, simd_length(heading) >= 0.001 else { return nil }
        let g = simd_normalize(gravityUp)
        var n = simd_normalize(input)
        if simd_dot(n, g) < 0 { n = -n }
        // Normals at or below 0.5 are slopes of 60 degrees or more: walls, not floors.
        guard simd_dot(n, g) > 0.5 else { return nil }
        let zHorizontal = simd_normalize(heading - g * simd_dot(heading, g))
        let xHorizontal = simd_normalize(simd_cross(g, zHorizontal))
        let x = simd_normalize(xHorizontal - g * (simd_dot(n, xHorizontal) / simd_dot(n, g)))
        let z = simd_normalize(simd_cross(x, n))
        let matrix = MatrixMath.make(x: x, y: n, z: z, position: origin)
        guard MatrixMath.array(matrix).allSatisfy(\.isFinite),
              abs(simd_dot(x, n)) <= 1e-6, abs(simd_dot(simd_cross(x, n), z) - 1) <= 1e-6 else { return nil }
        func incline(_ a: Vec3) -> Double {
            atan2(simd_dot(a, g), simd_length(a - g * simd_dot(a, g))) * 180 / .pi
        }
        return RowFrame(matrix: matrix, alongRowInclination: incline(x), crossSlope: incline(z))
    }

    /// Same range, overhead and slope rules as the Viro `surfacePose`.
    static func pose(position: Vec3, normal: Vec3, camera: Vec3) -> Mat4? {
        let values = [position, normal, camera].flatMap { [$0.x, $0.y, $0.z] }
        guard values.allSatisfy(\.isFinite), simd_length(normal) >= 0.001 else { return nil }
        guard position.y < camera.y - 0.05, simd_distance(camera, position) < 8,
              let heading = horizontalHeading(origin: position, camera: camera) else { return nil }
        return rowFrame(origin: position, normal: normal, heading: heading)?.matrix
    }

    static func make(position: SIMD3<Float>, normal: SIMD3<Float>, camera: SIMD3<Float>) -> simd_float4x4? {
        pose(position: Vec3(position), normal: Vec3(normal), camera: Vec3(camera)).map(MatrixMath.float)
    }
}
