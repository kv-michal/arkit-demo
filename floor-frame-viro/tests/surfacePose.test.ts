import { test } from "node:test";
import assert from "node:assert/strict";
import {
  surfacePose,
  dot,
  cross,
  rotationFromMatrix,
  type Vec3,
} from "../src/surfacePose";
const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const cases: { normal: Vec3; camera: Vec3 }[] = [
  { normal: [0, 1, 0], camera: [0, 1.6, 2] },
  { normal: [0, 1, 0], camera: [2, 1.6, 0] },
  { normal: [0, 0.866, 0.5], camera: [0, 1.6, 2] },
  { normal: [0.3, 0.9, 0.2], camera: [-2, 1.6, 2] },
  { normal: [0, 1, 0], camera: [-2, 1.6, -2] },
];
for (const [i, { normal, camera }] of cases.entries())
  test(`surface ${i}: slope, facing, orthonormality and Viro Euler roundtrip`, () => {
    const pose = surfacePose([0, 0, 0], normal, camera);
    assert.ok(pose);
    const m = pose.matrix;
    const x = m.slice(0, 3) as Vec3,
      y = m.slice(4, 7) as Vec3,
      z = m.slice(8, 11) as Vec3;
    near(dot(x, x), 1);
    near(dot(y, y), 1);
    near(dot(z, z), 1);
    near(dot(x, y), 0);
    near(dot(x, z), 0);
    near(dot(x, camera), 0);
    near(dot(cross(x, y), z), 1);
    near(dot(y, normal) / Math.hypot(...normal), 1);
    const [rx, ry, rz] = pose.rotation.map((v) => (v * Math.PI) / 180);
    const [cx, sx, cy, sy, cz, sz] = [
      Math.cos(rx),
      Math.sin(rx),
      Math.cos(ry),
      Math.sin(ry),
      Math.cos(rz),
      Math.sin(rz),
    ];
    const reconstructed = [
      cy * cz,
      cy * sz,
      -sy,
      0,
      cz * sx * sy - cx * sz,
      cx * cz + sx * sy * sz,
      cy * sx,
      0,
      sx * sz + cx * cz * sy,
      cx * sy * sz - cz * sx,
      cx * cy,
      0,
      0,
      0,
      0,
      1,
    ];
    reconstructed.forEach((n, index) => near(n, m[index]));
  });
test("reject walls, overhead, far, undefined and invalid surfaces", () => {
  for (const [normal, camera] of [
    [
      [0, 0, 1],
      [0, 1.6, 2],
    ],
    [
      [0, 1, 0],
      [0, -1, 2],
    ],
    [
      [0, 1, 0],
      [0, 1.6, 10],
    ],
    [
      [0, 1, 0],
      [0, 1.6, 0],
    ],
    [
      [0, 0, 0],
      [0, 1.6, 2],
    ],
    [
      [NaN, 1, 0],
      [0, 1.6, 2],
    ],
  ])
    assert.equal(surfacePose([0, 0, 0], normal as Vec3, camera as Vec3), null);
});
test("translated floor and downward normal", () => {
  const pose = surfacePose([1, -1, 2], [0, -1, 0], [1, 1, 4]);
  assert.ok(pose);
  assert.deepEqual(pose.position, [1, -1, 2]);
  near(pose.slope, 0);
});
