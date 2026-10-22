import simd

/// A rigid surface-aligned pose whose wide X axis faces across the viewer.
enum SurfacePose {
    static func make(position: SIMD3<Float>, normal input: SIMD3<Float>, camera: SIMD3<Float>) -> simd_float4x4? {
        guard simd_length(input) > 0.001 else { return nil }
        var normal = simd_normalize(input)
        if normal.y < 0 { normal = -normal }
        guard normal.y > 0.5, position.y < camera.y - 0.05,
              simd_distance(camera, position) < 8 else { return nil }
        let toCamera = camera - position
        let projected = toCamera - simd_dot(toCamera, normal) * normal
        guard simd_length(projected) > 0.03 else { return nil }
        let z = simd_normalize(projected)
        let x = simd_normalize(simd_cross(normal, z))
        return simd_float4x4(columns: (SIMD4(x, 0), SIMD4(normal, 0), SIMD4(z, 0), SIMD4(position, 1)))
    }
}
