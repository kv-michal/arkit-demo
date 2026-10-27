import { dot, type Pose, type Vec3 } from "./surfacePose";

import { rectangleCenterZ, rectangleDepth, rectangleOffset } from "./rectangleGeometry";
export { rectangleOffset } from "./rectangleGeometry";

export function worldPoint(matrix: number[], local: Vec3): Vec3 {
  return [0, 1, 2].map(row => matrix[12 + row] + matrix[row] * local[0] + matrix[4 + row] * local[1] + matrix[8 + row] * local[2]) as Vec3;
}

export function poseDelta(initial: Pose, current: Pose) {
  const verticalM = current.position[1] - initial.position[1];
  const translationM = Math.hypot(...current.position.map((v, i) => v - initial.position[i]));
  const normalDot = dot(initial.matrix.slice(4, 7) as Vec3, current.matrix.slice(4, 7) as Vec3);
  return { verticalM, translationM, normalAngleDeg: Math.acos(Math.min(1, Math.max(-1, normalDot))) * 180 / Math.PI };
}

/** Actual bottom surface: local Y=1 mm, matching RectangleRow's model offset. */
export function chainGeometry(pose: Pose, width: number, count: number) {
  const offsets = Array.from({ length: count }, (_, i) => rectangleOffset(i, width));
  const minX = Math.min(...offsets) - width / 2;
  const maxX = Math.max(...offsets) + width / 2;
  const corners = [minX, maxX].flatMap(x => [-rectangleDepth(width), 0].map(z => worldPoint(pose.matrix, [x, 0.001, z])));
  return {
    widthM: width, rectangleCount: count, spanM: maxX - minX,
    normal: pose.matrix.slice(4, 7), acrossAxis: pose.matrix.slice(0, 3),
    heightChangeAlongChainM: (maxX - minX) * pose.matrix[1],
    bottomCornersWorld: corners,
    center: worldPoint(pose.matrix, [0, 0.001, rectangleCenterZ(width)]),
    leftEnd: worldPoint(pose.matrix, [minX, 0.001, rectangleCenterZ(width)]),
    rightEnd: worldPoint(pose.matrix, [maxX, 0.001, rectangleCenterZ(width)]),
  };
}

/** Negative means the hit is above (in front of) the model's bottom plane. */
export function surfaceClearance(pose: Pose, hit: Vec3) {
  const normal = pose.matrix.slice(4, 7) as Vec3;
  const bottom = worldPoint(pose.matrix, [0, 0.001, 0]);
  return {
    normalClearanceM: dot(normal, bottom.map((v, i) => v - hit[i]) as Vec3),
    modelYAtHitXZ: Math.abs(normal[1]) > 1e-6
      ? bottom[1] - (normal[0] * (hit[0] - bottom[0]) + normal[2] * (hit[2] - bottom[2])) / normal[1]
      : null,
  };
}
