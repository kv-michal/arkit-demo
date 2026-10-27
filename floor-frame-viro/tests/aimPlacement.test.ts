import { test } from "node:test";
import assert from "node:assert/strict";
import { aimPointFromLayout } from "../src/aimPoint";
import { rectangleCenterZ, rectangleDepth } from "../src/rectangleGeometry";
import { chainGeometry, worldPoint } from "../src/diagnosticGeometry";
import { dot, surfacePose, type Vec3 } from "../src/surfacePose";
import { followAnchor, transformMatrix } from "../src/viroGeometry";

test("visible crosshair layout converts to Viro pixels, including safe area and controls", () => {
  const point = aimPointFromLayout({ x: 20, y: 118, width: 362, height: 240 }, 3)!;
  assert.deepEqual(point, { x: 603, y: 714, adjacentX: 614, adjacentY: 703 });
  assert.notEqual(point.y, 874 * 3 / 2, "Do not silently aim at screen centre under controls");
  assert.equal(aimPointFromLayout({ x: 0, y: 0, width: 0, height: 20 }, 3), null);
  assert.equal(aimPointFromLayout({ x: NaN, y: 0, width: 20, height: 20 }, 3), null);
});

test("both sizes grow away from the aimed bottom edge, including slopes and resized anchors", () => {
  const hit: Vec3 = [1, 0, -1];
  for (const normal of [[0, 1, 0], [0.3, 0.9, 0.2]] as Vec3[]) {
    const pose = surfacePose(hit, normal, [-2, 1.6, 2])!;
    assert.deepEqual(pose.position, hit);
    for (const width of [0.2, 3]) {
      assert.equal(rectangleCenterZ(width) + rectangleDepth(width) / 2, 0);
      for (const count of [1, 2, 11, 51]) {
        const geometry = chainGeometry(pose, width, count);
        for (const corner of geometry.bottomCornersWorld) {
          const relative = corner.map((v, i) => v - hit[i]) as Vec3;
          assert.ok(dot(relative, pose.matrix.slice(8, 11) as Vec3) <= 1e-9);
        }
      }
      const initial = transformMatrix(hit, [0, 0, 0]);
      const updated = transformMatrix([2, 0.1, -2], [0, 20, 0]);
      const anchored = followAnchor(initial, updated, pose);
      // Changing width modifies only geometry; the anchor's aimed edge stays fixed.
      const edge = worldPoint(anchored.matrix, [0, 0, 0]);
      for (const nextWidth of [0.2, 3]) {
        const center = rectangleCenterZ(nextWidth);
        assert.deepEqual(worldPoint(anchored.matrix, [0, 0, center + rectangleDepth(nextWidth) / 2]), edge);
      }
    }
  }
});
