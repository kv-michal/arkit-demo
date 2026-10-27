import ARKit
import UIKit

/// IMPLEMENTATION_PLAN section 8: surveyed image boards for native ARKit.
/// Keeps the world-tracking session (mesh/occlusion) and adds detection images
/// with continuous tracking explicitly configured (the default of zero is not
/// continuous). Device behaviour (axes, timing, loss) is unverified.
final class ImageReferenceAdapter {
    let manifest: SurveyManifest
    private(set) var images = Set<ARReferenceImage>()
    private(set) var registeredIDs: [String] = []
    private(set) var missingIDs: [String] = []

    init(manifest: SurveyManifest) {
        self.manifest = manifest
        for reference in manifest.references {
            guard let image = Self.image(named: reference.asset)?.cgImage else { missingIDs.append(reference.id); continue }
            let referenceImage = ARReferenceImage(image, orientation: .up, physicalWidth: CGFloat(reference.physicalWidthM))
            referenceImage.name = reference.id
            images.insert(referenceImage)
            registeredIDs.append(reference.id)
        }
    }

    private static func image(named asset: String) -> UIImage? {
        if let url = Bundle.main.url(forResource: asset, withExtension: nil, subdirectory: "Survey") ?? Bundle.main.url(forResource: asset, withExtension: nil) {
            return UIImage(contentsOfFile: url.path)
        }
        return UIImage(named: asset)
    }

    func configure(_ config: ARWorldTrackingConfiguration) {
        guard !images.isEmpty else { return }
        config.detectionImages = images
        // Initially two for an overlapping pair; Apple documents a maximum of four.
        config.maximumNumberOfTrackedImages = min(2, images.count)
    }

    func observation(_ anchor: ARImageAnchor, timestamp: TimeInterval, epoch: Int) -> ReferenceFusion.Observation? {
        guard let id = anchor.referenceImage.name else { return nil }
        return .init(id: id, worldFromMarker: MatrixMath.double(anchor.transform), timestamp: timestamp, epoch: epoch, tracking: anchor.isTracked)
    }

    /// Reads Survey/survey.json from the app bundle. None ships by default.
    static func loadBundledSurvey() -> (manifest: SurveyManifest?, event: String, data: [String: Any]) {
        guard let url = Bundle.main.url(forResource: "survey", withExtension: "json", subdirectory: "Survey")
                ?? Bundle.main.url(forResource: "survey", withExtension: "json"),
              let data = try? Data(contentsOf: url) else {
            return (nil, "survey_unavailable", ["reason": "no bundled survey manifest"])
        }
        switch SurveyManifest.validate(try? JSONSerialization.jsonObject(with: data)) {
        case .ok(let manifest):
            return (manifest, "survey_loaded", ["surveyId": manifest.surveyId, "revision": manifest.revision,
                "references": manifest.references.map { ["id": $0.id, "role": $0.role.rawValue] },
                "floor": ["normal": MatrixMath.vector(manifest.floor.normal), "point": MatrixMath.vector(manifest.floor.point),
                          "rmsResidualM": manifest.floor.rmsResidualM, "extentRadiusM": manifest.floor.extentRadiusM]])
        case .failed(let errors):
            return (nil, "survey_invalid", ["errors": errors])
        }
    }
}
