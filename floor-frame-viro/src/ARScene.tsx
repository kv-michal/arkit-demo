import { memo, useEffect, useMemo } from "react";
import {
  ViroARScene,
  ViroAmbientLight,
  ViroDirectionalLight,
  ViroNode,
  Viro3DObject,
  ViroBox,
  ViroMaterials,
} from "@reactvision/react-viro";
import { modelStore, placement } from "./placement";
import { rectangleOffset } from "./diagnosticGeometry";
import { diagnostics } from "./diagnostics";

ViroMaterials.createMaterials({
  block: {
    lightingModel: "PBR",
    diffuseColor: "#33d9b8",
    roughness: 0.6,
    metalness: 0,
    alpha: 0.6,
    blendMode: "Alpha",
  },
  edge: {
    lightingModel: "Constant",
    diffuseColor: "#ff0000",
    alpha: 1,
    blendMode: "None",
    writesToDepthBuffer: true,
    readsFromDepthBuffer: true,
  },
});
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro resolves this static native OBJ asset.
const MODEL = require("../assets/block.obj");
const DETECTION = ["PlanesHorizontal"];
const DIRECTION: [number, number, number] = [0, -1, -0.4];
// Stable callback invoked by React at commit/unmount, outside render.
function attachScene(scene: ViroARScene | null) {
  placement.attachScene(scene);
}

export function FloorScene() {
  const { pose, width, rectangleCount } = modelStore.useValue();
  useEffect(() => {
    if (diagnostics.due("react_pose_commit", 200)) diagnostics.record("react_pose_committed", { pose, width, rectangleCount });
  }, [pose, width, rectangleCount]);
  return (
    <ViroARScene
      ref={attachScene}
      anchorDetectionTypes={DETECTION}
      toneMappingEnabled={false}
      onTrackingUpdated={placement.trackingUpdated}
      onAnchorFound={placement.anchorFound}
      onAnchorUpdated={placement.anchorUpdated}
      onAnchorRemoved={placement.anchorRemoved}
      onCameraTransformUpdate={placement.cameraUpdated}
      onAmbientLightUpdate={placement.lightUpdated}
      onARPointCloudUpdate={placement.pointCloudUpdated}
      onPlatformUpdate={placement.platformUpdated}
      onDepthReady={placement.depthReady}
    >
      <ViroAmbientLight color="#ffffff" intensity={600} />
      <ViroDirectionalLight
        color="#ffffff"
        intensity={500}
        direction={DIRECTION}
        castsShadow={false}
      />
      {pose ? (
        <ViroNode position={pose.position} rotation={pose.rotation}>
          <RectangleRow width={width} count={rectangleCount} />
        </ViroNode>
      ) : null}
    </ViroARScene>
  );
}

// Keep the static row out of the 20 Hz pose reconciliation.
const RectangleRow = memo(function RectangleRow({
  width,
  count,
}: {
  width: number;
  count: number;
}) {
  return (
    <ViroNode>
      {Array.from({ length: count }, (_, index) => {
        const offset = rectangleOffset(index, width);
        return (
          <ViroNode key={offset} position={[offset, 0, 0]}>
            <Viro3DObject
              source={MODEL}
              type="OBJ"
              materials="block"
              scale={[width, width, width]}
              position={[0, width * 0.25 + 0.001, 0]}
              onLoadEnd={(event) => diagnostics.record("model_load_end", { offset, width, result: event.nativeEvent })}
              onError={(event) => diagnostics.record("model_load_error", { offset, width, error: event.nativeEvent }, true)}
            />
            <BoundingBox width={width} />
          </ViroNode>
        );
      })}
    </ViroNode>
  );
});

// Reconcile the 12 static bars only when the selected size changes.
const BoundingBox = memo(function BoundingBox({ width }: { width: number }) {
  const edges = useMemo(() => {
    const height = width * 0.5;
    const depth = width * 0.45;
    const thickness = Math.min(0.03, Math.max(0.003, width * 0.015));
    const x = (width - thickness) / 2;
    const y = (height - thickness) / 2;
    const z = (depth - thickness) / 2;
    type Edge = {
      key: string;
      size: [number, number, number];
      position: [number, number, number];
    };
    const result: Edge[] = [];
    for (const a of [-1, 1]) {
      for (const b of [-1, 1]) {
        result.push(
          {
            key: `x-${a}-${b}`,
            size: [width, thickness, thickness],
            position: [0, a * y, b * z],
          },
          {
            key: `y-${a}-${b}`,
            size: [thickness, height, thickness],
            position: [a * x, 0, b * z],
          },
          {
            key: `z-${a}-${b}`,
            size: [thickness, thickness, depth],
            position: [a * x, b * y, 0],
          },
        );
      }
    }
    return result;
  }, [width]);
  return (
    <ViroNode position={[0, width * 0.25 + 0.001, 0]}>
      {edges.map((edge) => (
        <ViroBox
          key={edge.key}
          width={edge.size[0]}
          height={edge.size[1]}
          length={edge.size[2]}
          position={edge.position}
          materials="edge"
        />
      ))}
    </ViroNode>
  );
});
