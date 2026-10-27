import { test } from "node:test";
import assert from "node:assert/strict";
import {
  depthNormal,
  followAnchor,
  inverseRigid,
  multiply,
  transformMatrix,
} from "../src/viroGeometry";
import {
  poseFromMatrix,
  rotationFromMatrix,
  surfacePose,
  type Vec3,
} from "../src/surfacePose";
const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("Viro transform conversion preserves translation and compound Euler rotations", () => {
  for (const rotation of [
    [15, 25, -30],
    [0, 90, 45],
    [-30, -60, 170],
  ] as Vec3[]) {
    const m = transformMatrix([2, -1, 3], rotation);
    const roundtrip = transformMatrix([2, -1, 3], rotationFromMatrix(m));
    roundtrip.forEach((value, index) => near(value, m[index]));
    multiply(m, inverseRigid(m)).forEach((value, index) =>
      near(value, index % 5 === 0 ? 1 : 0),
    );
  }
});
test("anchor updates preserve viewer-facing orientation and placement offset", () => {
  const initial = transformMatrix([1, -1, 2], [20, 30, -10]);
  const local = transformMatrix([0.1, 0, -0.2], [0, 70, 0]);
  const placed = poseFromMatrix(multiply(initial, local));
  const updated = transformMatrix([2, -0.8, 1], [25, 40, 5]);
  const tracked = followAnchor(initial, updated, placed);
  const expected = multiply(updated, local);
  tracked.matrix.forEach((value, index) => near(value, expected[index]));
});
test("depth samples recover a sloped surface; placement rejects walls", () => {
  const normal = depthNormal([0, 0, 0], [0.03, 0, 0], [0, 0.02, 0.04]);
  assert.ok(normal);
  const pose = surfacePose([0, 0, 0], normal, [0, 1.6, 2]);
  assert.ok(pose);
  near(pose.slope, (Math.atan(0.5) * 180) / Math.PI);
  const wall = depthNormal([0, 0, 0], [0.03, 0, 0], [0, 0.03, 0]);
  assert.ok(wall);
  assert.equal(surfacePose([0, 0, 0], wall, [0, 1.6, 2]), null);
});
test("depth estimation rejects coincident samples, discontinuities and invalid data", () => {
  assert.equal(depthNormal([0, 0, 0], [0, 0, 0], [0.02, 0, 0]), null);
  assert.equal(depthNormal([0, 0, 0], [0.03, 0, 0], [0, 0.4, 0.03]), null);
  assert.equal(depthNormal([NaN, 0, 0], [0.03, 0, 0], [0, 0, 0.03]), null);
});

test("anchor-follow toggle freezes the current pose and resumes with the latest correction", () => {
  const initial = transformMatrix([1, -1, 2], [0, 20, 0]);
  const placed = poseFromMatrix(transformMatrix([1, -1, 2], [0, 70, 0]));
  const firstUpdate = transformMatrix([1.1, -0.9, 2], [0, 22, 0]);
  const current = followAnchor(initial, firstUpdate, placed);
  const latest = transformMatrix([1.5, -0.8, 2.2], [0, 30, 0]);
  assert.equal(followAnchor(initial, latest, placed, false, current), current);
  assert.equal(followAnchor(initial, latest, placed, false), placed);
  const resumed = followAnchor(initial, latest, placed, true, current);
  const expected = followAnchor(initial, latest, placed);
  resumed.matrix.forEach((value, index) => near(value, expected.matrix[index]));
  assert.notDeepEqual(resumed.matrix, current.matrix);
});
