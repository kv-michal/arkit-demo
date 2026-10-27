import simd

func near(_ a: Float, _ b: Float) -> Bool { abs(a - b) < 0.0001 }
func verify(normal: SIMD3<Float>, camera: SIMD3<Float>) {
    guard let pose = SurfacePose.make(position: .zero, normal: normal, camera: camera) else { fatalError("Expected valid surface") }
    let x = SIMD3(pose.columns.0.x, pose.columns.0.y, pose.columns.0.z)
    let y = SIMD3(pose.columns.1.x, pose.columns.1.y, pose.columns.1.z)
    let z = SIMD3(pose.columns.2.x, pose.columns.2.y, pose.columns.2.z)
    assert(near(simd_length(x), 1) && near(simd_length(y), 1) && near(simd_length(z), 1))
    assert(near(simd_dot(x, y), 0) && near(simd_dot(x, z), 0))
    assert(near(x.x * camera.x + x.z * camera.z, 0), "Wide edge must be perpendicular to the plan-view viewer direction")
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

// Enlarging the block must never move its camera-facing edge towards the viewer.
for width: Float in [0.2, 3] {
    for count in [1, 2, 11, 51] {
        let corners = RectangleGeometry.bottomCorners(width: width, count: count)
        assert(corners.allSatisfy { $0.z <= 0 && near($0.y, 0.001) })
        assert(near(corners.map(\.z).max()!, 0))
        assert(near(corners.map(\.z).min()!, -width * 0.45))
        for (normal, camera): (SIMD3<Float>, SIMD3<Float>) in [([0,1,0], [0,1.6,2]), ([0.3,0.9,0.2], [-2,1.6,2])] {
            let hit: SIMD3<Float> = [1,0,-1]
            let pose = SurfacePose.make(position: hit, normal: normal, camera: camera)!
            let edge = pose * SIMD4<Float>(0, 0, 0, 1)
            assert(simd_distance(SIMD3(edge.x, edge.y, edge.z), hit) < 0.0001)
            let towardViewer = SIMD3(pose.columns.2.x, pose.columns.2.y, pose.columns.2.z)
            for corner in corners {
                let world = pose * SIMD4(corner, 1)
                let relative = SIMD3(world.x, world.y, world.z) - hit
                assert(simd_dot(relative, towardViewer) <= 0.0001, "Footprint must grow away from aimed edge")
            }
        }
    }
}
print("RectangleGeometry: both sizes, even/odd rows, slopes and fixed aimed edge passed")
