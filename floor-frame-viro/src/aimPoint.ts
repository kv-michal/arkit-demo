export type AimPoint = {
  x: number;
  y: number;
  adjacentX: number;
  adjacentY: number;
  /** Aim area in physical pixels, used for the calibration sample grid. */
  rect: { x: number; y: number; width: number; height: number };
};
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
    rect: { x: Math.round(x * pixelRatio), y: Math.round(y * pixelRatio), width: Math.round(width * pixelRatio), height: Math.round(height * pixelRatio) },
  };
}

/** Pixel location of a grid fraction inside the aim area. */
export function aimGridPixel(aim: AimPoint, fraction: [number, number]): [number, number] {
  return [
    Math.round(aim.rect.x + fraction[0] * aim.rect.width),
    Math.round(aim.rect.y + fraction[1] * aim.rect.height),
  ];
}
