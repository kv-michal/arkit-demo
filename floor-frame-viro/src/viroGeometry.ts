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

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function transformPoint(m: number[], p: Vec3): Vec3 {
  return [0, 1, 2].map(
    (row) => m[12 + row] + m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2],
  ) as Vec3;
}
export function rotateVector(m: number[], v: Vec3): Vec3 {
  return [0, 1, 2].map(
    (row) => m[row] * v[0] + m[4 + row] * v[1] + m[8 + row] * v[2],
  ) as Vec3;
}
export function translation(v: Vec3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
}

/** Unit quaternion [x, y, z, w] to a column-major rigid matrix. */
export function matrixFromQuaternion(position: Vec3, q: number[]): number[] | null {
  if (q.length !== 4 || ![...q, ...position].every(Number.isFinite)) return null;
  const n = Math.hypot(...q);
  if (n < 1e-6) return null;
  const [x, y, z, w] = q.map((value) => value / n);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    ...position, 1,
  ];
}

/** Shepperd's method; returns [x, y, z, w] with w >= 0. */
export function quaternionFromMatrix(m: number[]): number[] {
  const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = m;
  const trace = m00 + m11 + m22;
  let q: number[];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return q.map((value) => (value / n) * (q[3] < 0 ? -1 : 1));
}

/** Position (m) and rotation (deg) difference between two rigid transforms. */
export function poseDifference(a: number[], b: number[]) {
  const relative = multiply(inverseRigid(a), b);
  const trace = relative[0] + relative[5] + relative[10];
  return {
    positionM: Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]),
    rotationDeg:
      (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI,
  };
}

/** True when the upper 3x3 is a proper rotation and the bottom row is [0,0,0,1]. */
export function isRigid(m: number[], tolerance = 1e-4): boolean {
  if (m.length !== 16 || !m.every(Number.isFinite)) return false;
  if (Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) > tolerance || Math.abs(m[15] - 1) > tolerance)
    return false;
  const x = m.slice(0, 3) as Vec3, y = m.slice(4, 7) as Vec3, z = m.slice(8, 11) as Vec3;
  return [dot(x, x) - 1, dot(y, y) - 1, dot(z, z) - 1, dot(x, y), dot(x, z), dot(y, z)]
    .every((value) => Math.abs(value) <= tolerance) && dot(cross(x, y), z) > 0;
}

/**
 * Viro anchor transforms arrive as quaternions from createAnchoredNode on iOS
 * and as Euler degrees from anchor callbacks. Accept either; report which.
 */
export function anchorMatrix(position: Vec3, rotation: number[]): { matrix: number[]; format: "quaternion" | "euler" } | null {
  if (rotation.length === 4) {
    const matrix = matrixFromQuaternion(position, rotation);
    return matrix ? { matrix, format: "quaternion" } : null;
  }
  if (rotation.length === 3 && [...rotation, ...position].every(Number.isFinite))
    return { matrix: transformMatrix(position, rotation as Vec3), format: "euler" };
  return null;
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
