import Foundation
import simd

/// IMPLEMENTATION_PLAN section 8: versioned survey contract; port of
/// surveyManifest.ts. Marker frame convention (ARKit image anchor): origin at
/// the printed image centre, +X to the image's right, +Z toward the image's
/// bottom edge, +Y out of the face. Print margins and mounting offsets must
/// already be corrected in the manifest.
struct SurveyManifest {
    static let schema = "floorframe.survey/1"
    static let maxFloorRmsM = 0.01

    enum Role: String { case correction, heldOutValidation }
    struct Reference {
        let id: String
        let asset: String
        let sha256: String?
        let physicalWidthM: Double
        let physicalHeightM: Double
        let surveyFromMarker: Mat4
        let positionUncertaintyM: Double
        let rotationUncertaintyDeg: Double
        let confidence: String
        let role: Role
    }
    struct Floor {
        let normal: Vec3
        let point: Vec3
        let rmsResidualM: Double
        let maxResidualM: Double
        let extentRadiusM: Double
        let uncertaintyM: Double
    }

    let surveyId: String
    let revision: Int
    let references: [Reference]
    let floor: Floor
    let validRouteExtentM: Double

    enum Validation { case ok(SurveyManifest), failed([String]) }

    private static func positive(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, !(value is Bool) else { return nil }
        let d = number.doubleValue
        return d.isFinite && d > 0 ? d : nil
    }
    private static func numbers(_ value: Any?) -> [Double]? {
        guard let array = value as? [Any] else { return nil }
        let values = array.compactMap { ($0 as? NSNumber)?.doubleValue }
        return values.count == array.count ? values : nil
    }

    /// Rejects anything ambiguous; never fills in a default datum or unit.
    static func validate(_ input: Any?) -> Validation {
        var errors: [String] = []
        let raw = input as? [String: Any] ?? [:]
        if raw["schema"] as? String != schema { errors.append("schema") }
        let surveyId = raw["surveyId"] as? String ?? ""
        if surveyId.isEmpty { errors.append("surveyId") }
        let revision = (raw["revision"] as? NSNumber).flatMap { $0.doubleValue == $0.doubleValue.rounded() ? $0.intValue : nil } ?? 0
        if revision < 1 { errors.append("revision") }
        if raw["units"] as? String != "m" { errors.append("units") }
        let convention = raw["convention"] as? [String: Any] ?? [:]
        if convention["handedness"] as? String != "right" || convention["up"] as? String != "+Y"
            || convention["matrixLayout"] as? String != "column-major" { errors.append("convention") }
        let extent = positive(raw["validRouteExtentM"])
        if extent == nil { errors.append("validRouteExtentM") }
        var references: [Reference] = []
        var ids = Set<String>()
        let list = raw["references"] as? [Any] ?? []
        if list.isEmpty { errors.append("references") }
        for (index, entry) in list.enumerated() {
            let r = entry as? [String: Any] ?? [:]
            let at = "references[\(index)]"
            let id = (r["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            if id == nil { errors.append("\(at).id") }
            else if ids.contains(id!) { errors.append("\(at).duplicateId") }
            else { ids.insert(id!) }
            let image = r["image"] as? [String: Any] ?? [:]
            let asset = image["asset"] as? String ?? ""
            if asset.isEmpty { errors.append("\(at).image.asset") }
            let width = positive(r["physicalWidthM"]), height = positive(r["physicalHeightM"])
            if width == nil { errors.append("\(at).physicalWidthM") }
            if height == nil { errors.append("\(at).physicalHeightM") }
            let matrixValues = numbers(r["surveyFromMarker"]) ?? []
            let matrix = MatrixMath.isRigid(matrixValues) ? MatrixMath.matrix(matrixValues) : nil
            if matrix == nil { errors.append("\(at).surveyFromMarker") }
            let u = r["uncertainty"] as? [String: Any] ?? [:]
            let positionU = positive(u["positionM"]), rotationU = positive(u["rotationDeg"])
            let confidence = u["confidence"] as? String ?? ""
            if positionU == nil || rotationU == nil || confidence.isEmpty { errors.append("\(at).uncertainty") }
            let role = (r["role"] as? String).flatMap(Role.init(rawValue:))
            if role == nil { errors.append("\(at).role") }
            if let id, let width, let height, let matrix, let positionU, let rotationU, let role, !confidence.isEmpty, !asset.isEmpty {
                references.append(Reference(id: id, asset: asset, sha256: image["sha256"] as? String, physicalWidthM: width,
                    physicalHeightM: height, surveyFromMarker: matrix, positionUncertaintyM: positionU,
                    rotationUncertaintyDeg: rotationU, confidence: confidence, role: role))
            }
        }
        // Count roles from the raw list so a malformed board cannot hide a missing role.
        if !list.contains(where: { ($0 as? [String: Any])?["role"] as? String == Role.correction.rawValue }) {
            errors.append("noCorrectionReference")
        }
        let floorRaw = raw["floorControl"] as? [String: Any] ?? [:]
        let rawPoints = floorRaw["points"] as? [Any] ?? []
        let points = rawPoints.compactMap { numbers($0).flatMap(MatrixMath.vec) }
        var floor: Floor?
        if points.count < 3 || points.count != rawPoints.count {
            errors.append("floorControl.points")
        } else if let uncertainty = positive(floorRaw["uncertaintyM"]) {
            if let fit = FloorCalibration.weightedPlane(points, points.map { _ in 1 }),
               max(0, fit.eigenvalues[1]).squareRoot() >= 0.05 {
                if fit.normal.y <= 0.5 {
                    errors.append("floorControl.notFloor")
                } else {
                    let residuals = points.map { abs(simd_dot(fit.normal, $0 - fit.centroid)) }
                    let rms = (residuals.reduce(0) { $0 + $1 * $1 } / Double(residuals.count)).squareRoot()
                    if rms > maxFloorRmsM { errors.append("floorControl.nonPlanar") }
                    floor = Floor(normal: fit.normal, point: fit.centroid, rmsResidualM: rms, maxResidualM: residuals.max()!,
                                  extentRadiusM: points.map { simd_distance($0, fit.centroid) }.max()!, uncertaintyM: uncertainty)
                }
            } else {
                errors.append("floorControl.collinear")
            }
        } else {
            errors.append("floorControl.uncertaintyM")
        }
        guard errors.isEmpty, let floor, let extent else { return .failed(errors.isEmpty ? ["floorControl"] : errors) }
        return .ok(SurveyManifest(surveyId: surveyId, revision: revision, references: references, floor: floor, validRouteExtentM: extent))
    }
}
