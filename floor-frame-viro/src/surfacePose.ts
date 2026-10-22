export type Vec3 = [number, number, number];
export type Pose = {
  position: Vec3;
  rotation: Vec3;
  matrix: number[];
  distance: number;
  slope: number;
};
export const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(...a);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const subtract = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const clamp = (n: number) => Math.min(1, Math.max(-1, n));
const DEG = 180 / Math.PI;

// Viro uses Rz * Ry * Rx Euler angles in degrees (VROQuaternion::toEuler).
export function rotationFromMatrix(m: number[]): Vec3 {
  const pitch = Math.asin(clamp(-m[2]));
  if (Math.abs(Math.cos(pitch)) < 0.000001)
    return [0, pitch * DEG, Math.atan2(-m[4], m[5]) * DEG];
  return [
    Math.atan2(m[6], m[10]) * DEG,
    pitch * DEG,
    Math.atan2(m[1], m[0]) * DEG,
  ];
}
export function poseFromMatrix(matrix: number[]): Pose {
  return {
    matrix,
    position: [matrix[12], matrix[13], matrix[14]],
    rotation: rotationFromMatrix(matrix),
    distance: 0,
    slope: Math.acos(clamp(matrix[5])) * DEG,
  };
}

/** Same projection, range, overhead and slope rules as Swift SurfacePose.make. */
export function surfacePose(
  position: Vec3,
  inputNormal: Vec3,
  camera: Vec3,
): Pose | null {
  if (![...position, ...inputNormal, ...camera].every(Number.isFinite))
    return null;
  const magnitude = length(inputNormal);
  if (magnitude < 0.001) return null;
  let normal = scale(inputNormal, 1 / magnitude);
  if (normal[1] < 0) normal = scale(normal, -1);
  const toCamera = subtract(camera, position);
  const distance = length(toCamera);
  if (normal[1] <= 0.5 || position[1] >= camera[1] - 0.05 || distance >= 8)
    return null;
  const projected = subtract(toCamera, scale(normal, dot(toCamera, normal)));
  if (length(projected) <= 0.03) return null;
  const z = scale(projected, 1 / length(projected));
  const x = cross(normal, z);
  const matrix = [...x, 0, ...normal, 0, ...z, 0, ...position, 1];
  return { ...poseFromMatrix(matrix), distance };
}
