import {
  add,
  cross,
  dot,
  GRAVITY_UP,
  length,
  normalize,
  rowFrame,
  scale,
  subtract,
  type Vec3,
} from "./surfacePose";

/**
 * IMPLEMENTATION_PLAN section 5: robust floor-plane calibration. Every
 * threshold here is a tuning proposal, not a sensor accuracy specification.
 * The Swift port (FloorFrame/FloorCalibration.swift) must stay numerically
 * equivalent; both are checked against Tests/fixtures.
 */
export const CALIBRATION = {
  cellSize: 0.2,
  maxPerCell: 16,
  maxObservations: 2000,
  minRange: 0.3,
  maxRange: 5,
  minBelowCamera: 0.05,
  ransacIterations: 128,
  ransacSeed: 12345,
  inlierThreshold: 0.03,
  bootstrapReps: 24,
  bootstrapSeed: 777,
  stabilityWindowS: 1,
  /** Minimum evidence before a measured (not precision-qualified) commit. */
  commit: { cells: 12, batches: 3, alongM: 0.8, acrossM: 0.4, inlierFraction: 0.6, minSpreadM: 0.1 },
  /** Research consistency gates only; passing them is not a precision claim. */
  research: { cells: 30, batches: 3, alongM: 2, acrossM: 1, inlierFraction: 0.8, residualM: 0.01, stabilityDeg: 0.05, intervalDeg: 0.1 },
};

export type SurfaceObservation = {
  /** Point in the calibration reference (anchor) frame. */
  point: Vec3;
  /** Camera position in the same reference frame at the sample. */
  camera: Vec3;
  source: string;
  batch: number;
  epoch: number;
  /** Receipt time in seconds; never substituted for a missing capture time. */
  receivedTimestamp: number;
  captureTimestamp?: number;
  confidence?: number;
};

export type CalibrationStatus = "insufficient" | "measured" | "research_consistent";

export type CalibrationResult = {
  status: CalibrationStatus;
  reasons: string[];
  source: string | null;
  sourceCells: Record<string, number>;
  normal: Vec3 | null;
  planeOffset: number | null;
  origin: Vec3 | null;
  /** referenceFromRow for the calibrated pose. */
  matrix: number[] | null;
  alongRowInclination: number | null;
  crossSlope: number | null;
  slope: number | null;
  observations: number;
  occupiedCells: number;
  batches: number;
  alongExtentM: number;
  acrossExtentM: number;
  inlierFraction: number;
  robustResidualM: number | null;
  rmsResidualM: number | null;
  p95ResidualM: number | null;
  eigenvalues: number[] | null;
  /** 1.96 sigma of batch-bootstrap along-row inclination, degrees. */
  uncertaintyDeg: number | null;
  heldOutDifferenceDeg: number | null;
  stabilityDeg: number | null;
  limitations: string[];
};

/** Deterministic PRNG shared with Swift (mulberry32). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cyclic Jacobi eigen-decomposition of a symmetric 3x3 matrix, ascending. */
export function symmetricEigen(input: number[][]): { values: number[]; vectors: Vec3[] } {
  const A = input.map((row) => [...row]);
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const pairs = [[0, 1], [0, 2], [1, 2]];
  for (let sweep = 0; sweep < 50; sweep++) {
    if (A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2] < 1e-30) break;
    for (const [p, q] of pairs) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq;
        A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk;
        A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => A[i][i] - A[j][j] || i - j);
  return {
    values: order.map((i) => A[i][i]),
    vectors: order.map((i) => [V[0][i], V[1][i], V[2][i]] as Vec3),
  };
}

export type PlaneFit = { centroid: Vec3; normal: Vec3; eigenvalues: number[] };

/** Weighted total-least-squares plane; normal is the smallest-eigenvalue direction, upward. */
export function weightedPlane(points: Vec3[], weights: number[], gravityUp: Vec3 = GRAVITY_UP): PlaneFit | null {
  let total = 0;
  let centroid: Vec3 = [0, 0, 0];
  points.forEach((p, i) => {
    total += weights[i];
    centroid = add(centroid, scale(p, weights[i]));
  });
  if (points.length < 3 || !(total > 0)) return null;
  centroid = scale(centroid, 1 / total);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  points.forEach((p, i) => {
    const d = subtract(p, centroid);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += (weights[i] * d[r] * d[c]) / total;
  });
  const { values, vectors } = symmetricEigen(C);
  let normal = normalize(vectors[0]);
  if (dot(normal, gravityUp) < 0) normal = scale(normal, -1);
  if (!normal.every(Number.isFinite)) return null;
  return { centroid, normal, eigenvalues: values };
}

type Cell = { i: number; j: number; key: string; samples: SurfaceObservation[] };

function cellsFor(observations: SurfaceObservation[], origin: Vec3, xAxis: Vec3, zAxis: Vec3): Cell[] {
  const cells = new Map<string, Cell>();
  for (const o of observations) {
    const d = subtract(o.point, origin);
    const i = Math.floor(dot(d, xAxis) / CALIBRATION.cellSize);
    const j = Math.floor(dot(d, zAxis) / CALIBRATION.cellSize);
    const key = `${i},${j}`;
    const cell = cells.get(key) ?? { i, j, key, samples: [] };
    cell.samples.push(o);
    cells.set(key, cell);
  }
  return [...cells.values()]
    .map((cell) => ({ ...cell, samples: cell.samples.slice(-CALIBRATION.maxPerCell) }))
    .sort((a, b) => a.i - b.i || a.j - b.j);
}

function ransac(points: Vec3[], gravityUp: Vec3): { normal: Vec3; point: Vec3 } | null {
  const random = mulberry32(CALIBRATION.ransacSeed);
  const n = points.length;
  let best: { normal: Vec3; point: Vec3; score: number } | null = null;
  for (let iteration = 0; iteration < CALIBRATION.ransacIterations; iteration++) {
    const a = Math.floor(random() * n), b = Math.floor(random() * n), c = Math.floor(random() * n);
    if (a === b || b === c || a === c) continue;
    const raw = cross(subtract(points[b], points[a]), subtract(points[c], points[a]));
    if (length(raw) < 1e-9) continue;
    let normal = normalize(raw);
    if (dot(normal, gravityUp) < 0) normal = scale(normal, -1);
    if (dot(normal, gravityUp) <= 0.5) continue;
    let score = 0;
    for (const p of points) if (Math.abs(dot(normal, subtract(p, points[a]))) <= CALIBRATION.inlierThreshold) score++;
    if (!best || score > best.score) best = { normal, point: points[a], score };
  }
  return best;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export type CalibrationInput = {
  observations: SurfaceObservation[];
  origin: Vec3;
  heading: Vec3;
  gravityUp?: Vec3;
  epoch: number;
  /** Along-row inclinations of previous fits within the stability window. */
  recentInclinations?: number[];
};

export function fitFloor(input: CalibrationInput): CalibrationResult {
  const g = normalize(input.gravityUp ?? GRAVITY_UP);
  const zAxis = normalize(subtract(input.heading, scale(g, dot(input.heading, g))));
  const xAxis = normalize(cross(g, zAxis));
  const result: CalibrationResult = {
    status: "insufficient", reasons: [], source: null, sourceCells: {}, normal: null, planeOffset: null,
    origin: null, matrix: null, alongRowInclination: null, crossSlope: null, slope: null,
    observations: 0, occupiedCells: 0, batches: 0, alongExtentM: 0, acrossExtentM: 0, inlierFraction: 0,
    robustResidualM: null, rmsResidualM: null, p95ResidualM: null, eigenvalues: null,
    uncertaintyDeg: null, heldOutDifferenceDeg: null, stabilityDeg: null,
    limitations: [
      "precision unverified: no independent floor or rendered-height measurement",
      "local fit cannot establish that the route beyond the sampled region shares this plane",
    ],
  };
  const valid = input.observations.filter((o) => {
    if (o.epoch !== input.epoch || ![...o.point, ...o.camera].every(Number.isFinite)) return false;
    const range = length(subtract(o.point, o.camera));
    return range >= CALIBRATION.minRange && range <= CALIBRATION.maxRange &&
      dot(subtract(o.camera, o.point), g) > CALIBRATION.minBelowCamera;
  });
  // Keep source-specific groups; never blend sources as equally accurate.
  const bySource = new Map<string, SurfaceObservation[]>();
  for (const o of valid) bySource.set(o.source, [...(bySource.get(o.source) ?? []), o]);
  let chosen: string | null = null;
  for (const source of [...bySource.keys()].sort()) {
    const count = cellsFor(bySource.get(source)!, input.origin, xAxis, zAxis).length;
    result.sourceCells[source] = count;
    if (chosen === null || count > result.sourceCells[chosen]) chosen = source;
  }
  if (chosen === null) {
    result.reasons.push("no valid floor samples");
    return result;
  }
  result.source = chosen;
  const cells = cellsFor(bySource.get(chosen)!, input.origin, xAxis, zAxis);
  const means = cells.map((cell) => scale(cell.samples.reduce((sum, o) => add(sum, o.point), [0, 0, 0] as Vec3), 1 / cell.samples.length));
  const consensus = means.length >= 3 ? ransac(means, g) : null;
  if (!consensus) {
    result.reasons.push("no floor-plane consensus");
    return result;
  }
  const samples = cells.flatMap((cell) => cell.samples.map((o) => ({ o, cell, weight: 1 / cell.samples.length })));
  const totalWeight = samples.reduce((sum, s) => sum + s.weight, 0);
  let plane: PlaneFit | null = null;
  let inliers = samples.filter((s) => Math.abs(dot(consensus.normal, subtract(s.o.point, consensus.point))) <= CALIBRATION.inlierThreshold);
  for (let pass = 0; pass < 2; pass++) {
    plane = weightedPlane(inliers.map((s) => s.o.point), inliers.map((s) => s.weight), g);
    if (!plane) break;
    const fitted = plane;
    inliers = samples.filter((s) => Math.abs(dot(fitted.normal, subtract(s.o.point, fitted.centroid))) <= CALIBRATION.inlierThreshold);
  }
  if (!plane || inliers.length < 3 || dot(plane.normal, g) <= 0.5) {
    result.reasons.push("plane refinement failed or surface too steep");
    return result;
  }
  const { centroid, normal } = plane;
  const inlierCells = new Map(inliers.map((s) => [s.cell.key, s.cell]));
  const is = [...inlierCells.values()].map((c) => c.i);
  const js = [...inlierCells.values()].map((c) => c.j);
  const residuals = inliers.map((s) => dot(normal, subtract(s.o.point, centroid)));
  const absolute = residuals.map(Math.abs).sort((a, b) => a - b);
  const inlierWeight = inliers.reduce((sum, s) => sum + s.weight, 0);
  const shift = dot(normal, subtract(centroid, input.origin)) / dot(normal, g);
  const origin = add(input.origin, scale(g, shift));
  const frame = rowFrame(origin, normal, input.heading, g);
  Object.assign(result, {
    normal, planeOffset: -dot(normal, centroid), origin,
    matrix: frame?.matrix ?? null,
    alongRowInclination: frame?.alongRowInclination ?? null,
    crossSlope: frame?.crossSlope ?? null,
    slope: (Math.acos(Math.min(1, dot(normal, g))) * 180) / Math.PI,
    observations: samples.length,
    occupiedCells: inlierCells.size,
    batches: new Set(inliers.map((s) => s.o.batch)).size,
    alongExtentM: (Math.max(...is) - Math.min(...is) + 1) * CALIBRATION.cellSize,
    acrossExtentM: (Math.max(...js) - Math.min(...js) + 1) * CALIBRATION.cellSize,
    inlierFraction: inlierWeight / totalWeight,
    robustResidualM: 1.4826 * median(absolute),
    rmsResidualM: Math.sqrt(inliers.reduce((sum, s, i) => sum + s.weight * residuals[i] * residuals[i], 0) / inlierWeight),
    p95ResidualM: absolute[Math.floor(0.95 * (absolute.length - 1))],
    eigenvalues: plane.eigenvalues,
  });
  const inclination = (fit: PlaneFit | null) => {
    if (!fit) return null;
    const f = rowFrame(origin, fit.normal, input.heading, g);
    return f ? f.alongRowInclination : null;
  };
  // Frame-block bootstrap: resample whole batches, not neighbouring pixels.
  const batches = [...new Set(inliers.map((s) => s.o.batch))].sort((a, b) => a - b);
  if (batches.length >= 3) {
    const random = mulberry32(CALIBRATION.bootstrapSeed);
    const values: number[] = [];
    for (let rep = 0; rep < CALIBRATION.bootstrapReps; rep++) {
      const draw = batches.map(() => batches[Math.floor(random() * batches.length)]);
      const chosenSamples = draw.flatMap((batch) => inliers.filter((s) => s.o.batch === batch));
      const value = inclination(weightedPlane(chosenSamples.map((s) => s.o.point), chosenSamples.map((s) => s.weight), g));
      if (value !== null) values.push(value);
    }
    if (values.length >= 2) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      result.uncertaintyDeg = 1.96 * Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
    }
  }
  // Held-out spatial cells: checkerboard halves must agree.
  const halves = [0, 1].map((parity) => inliers.filter((s) => Math.abs(s.cell.i + s.cell.j) % 2 === parity));
  const halfCells = halves.map((half) => new Set(half.map((s) => s.cell.key)).size);
  if (halfCells.every((count) => count >= 3)) {
    const [a, b] = halves.map((half) => inclination(weightedPlane(half.map((s) => s.o.point), half.map((s) => s.weight), g)));
    if (a !== null && b !== null) result.heldOutDifferenceDeg = Math.abs(a - b);
  }
  if (result.alongRowInclination !== null && input.recentInclinations?.length) {
    const all = [...input.recentInclinations, result.alongRowInclination];
    result.stabilityDeg = Math.max(...all) - Math.min(...all);
  }
  const gates = CALIBRATION.commit;
  const spread = Math.sqrt(Math.max(0, plane.eigenvalues[1]));
  if (!frame) result.reasons.push("row orientation undefined on this plane");
  if (result.occupiedCells < gates.cells) result.reasons.push(`cells ${result.occupiedCells}/${gates.cells}`);
  if (result.batches < gates.batches) result.reasons.push(`batches ${result.batches}/${gates.batches}`);
  if (result.alongExtentM < gates.alongM) result.reasons.push(`along ${result.alongExtentM.toFixed(1)}/${gates.alongM} m`);
  if (result.acrossExtentM < gates.acrossM) result.reasons.push(`across ${result.acrossExtentM.toFixed(1)}/${gates.acrossM} m`);
  if (result.inlierFraction < gates.inlierFraction) result.reasons.push(`inliers ${(result.inlierFraction * 100).toFixed(0)}%`);
  if (spread < gates.minSpreadM) result.reasons.push("near-collinear support");
  if (result.reasons.length) return result;
  const r = CALIBRATION.research;
  const research =
    result.occupiedCells >= r.cells && result.batches >= r.batches &&
    result.alongExtentM >= r.alongM && result.acrossExtentM >= r.acrossM &&
    result.inlierFraction >= r.inlierFraction && (result.robustResidualM ?? Infinity) <= r.residualM &&
    result.stabilityDeg !== null && result.stabilityDeg <= r.stabilityDeg &&
    result.uncertaintyDeg !== null && result.uncertaintyDeg <= r.intervalDeg;
  result.status = research ? "research_consistent" : "measured";
  return result;
}

