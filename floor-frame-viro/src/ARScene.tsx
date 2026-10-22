import { memo, useMemo } from "react";
import {
  ViroARScene,
  ViroAmbientLight,
  ViroDirectionalLight,
  ViroNode,
  Viro3DObject,
  ViroBox,
  ViroMaterials,
} from "@reactvision/react-viro";
import { modelStore } from "./placement";

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
const MODEL = require("../assets/block.obj");
const DETECTION = ["PlanesHorizontal"];
const DIRECTION: [number, number, number] = [0, -1, -0.4];

export function FloorScene() {
  const { pose, width } = modelStore.useValue();
  const height = width * 0.5;
  return (
    <ViroARScene anchorDetectionTypes={DETECTION} toneMappingEnabled={false}>
      <ViroAmbientLight color="#ffffff" intensity={600} />
      <ViroDirectionalLight
        color="#ffffff"
        intensity={500}
        direction={DIRECTION}
        castsShadow={false}
      />
      {pose ? (
        <ViroNode position={pose.position} rotation={pose.rotation}>
          <Viro3DObject
            source={MODEL}
            type="OBJ"
            materials="block"
            scale={[width, width, width]}
            position={[0, height / 2 + 0.001, 0]}
          />
          <BoundingBox width={width} />
        </ViroNode>
      ) : null}
    </ViroARScene>
  );
}

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
