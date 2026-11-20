import type { Bounds, Point } from '../src/geo.ts';
import { createNetwork, pack } from '../tools/osm/network.mjs';

type Line = { ids: number[]; points: Point[]; tags?: Record<string, string> };
export function makeNetwork(bounds: Bounds, lines: Line[]) {
  return pack(createNetwork(lines.map((line, index) => ({
    id: index,
    type: 'way',
    tags: { highway: 'footway', ...line.tags },
    nodes: line.ids,
    geometry: line.points.map(([lon, lat]) => ({ lon, lat })),
  })), bounds));
}

export function bufferToArrayBuffer(buffer: Uint8Array) {
  return new Uint8Array(buffer).buffer;
}
