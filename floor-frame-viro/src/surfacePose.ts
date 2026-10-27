export type Vec3 = [number, number, number];
export type Pose = {
  position: Vec3;
  rotation: Vec3;
  matrix: number[];
  distance: number;
  /** Angle between the floor normal and gravity-up, degrees. */
  slope: number;
};
export const GRAVITY_UP: Vec3 = [0, 1, 0];
export const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(...a);
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / length(a));
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

/**
 * Horizontal (plan-view) direction from the placement origin toward the user.
 * This is the latched yaw input; it never carries phone pitch or roll.
 */
export function horizontalHeading(
  origin: Vec3,
  camera: Vec3,
  gravityUp: Vec3 = GRAVITY_UP,
): Vec3 | null {
  if (![...origin, ...camera, ...gravityUp].every(Number.isFinite)) return null;
  const g = normalize(gravityUp);
  const toCamera = subtract(camera, origin);
  const horizontal = subtract(toCamera, scale(g, dot(toCamera, g)));
  if (length(horizontal) <= 0.03) return null;
  return normalize(horizontal);
}

export type RowFrame = {
  matrix: number[];
  /** Height-changing angle when walking along local X, degrees. */
  alongRowInclination: number;
  /** Inclination of local Z (toward the user), degrees. */
  crossSlope: number;
};

/**
 * IMPLEMENTATION_PLAN section 3: yaw from the latched horizontal heading,
 * inclination from the measured floor normal. The long edge's horizontal
 * projection stays perpendicular to the heading on any compound slope.
 */
export function rowFrame(
  origin: Vec3,
  inputNormal: Vec3,
  heading: Vec3,
  gravityUp: Vec3 = GRAVITY_UP,
): RowFrame | null {
  if (![...origin, ...inputNormal, ...heading, ...gravityUp].every(Number.isFinite))
    return null;
  if (length(inputNormal) < 0.001 || length(heading) < 0.001) return null;
  const g = normalize(gravityUp);
  let n = normalize(inputNormal);
  if (dot(n, g) < 0) n = scale(n, -1);
  // Normals at or below 0.5 are slopes of 60 degrees or more: walls, not floors.
  if (dot(n, g) <= 0.5) return null;
  const zHorizontal = normalize(subtract(heading, scale(g, dot(heading, g))));
  const xHorizontal = normalize(cross(g, zHorizontal));
  const x = normalize(subtract(xHorizontal, scale(g, dot(n, xHorizontal) / dot(n, g))));
  const z = normalize(cross(x, n));
  const matrix = [...x, 0, ...n, 0, ...z, 0, ...origin, 1];
  if (!matrix.every(Number.isFinite)) return null;
  const det = dot(cross(x, n), z);
  if (Math.abs(dot(x, n)) > 1e-6 || Math.abs(det - 1) > 1e-6) return null;
  const incline = (axis: Vec3) =>
    Math.atan2(dot(axis, g), length(subtract(axis, scale(g, dot(axis, g))))) * DEG;
  return { matrix, alongRowInclination: incline(x), crossSlope: incline(z) };
}

/** Same range, overhead and slope rules as Swift SurfacePose.make. */
export function surfacePose(
  position: Vec3,
  inputNormal: Vec3,
  camera: Vec3,
): Pose | null {
  if (![...position, ...inputNormal, ...camera].every(Number.isFinite))
    return null;
  if (length(inputNormal) < 0.001) return null;
  const distance = length(subtract(camera, position));
  if (position[1] >= camera[1] - 0.05 || distance >= 8) return null;
  const heading = horizontalHeading(position, camera);
  const frame = heading && rowFrame(position, inputNormal, heading);
  if (!frame) return null;
  return { ...poseFromMatrix(frame.matrix), distance };
}
