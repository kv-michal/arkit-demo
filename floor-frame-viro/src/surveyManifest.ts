import { length, subtract, type Vec3 } from "./surfacePose";
import { weightedPlane } from "./floorCalibration";
import { isRigid } from "./viroGeometry";

/**
 * IMPLEMENTATION_PLAN section 8: versioned survey contract. Marker frame
 * convention (ARKit image anchor): origin at the printed image centre, +X to
 * the image's right, +Z toward the image's bottom edge, +Y out of the face.
 * Print margins and mounting offsets must already be corrected here.
 */
export const SURVEY_SCHEMA = "floorframe.survey/1";

export type SurveyReference = {
  id: string;
  image: { asset: string; sha256?: string };
  physicalWidthM: number;
  physicalHeightM: number;
  /** Column-major 4x4, metres. */
  surveyFromMarker: number[];
  uncertainty: { positionM: number; rotationDeg: number; confidence: string };
  role: "correction" | "heldOutValidation";
};

export type SurveyFloor = {
  normal: Vec3;
  point: Vec3;
  rmsResidualM: number;
  maxResidualM: number;
  extentRadiusM: number;
  uncertaintyM: number;
};

export type SurveyManifest = {
  surveyId: string;
  revision: number;
  references: SurveyReference[];
  floor: SurveyFloor;
  validRouteExtentM: number;
};

export type SurveyValidation =
  | { ok: true; manifest: SurveyManifest }
  | { ok: false; errors: string[] };

const MAX_FLOOR_RMS_M = 0.01;

const finitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Rejects anything ambiguous; never fills in a default datum or unit. */
export function validateSurvey(input: unknown): SurveyValidation {
  const errors: string[] = [];
  const raw = (input ?? {}) as Record<string, unknown>;
  if (raw.schema !== SURVEY_SCHEMA) errors.push("schema");
  if (typeof raw.surveyId !== "string" || !raw.surveyId) errors.push("surveyId");
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) errors.push("revision");
  if (raw.units !== "m") errors.push("units");
  const convention = (raw.convention ?? {}) as Record<string, unknown>;
  if (convention.handedness !== "right" || convention.up !== "+Y" || convention.matrixLayout !== "column-major")
    errors.push("convention");
  if (!finitePositive(raw.validRouteExtentM)) errors.push("validRouteExtentM");
  const references: SurveyReference[] = [];
  const ids = new Set<string>();
  const list = Array.isArray(raw.references) ? raw.references : [];
  if (!list.length) errors.push("references");
  for (const [index, entry] of list.entries()) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const at = `references[${index}]`;
    const id = typeof r.id === "string" && r.id ? r.id : null;
    if (!id) errors.push(`${at}.id`);
    else if (ids.has(id)) errors.push(`${at}.duplicateId`);
    else ids.add(id);
    const image = (r.image ?? {}) as Record<string, unknown>;
    if (typeof image.asset !== "string" || !image.asset) errors.push(`${at}.image.asset`);
    if (!finitePositive(r.physicalWidthM)) errors.push(`${at}.physicalWidthM`);
    if (!finitePositive(r.physicalHeightM)) errors.push(`${at}.physicalHeightM`);
    const matrix = Array.isArray(r.surveyFromMarker) ? (r.surveyFromMarker as number[]) : [];
    if (!isRigid(matrix)) errors.push(`${at}.surveyFromMarker`);
    const u = (r.uncertainty ?? {}) as Record<string, unknown>;
    if (!finitePositive(u.positionM) || !finitePositive(u.rotationDeg) || typeof u.confidence !== "string" || !u.confidence)
      errors.push(`${at}.uncertainty`);
    if (r.role !== "correction" && r.role !== "heldOutValidation") errors.push(`${at}.role`);
    if (id) references.push({
      id,
      image: { asset: String(image.asset), sha256: typeof image.sha256 === "string" ? image.sha256 : undefined },
      physicalWidthM: r.physicalWidthM as number,
      physicalHeightM: r.physicalHeightM as number,
      surveyFromMarker: matrix,
      uncertainty: { positionM: u.positionM as number, rotationDeg: u.rotationDeg as number, confidence: String(u.confidence) },
      role: r.role as SurveyReference["role"],
    });
  }
  if (!references.some((r) => r.role === "correction")) errors.push("noCorrectionReference");
  const floorRaw = (raw.floorControl ?? {}) as Record<string, unknown>;
  const points = Array.isArray(floorRaw.points) ? (floorRaw.points as Vec3[]) : [];
  let floor: SurveyFloor | null = null;
  if (points.length < 3 || !points.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)))
    errors.push("floorControl.points");
  else if (!finitePositive(floorRaw.uncertaintyM)) errors.push("floorControl.uncertaintyM");
  else {
    const fit = weightedPlane(points, points.map(() => 1));
    if (!fit || Math.sqrt(Math.max(0, fit.eigenvalues[1])) < 0.05) errors.push("floorControl.collinear");
    else if (fit.normal[1] <= 0.5) errors.push("floorControl.notFloor");
    else {
      const residuals = points.map((p) => Math.abs(
        fit.normal[0] * (p[0] - fit.centroid[0]) + fit.normal[1] * (p[1] - fit.centroid[1]) + fit.normal[2] * (p[2] - fit.centroid[2])));
      const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
      if (rms > MAX_FLOOR_RMS_M) errors.push("floorControl.nonPlanar");
      floor = {
        normal: fit.normal,
        point: fit.centroid,
        rmsResidualM: rms,
        maxResidualM: Math.max(...residuals),
        extentRadiusM: Math.max(...points.map((p) => length(subtract(p, fit.centroid)))),
        uncertaintyM: floorRaw.uncertaintyM as number,
      };
    }
  }
  if (errors.length || !floor) return { ok: false, errors: errors.length ? errors : ["floorControl"] };
  return {
    ok: true,
    manifest: {
      surveyId: raw.surveyId as string,
      revision: raw.revision as number,
      references,
      floor,
      validRouteExtentM: raw.validRouteExtentM as number,
    },
  };
}
