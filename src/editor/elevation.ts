import { trackSegments } from '../gpx/export.ts';
import { distance, lineLength } from '../geo.ts';
import type { Point } from '../geo.ts';

type Sample = { point: Point; meters: number };
export type ElevationSample = Sample & { elevation?: number };
const zoom = 14;
const tileSize = 256;
const worldSize = tileSize * 2 ** zoom;
const baseUrl = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png';

function sampleRoute(lines: Point[][]) {
  const segments = trackSegments(lines);
  const length = segments.reduce((sum, points) => sum + lineLength(points), 0);
  const spacing = Math.max(25, length / 5000);
  let meters = 0;
  return segments.map((points): Sample[] => {
    const samples: Sample[] = [{ point: points[0], meters }];
    let next = meters + spacing;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      const step = distance(a, b);
      const end = meters + step;
      while (next < end) {
        const fraction = (next - meters) / step;
        const lonDelta = ((b[0] - a[0] + 540) % 360) - 180;
        samples.push({
          point: [((a[0] + lonDelta * fraction + 540) % 360) - 180, a[1] + (b[1] - a[1]) * fraction],
          meters: next,
        });
        next += spacing;
      }
      meters = end;
    }
    if (meters > samples[0].meters) samples.push({ point: points.at(-1)!, meters });
    return samples;
  });
}

function pixelAddress([lon, lat]: Point) {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  const pixelX = Math.max(0, Math.min(worldSize - 1, Math.floor((lon + 180) / 360 * worldSize)));
  const pixelY = Math.max(0, Math.min(worldSize - 1,
    Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * worldSize)));
  return {
    key: `${Math.floor(pixelX / tileSize)}/${Math.floor(pixelY / tileSize)}`,
    index: ((pixelY % tileSize) * tileSize + pixelX % tileSize) * 4,
  };
}

export function decodeElevation(pixels: Uint8ClampedArray, index: number): number | undefined {
  const value = pixels[index] * 65536 + pixels[index + 1] * 256 + pixels[index + 2];
  if (!pixels[index + 3] || value === 8388608) return undefined;
  return (value < 8388608 ? value : value - 16777216) / 100;
}

async function fetchTile(key: string) {
  const response = await fetch(`${baseUrl}/${zoom}/${key}.png`, { signal: AbortSignal.timeout(12000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('標高タイルを取得できませんでした。');
  const image = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
  try {
    if (image.width !== tileSize || image.height !== tileSize) throw new Error('標高タイルのサイズが不正です。');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = tileSize;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('標高タイルを読み取れませんでした。');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, tileSize, tileSize).data;
  } finally {
    image.close();
  }
}

const cache = new Map<string, ReturnType<typeof fetchTile>>();

function getTile(key: string) {
  const cached = cache.get(key);
  cache.delete(key);
  const request = cached ?? fetchTile(key).catch(() => {
    if (cache.get(key) === request) cache.delete(key);
    return undefined;
  });
  cache.set(key, request);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return request;
}

export async function loadElevation(lines: Point[][], signal: AbortSignal): Promise<ElevationSample[][]> {
  const addresses = new Map<string, { sample: ElevationSample; index: number }[]>();
  const segments: ElevationSample[][] = sampleRoute(lines);
  for (const sample of segments.flat()) {
    const { key, index } = pixelAddress(sample.point);
    const pending = addresses.get(key);
    if (pending) pending.push({ sample, index });
    else addresses.set(key, [{ sample, index }]);
  }
  const entries = addresses.entries();
  await Promise.all(Array.from({ length: Math.min(8, addresses.size) }, async () => {
    for (const [key, targets] of entries) {
      if (signal.aborted) return;
      const pixels = await getTile(key);
      if (pixels) for (const { sample, index } of targets) sample.elevation = decodeElevation(pixels, index);
    }
  }));
  return segments;
}
