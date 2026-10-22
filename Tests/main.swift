import simd

func near(_ a: Float, _ b: Float) -> Bool { abs(a - b) < 0.0001 }
func verify(normal: SIMD3<Float>, camera: SIMD3<Float>) {
    guard let pose = SurfacePose.make(position: .zero, normal: normal, camera: camera) else { fatalError("Expected valid surface") }
    let x = SIMD3(pose.columns.0.x, pose.columns.0.y, pose.columns.0.z)
    let y = SIMD3(pose.columns.1.x, pose.columns.1.y, pose.columns.1.z)
    let z = SIMD3(pose.columns.2.x, pose.columns.2.y, pose.columns.2.z)
    assert(near(simd_length(x), 1) && near(simd_length(y), 1) && near(simd_length(z), 1))
    assert(near(simd_dot(x, y), 0) && near(simd_dot(x, z), 0))
    assert(near(simd_dot(x, camera), 0), "Wide edge must be perpendicular to viewer direction")
    assert(simd_dot(y, simd_normalize(normal)) > 0.999, "Must retain floor pitch")
    assert(near(simd_determinant(simd_float3x3(columns: (x,y,z))), 1))
}
verify(normal: [0,1,0], camera: [0,1.6,2])
verify(normal: [0,1,0], camera: [2,1.6,0])
verify(normal: [0,0.866,0.5], camera: [0,1.6,2])
verify(normal: [0.3,0.9,0.2], camera: [-2,1.6,2])
assert(SurfacePose.make(position: .zero, normal: [0,0,1], camera: [0,1.6,2]) == nil, "Reject walls")
assert(SurfacePose.make(position: .zero, normal: [0,1,0], camera: [0,-1,2]) == nil, "Reject overhead surfaces")
assert(SurfacePose.make(position: .zero, normal: [0,1,0], camera: [0,1.6,10]) == nil, "Reject distant hits")
assert(SurfacePose.make(position: .zero, normal: [0,1,0], camera: [0,1.6,0]) == nil, "Reject undefined facing direction")
assert(SurfacePose.make(position: .zero, normal: .zero, camera: [0,1.6,2]) == nil)
print("SurfacePose: floor, viewer rotation, slopes, orthonormality, wall/ceiling/range rejection passed")
