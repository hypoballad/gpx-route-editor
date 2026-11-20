import { distance, projectToSegment, samePoint } from '../geo.ts';
import type { Point } from '../geo.ts';
import type { Candidate, RouteInput, RouteResult } from './protocol.ts';

type Layer = { id: string; name: string; lines: Point[][] };
type Run = { name: string; section: number; points: Point[]; length: number };
type Edge = { id: string; run: Run; index: number; start: number; length: number };
type Match = { candidate: Candidate; edge: Edge; location: number };
type Policy = { fromTransfer?: boolean; toTransfer?: boolean; fromOsm?: boolean; toOsm?: boolean };
const cell = 0.01;
const tieMeters = 5;
export const transferMeters = 50;
export const referenceRoadId = (id?: string) => id?.startsWith('gpx:') ?? false;

function addDistinct(points: Point[], point: Point) {
  if (!points.length || !samePoint(points.at(-1)!, point)) points.push(point);
}

function sameLoopEndpoint(a: Match, b: Match) {
  if (a === b) return true;
  const { run } = a.edge;
  return run === b.edge.run && Math.min(a.location, b.location) <= 25
    && Math.max(a.location, b.location) >= run.length - 25
    && distance(run.points[0], run.points.at(-1)!) <= 10;
}

export class ReferenceNetwork {
  private cells = new Map<string, Edge[]>();
  private large: Edge[] = [];
  private edges = new Map<string, Edge>();

  constructor(layers: Layer[]) {
    for (const { id, name, lines } of layers) for (const [section, points] of lines.entries()) {
      const run = { name, section: section + 1, points, length: 0 };
      let start = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const [a, b] = [points[i], points[i + 1]];
        if (samePoint(a, b)) continue;
        const length = distance(a, b);
        const edge = { id: `gpx:${id}:${section}:${i}`, run, index: i, start, length };
        this.edges.set(edge.id, edge);
        start += length;
        const west = Math.floor(Math.min(a[0], b[0]) / cell);
        const east = Math.floor(Math.max(a[0], b[0]) / cell);
        const south = Math.floor(Math.min(a[1], b[1]) / cell);
        const north = Math.floor(Math.max(a[1], b[1]) / cell);
        if ((east - west + 1) * (north - south + 1) > 64) {
          this.large.push(edge);
          continue;
        }
        for (let y = south; y <= north; y++) for (let x = west; x <= east; x++) {
          const key = `${x}:${y}`;
          const edges = this.cells.get(key);
          if (edges) edges.push(edge);
          else this.cells.set(key, [edge]);
        }
      }
      run.length = start;
    }
  }

  private match(point: Point, edge: Edge): Match {
    const { index, run, start, length } = edge;
    const { fraction, projected } = projectToSegment(point, run.points[index], run.points[index + 1]);
    const location = start + fraction * length;
    return { edge, location, candidate: {
      id: edge.id, point: projected, meters: distance(point, projected),
      reference: { name: run.name, section: run.section, metersAlong: location },
    } };
  }

  private nearby(point: Point, radius: number, accept?: (match: Match) => boolean) {
    const [lon, lat] = point;
    const dy = radius / 110000;
    const dx = dy / Math.cos((Math.abs(lat) + dy) * Math.PI / 180);
    const edges = new Set(this.large);
    for (let y = Math.floor((lat - dy) / cell); y <= Math.floor((lat + dy) / cell); y++) {
      for (let x = Math.floor((lon - dx) / cell); x <= Math.floor((lon + dx) / cell); x++) {
        for (const edge of this.cells.get(`${x}:${y}`) ?? []) edges.add(edge);
      }
    }
    const matches: Match[] = [];
    for (const edge of edges) {
      const match = this.match(point, edge);
      if (match.candidate.meters <= radius && (!accept || accept(match))) matches.push(match);
    }
    matches.sort((a, b) => a.candidate.meters - b.candidate.meters);
    const distinct: Match[] = [];
    for (const match of matches) {
      if (!distinct.some((other) => other.edge.run === match.edge.run && Math.abs(other.location - match.location) < 14)) {
        distinct.push(match);
        if (distinct.length === 20) break;
      }
    }
    return distinct;
  }

  pick(point: Point, hit: (position: Point) => boolean) {
    const matches = this.nearby(point, transferMeters, ({ candidate }) => hit(candidate.point));
    if (!matches.length) return undefined;
    const first = matches[0].candidate;
    const second = matches[1]?.candidate;
    return second && second.meters - first.meters <= tieMeters ? { point, id: undefined } : first;
  }

  route(input: RouteInput, policy: Policy): RouteResult | undefined {
    if (!this.edges.size) return undefined;
    const endpoint = (point: Point, choice: string | undefined, osm: boolean | undefined) => {
      if (osm) return { options: [], active: [] };
      const options = this.nearby(point, 150);
      const edge = choice ? this.edges.get(choice) : undefined;
      const chosen = edge && this.match(point, edge);
      if (chosen && chosen.candidate.meters <= 150) {
        return {
          options: [chosen, ...options.filter((match) => match.edge.id !== chosen.edge.id)].slice(0, 20),
          active: [chosen],
        };
      }
      const limit = Math.min(transferMeters, (options[0]?.candidate.meters ?? 0) + tieMeters);
      return { options, active: options.filter(({ candidate }) => candidate.meters <= limit) };
    };
    const from = endpoint(input.from, input.fromChoice, policy.fromOsm);
    const to = endpoint(input.to, input.toChoice, policy.toOsm);
    if (!from.active.length && !to.active.length) return undefined;
    const options = { fromOptions: from.options.map(({ candidate }) => candidate), toOptions: to.options.map(({ candidate }) => candidate) };
    const pairs = from.active.flatMap((a) => to.active.filter((b) => a.edge.run === b.edge.run)
      .map((b) => ({ a, b, length: Math.abs(a.location - b.location) })))
      .sort((left, right) => left.length - right.length);
    if (!pairs.length) {
      if ((!from.active.length || policy.fromTransfer) && (!to.active.length || policy.toTransfer)) return undefined;
      return { ...options, error: 'reference-link', fromSnap: from.active[0]?.candidate, toSnap: to.active[0]?.candidate };
    }
    const [best, next] = pairs;
    // An outlying detour is often the other end of a loop at its start/finish.
    // Keep a choice when both waypoints may be at that same location.
    if (next && (best.length < 20 || next.length < Math.max(best.length * 3, best.length + 1000)
      || pairs.slice(1).some(({ a, b }) => !sameLoopEndpoint(best.a, a) || !sameLoopEndpoint(best.b, b)))) {
      return { ...options, error: 'reference-choice' };
    }
    const { a, b } = best;
    const [first, last] = a.location <= b.location ? [a, b] : [b, a];
    const points = [first.candidate.point];
    for (let i = first.edge.index + 1; i <= last.edge.index; i++) addDistinct(points, first.edge.run.points[i]);
    addDistinct(points, last.candidate.point);
    if (first !== a) points.reverse();
    if (points.length === 1) points.push(points[0]);
    return { ...options, points, fromSnap: a.candidate, toSnap: b.candidate, referenceName: a.edge.run.name };
  }
}

export function attachTransfers(result: RouteResult, input: RouteInput, policy: Policy): RouteResult {
  if (!result.points || (!policy.fromTransfer && !policy.toTransfer)) return result;
  if ((policy.fromTransfer && (result.fromSnap?.meters ?? Infinity) > transferMeters)
    || (policy.toTransfer && (result.toSnap?.meters ?? Infinity) > transferMeters)) {
    return { ...result, points: undefined, error: 'reference-link' };
  }
  const points = [...result.points];
  if (policy.fromTransfer && !samePoint(input.from, points[0])) points.unshift(input.from);
  if (policy.toTransfer && !samePoint(input.to, points.at(-1)!)) points.push(input.to);
  return { ...result, points };
}
