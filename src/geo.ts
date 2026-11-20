export type Point = [lon: number, lat: number];
export type Bounds = { west: number; south: number; east: number; north: number };

const radians = Math.PI / 180;

export function distance(a: Point, b: Point) {
  const h = Math.sin((b[1] - a[1]) * radians / 2) ** 2
    + Math.cos(a[1] * radians) * Math.cos(b[1] * radians)
      * Math.sin((b[0] - a[0]) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function lineLength(points: Point[]) {
  let length = 0;
  for (let index = 1; index < points.length; index++) length += distance(points[index - 1], points[index]);
  return length;
}

export function contains(bounds: Bounds, [lon, lat]: Point) {
  return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

export function samePoint(a: Point, b: Point) {
  return a[0] === b[0] && a[1] === b[1];
}

export function projectToSegment(point: Point, a: Point, b: Point) {
  const scale = Math.cos(point[1] * radians);
  const dx = (b[0] - a[0]) * scale;
  const dy = b[1] - a[1];
  const square = dx * dx + dy * dy;
  const position = square === 0 ? 0 : ((point[0] - a[0]) * scale * dx + (point[1] - a[1]) * dy) / square;
  const fraction = Math.max(0, Math.min(1, position));
  const projected: Point = fraction === 0 ? a : fraction === 1 ? b
    : [a[0] + (b[0] - a[0]) * fraction, a[1] + dy * fraction];
  return { fraction, projected };
}
