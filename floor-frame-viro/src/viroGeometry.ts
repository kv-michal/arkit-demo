import {
  cross,
  dot,
  poseFromMatrix,
  type Pose,
  type Vec3,
} from "./surfacePose";

/** Viro's Rz * Ry * Rx Euler convention, degrees, column-major matrix. */
export function transformMatrix(position: Vec3, rotation: Vec3): number[] {
  const [rx, ry, rz] = rotation.map((value) => (value * Math.PI) / 180);
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(rx),
    Math.sin(rx),
    Math.cos(ry),
    Math.sin(ry),
    Math.cos(rz),
    Math.sin(rz),
  ];
  return [
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
    ...position,
    1,
  ];
}

export function multiply(a: number[], b: number[]): number[] {
  return Array.from({ length: 16 }, (_, index) => {
    const row = index % 4,
      col = Math.floor(index / 4);
    return [0, 1, 2, 3].reduce(
      (sum, k) => sum + a[k * 4 + row] * b[col * 4 + k],
      0,
    );
  });
}

export function inverseRigid(m: number[]): number[] {
  const p = m.slice(12, 15) as Vec3;
  return [
    m[0],
    m[4],
    m[8],
    0,
    m[1],
    m[5],
    m[9],
    0,
    m[2],
    m[6],
    m[10],
    0,
    -dot(m.slice(0, 3) as Vec3, p),
    -dot(m.slice(4, 7) as Vec3, p),
    -dot(m.slice(8, 11) as Vec3, p),
    1,
  ];
}

export function followAnchor(
  initial: number[],
  updated: number[],
  placed: Pose,
  enabled = true,
  current: Pose = placed,
): Pose {
  if (!enabled) return current;
  return poseFromMatrix(
    multiply(multiply(updated, inverseRigid(initial)), placed.matrix),
  );
}

/** Estimate a depth surface normal from three nearby samples, rejecting gaps/edges. */
export function depthNormal(center: Vec3, right: Vec3, up: Vec3): Vec3 | null {
  const subtract = (a: Vec3, b: Vec3): Vec3 => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
  ];
  const a = subtract(right, center),
    b = subtract(up, center);
  if (
    ![...center, ...right, ...up].every(Number.isFinite) ||
    Math.hypot(...a) > 0.15 ||
    Math.hypot(...b) > 0.15
  )
    return null;
  const normal = cross(a, b);
  const size = Math.hypot(...normal);
  if (size < 0.000001) return null;
  return normal.map((value) => value / size) as Vec3;
}
