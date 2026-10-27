import { memo, type ComponentType } from "react";
import { ViroARImageMarker, ViroARTrackingTargets, type ViroAnchor } from "@reactvision/react-viro";
import { placement, surveyManifest } from "./placement";
import { bundledSurvey } from "./survey/bundledSurvey";
import { diagnostics } from "./diagnostics";

/**
 * IMPLEMENTATION_PLAN section 8: surveyed image boards. Installed Viro 3.0.3
 * declares ViroARImageMarker as ViroBase<{}>, so this narrow adapter types
 * only the props its JS actually forwards. The removal callback carries no
 * payload; each marker binds its survey id in a closure. Device behaviour
 * (axes, timing, loss) is unverified.
 */
type MarkerProps = {
  target: string;
  onAnchorFound?: (anchor: ViroAnchor) => void;
  onAnchorUpdated?: (anchor: ViroAnchor) => void;
  onAnchorRemoved?: () => void;
};
const ImageMarker = ViroARImageMarker as unknown as ComponentType<MarkerProps>;

let registered = false;
function registerTargets() {
  if (registered || !surveyManifest || !bundledSurvey) return;
  registered = true;
  const targets = Object.fromEntries(surveyManifest.references.flatMap((reference) => {
    const source = bundledSurvey?.images[reference.id];
    return source === undefined ? [] : [[reference.id, { source, orientation: "Up", physicalWidth: reference.physicalWidthM }]];
  }));
  ViroARTrackingTargets.createTargets(targets);
  diagnostics.record("reference_targets_registered", { ids: Object.keys(targets), missingImages: surveyManifest.references.filter((r) => !(r.id in targets)).map((r) => r.id) }, true);
}

export const ImageReferences = memo(function ImageReferences() {
  if (!surveyManifest) return null;
  registerTargets();
  return (
    <>
      {surveyManifest.references.map((reference) => (
        <ImageMarker
          key={reference.id}
          target={reference.id}
          onAnchorFound={(anchor) => placement.markerObserved(reference.id, anchor)}
          onAnchorUpdated={(anchor) => placement.markerObserved(reference.id, anchor)}
          onAnchorRemoved={() => placement.markerRemoved(reference.id)}
        />
      ))}
    </>
  );
});
