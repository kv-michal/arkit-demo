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
  edge: { lightingModel: "Constant", diffuseColor: "#ffffff" },
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
          <ViroBox
            width={width}
            height={height * 0.15}
            length={width * 0.008}
            position={[0, height + 0.001, -width * 0.215]}
            materials="edge"
          />
          <ViroBox
            width={width}
            height={height * 0.15}
            length={width * 0.008}
            position={[0, height + 0.001, width * 0.215]}
            materials="edge"
          />
        </ViroNode>
      ) : null}
    </ViroARScene>
  );
}
