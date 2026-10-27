export type AimPoint = { x: number; y: number; adjacentX: number; adjacentY: number };
/** Viro screen hit tests take physical pixels, while React Native layout uses points. */
export function aimPointFromLayout(
  layout: { x: number; y: number; width: number; height: number },
  pixelRatio: number,
): AimPoint | null {
  const { x, y, width, height } = layout;
  if (![x, y, width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0 || pixelRatio <= 0) return null;
  const centerX = Math.round((x + width / 2) * pixelRatio);
  const centerY = Math.round((y + height / 2) * pixelRatio);
  return {
    x: centerX, y: centerY,
    adjacentX: centerX + Math.max(1, Math.round(Math.min(width, height) * 0.015 * pixelRatio)),
    adjacentY: centerY - Math.max(1, Math.round(Math.min(width, height) * 0.015 * pixelRatio)),
  };
}
