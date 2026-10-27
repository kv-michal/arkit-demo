/** The aimed point is the camera-facing bottom edge; local +Z faces the viewer. */
export const rectangleDepth = (width: number) => width * 0.45;
export const rectangleCenterZ = (width: number) => -rectangleDepth(width) / 2;
export function rectangleOffset(index: number, width: number) {
  return index === 0 ? 0 : (index % 2 === 1 ? -1 : 1) * Math.ceil(index / 2) * width;
}
