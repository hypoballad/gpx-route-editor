import { contains, distance, lineLength, samePoint } from '../geo.ts';
import type { Bounds, Point } from '../geo.ts';
import type { Candidate, Road, RoadResult, RouteInput, RouteResult } from './protocol.ts';

export type Graph = {
  coordinates: Int32Array;
  offsets: Uint32Array;
  targets: Uint32Array;
  costs: Float32Array;
};

export function decode(buffer: ArrayBuffer, weights: number[]): Graph {
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 2 || !weights.length || weights.some((weight) => !Number.isFinite(weight) || weight < 1)) {
    throw new Error('Invalid graph format or weights');
  }
  const count = header.getUint32(4, true);
  const edges = header.getUint32(8, true);
  if (12 + count * 3 + edges > buffer.byteLength) throw new Error('Invalid graph dimensions');
  const bytes = new Uint8Array(buffer);
  let cursor = 12;
  function read() {
    let result = 0;
    for (let shift = 0; shift <= 28 && cursor < bytes.length; shift += 7) {
      const byte = bytes[cursor++];
      result += (byte & 127) * 2 ** shift;
      if (byte < 128) return result;
    }
    throw new Error('Invalid packed integer');
  }
  const signed = (number: number) => number % 2 ? -(number + 1) / 2 : number / 2;
  const coordinates = new Int32Array(count * 2);
  const offsets = new Uint32Array(count + 1);
  const targets = new Uint32Array(edges);
  const costs = new Float32Array(edges);
  const graph = { coordinates, offsets, targets, costs };
  let lon = 0;
  let lat = 0;
  for (let node = 0; node < count; node++) {
    lon += signed(read());
    lat += signed(read());
    coordinates[node * 2] = lon;
    coordinates[node * 2 + 1] = lat;
  }
  let edge = 0;
  for (let node = 0; node < count; node++) {
    offsets[node] = edge;
    const degree = read();
    if (edge + degree > edges) throw new Error('Invalid graph degree');
    const point = location(graph, node);
    for (let index = 0; index < degree; index++) {
      const value = read();
      const target = node + signed(Math.floor(value / weights.length));
      if (target < 0 || target >= count) throw new Error('Invalid directed edge');
      targets[edge] = target;
      costs[edge++] = distance(point, location(graph, target)) * weights[value % weights.length] + 0.001;
    }
  }
  offsets[count] = edge;
  if (cursor !== buffer.byteLength || edge !== edges) throw new Error('Invalid graph payload');
  return graph;
}

function location(graph: Graph, node: number): Point {
  return [graph.coordinates[node * 2] / 1e6, graph.coordinates[node * 2 + 1] / 1e6];
}

function edgeCost(graph: Graph, start: number, end: number) {
  for (let edge = graph.offsets[start]; edge < graph.offsets[start + 1]; edge++) {
    if (graph.targets[edge] === end) return graph.costs[edge];
  }
  return Infinity;
}

type Match = Candidate & { a: number; b: number; fraction: number; forward: number; backward: number };
const CELL = 2500;
const AUTO_METERS = 50;
const REVIEW_METERS = 150;
const MAX_VIEWPORT_EDGES = 30_000;

function clipToBounds(a: Point, b: Point, bounds: Bounds): [Point, Point] | undefined {
  let start = 0;
  let end = 1;
  const limits = [[bounds.west, bounds.east], [bounds.south, bounds.north]];
  for (const [axis, [min, max]] of limits.entries()) {
    const delta = b[axis] - a[axis];
    if (!delta) {
      if (a[axis] < min || a[axis] > max) return;
      continue;
    }
    const near = (min - a[axis]) / delta;
    const far = (max - a[axis]) / delta;
    start = Math.max(start, Math.min(near, far));
    end = Math.min(end, Math.max(near, far));
    if (start >= end) return;
  }
  const at = (fraction: number): Point => [
    Math.max(bounds.west, Math.min(bounds.east, a[0] + fraction * (b[0] - a[0]))),
    Math.max(bounds.south, Math.min(bounds.north, a[1] + fraction * (b[1] - a[1]))),
  ];
  return [at(start), at(end)];
}

function project(point: Point, a: Point, b: Point) {
  const scale = Math.cos(point[1] * Math.PI / 180);
  const dx = (b[0] - a[0]) * scale;
  const dy = b[1] - a[1];
  const square = dx * dx + dy * dy;
  const position = square === 0 ? 0 : ((point[0] - a[0]) * scale * dx + (point[1] - a[1]) * dy) / square;
  const fraction = Math.max(0, Math.min(1, position));
  const projected: Point = fraction === 0 ? a : fraction === 1 ? b
    : [a[0] + (b[0] - a[0]) * fraction, a[1] + dy * fraction];
  return { fraction, projected };
}

class SegmentIndex {
  private graph: Graph;
  private x0: number;
  private y0: number;
  private width: number;
  private height: number;
  private offsets: Uint32Array;
  private starts: Uint32Array;
  private ends: Uint32Array;
  private parents: Uint32Array;

  constructor(graph: Graph, bounds: Bounds) {
    this.graph = graph;
    this.x0 = Math.floor(bounds.west * 1e6 / CELL);
    this.y0 = Math.floor(bounds.south * 1e6 / CELL);
    this.width = Math.floor(bounds.east * 1e6 / CELL) - this.x0 + 1;
    this.height = Math.floor(bounds.north * 1e6 / CELL) - this.y0 + 1;
    const cells = this.width * this.height;
    if (cells <= 0 || cells > 1_000_000) throw new Error('Invalid graph bounds');
    this.offsets = new Uint32Array(cells + 1);
    this.parents = Uint32Array.from({ length: graph.offsets.length - 1 }, (_, index) => index);
    const size = new Uint32Array(this.parents.length).fill(1);
    this.forSegments((a, b) => {
      const left = this.component(a);
      const right = this.component(b);
      if (left !== right) {
        const [larger, smaller] = size[left] >= size[right] ? [left, right] : [right, left];
        this.parents[smaller] = larger;
        size[larger] += size[smaller];
      }
      this.forCells(a, b, (cell) => { this.offsets[cell + 1]++; });
    });
    for (let index = 1; index <= cells; index++) this.offsets[index] += this.offsets[index - 1];
    this.starts = new Uint32Array(this.offsets[cells]);
    this.ends = new Uint32Array(this.offsets[cells]);
    const write = this.offsets.slice(0, cells);
    this.forSegments((a, b) => this.forCells(a, b, (cell) => {
      const index = write[cell]++;
      this.starts[index] = a;
      this.ends[index] = b;
    }));
  }

  component(node: number) {
    while (node !== this.parents[node]) {
      this.parents[node] = this.parents[this.parents[node]];
      node = this.parents[node];
    }
    return node;
  }

  private forSegments(visit: (a: number, b: number) => void) {
    const { offsets, targets } = this.graph;
    for (let a = 0; a + 1 < offsets.length; a++) {
      for (let edge = offsets[a]; edge < offsets[a + 1]; edge++) {
        const b = targets[edge];
        if (a < b) visit(a, b);
        else if (a !== b && !Number.isFinite(edgeCost(this.graph, b, a))) visit(b, a);
      }
    }
  }

  private forCells(a: number, b: number, visit: (cell: number) => void) {
    const { coordinates } = this.graph;
    const ax = Math.floor(coordinates[a * 2] / CELL) - this.x0;
    const bx = Math.floor(coordinates[b * 2] / CELL) - this.x0;
    const ay = Math.floor(coordinates[a * 2 + 1] / CELL) - this.y0;
    const by = Math.floor(coordinates[b * 2 + 1] / CELL) - this.y0;
    for (let y = Math.max(0, Math.min(ay, by)); y <= Math.min(this.height - 1, Math.max(ay, by)); y++) {
      for (let x = Math.max(0, Math.min(ax, bx)); x <= Math.min(this.width - 1, Math.max(ax, bx)); x++) {
        visit(y * this.width + x);
      }
    }
  }

  roads(bounds: Bounds): RoadResult {
    const west = Math.max(0, Math.floor(bounds.west * 1e6 / CELL) - this.x0);
    const east = Math.min(this.width - 1, Math.floor(bounds.east * 1e6 / CELL) - this.x0);
    const south = Math.max(0, Math.floor(bounds.south * 1e6 / CELL) - this.y0);
    const north = Math.min(this.height - 1, Math.floor(bounds.north * 1e6 / CELL) - this.y0);
    const visited = new Set<string>();
    const roads: Road[] = [];
    for (let y = south; y <= north; y++) {
      for (let x = west; x <= east; x++) {
        const cell = y * this.width + x;
        for (let index = this.offsets[cell]; index < this.offsets[cell + 1]; index++) {
          const a = this.starts[index];
          const b = this.ends[index];
          const id = `${a}:${b}`;
          if (visited.has(id)) continue;
          visited.add(id);
          const points = clipToBounds(location(this.graph, a), location(this.graph, b), bounds);
          if (!points || samePoint(...points)) continue;
          if (roads.length === MAX_VIEWPORT_EDGES) return { roads: [], limited: true };
          roads.push({ id, points });
        }
      }
    }
    return { roads };
  }

  nearest(point: Point, preferred?: string) {
    const [lon, lat] = point;
    const deltaY = REVIEW_METERS / 110_000;
    const deltaX = deltaY / Math.cos((Math.abs(lat) + deltaY) * Math.PI / 180);
    const floorX = (longitude: number) => Math.floor(longitude * 1e6 / CELL) - this.x0;
    const floorY = (latitude: number) => Math.floor(latitude * 1e6 / CELL) - this.y0;
    const visited = new Set<string>();
    const matches: Match[] = [];
    const startY = Math.max(0, floorY(lat - deltaY));
    const endY = Math.min(this.height - 1, floorY(lat + deltaY));
    const startX = Math.max(0, floorX(lon - deltaX));
    const endX = Math.min(this.width - 1, floorX(lon + deltaX));
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        const cell = y * this.width + x;
        for (let index = this.offsets[cell]; index < this.offsets[cell + 1]; index++) {
          const a = this.starts[index];
          const b = this.ends[index];
          const id = `${a}:${b}`;
          if (visited.has(id)) continue;
          visited.add(id);
          const { fraction, projected } = project(point, location(this.graph, a), location(this.graph, b));
          const meters = distance(point, projected);
          if (meters <= REVIEW_METERS) matches.push({
            id, a, b, fraction, point: projected, meters,
            forward: edgeCost(this.graph, a, b), backward: edgeCost(this.graph, b, a),
          });
        }
      }
    }
    matches.sort((a, b) => a.meters - b.meters || a.a - b.a || a.b - b.b);
    return {
      selected: preferred ? matches.find(({ id }) => id === preferred)
        : matches[0]?.meters <= AUTO_METERS ? matches[0] : undefined,
      matches,
    };
  }
}

type Item = { node: number; cost: number; priority: number };
class Heap {
  items: Item[] = [];
  push(item: Item) {
    const { items } = this;
    let index = items.length;
    items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].priority <= item.priority) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }
  pop() {
    const { items } = this;
    const first = items[0];
    const last = items.pop()!;
    if (!items.length) return first;
    let index = 0;
    while (index * 2 + 1 < items.length) {
      let child = index * 2 + 1;
      if (child + 1 < items.length && items[child + 1].priority < items[child].priority) child++;
      if (last.priority <= items[child].priority) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return first;
  }
}

function endpointCost(part: number, directedCost: number) {
  return part === 0 ? 0 : part * directedCost;
}

function publicCandidate({ id, point, meters }: Match): Candidate {
  return { id, point, meters };
}

function options(matches: Match[], selected?: Match, alternative?: Match) {
  const displayed: Match[] = selected ? [selected] : [];
  if (alternative && alternative.id !== selected?.id) displayed.push(alternative);
  for (const [min, max, limit] of [[0, 50, 5], [50, 85, 2], [85, 120, 2], [120, 151, 2]]) {
    let added = 0;
    for (const match of matches) {
      if (match.meters < min || match.meters >= max) continue;
      if (displayed.some((other) => other.id === match.id || (
        (other.a === match.a || other.a === match.b || other.b === match.a || other.b === match.b)
        && distance(other.point, match.point) < 14
      ))) continue;
      displayed.push(match);
      if (++added >= limit) break;
    }
  }
  return displayed.map((match) => ({ ...publicCandidate(match), shorterRoute: match.id === alternative?.id }));
}

export class Router {
  private graph: Graph;
  private coverage: Bounds;
  private index: SegmentIndex;
  private best: Float64Array;
  private previous: Int32Array;
  private seen: Uint32Array;
  private revision = 0;

  constructor(graph: Graph, coverage: Bounds, graphBounds: Bounds) {
    this.graph = graph;
    this.coverage = coverage;
    this.index = new SegmentIndex(graph, graphBounds);
    this.best = new Float64Array(graph.offsets.length - 1);
    this.previous = new Int32Array(this.best.length);
    this.seen = new Uint32Array(this.best.length);
  }

  roads(view: Bounds): RoadResult {
    const bounds = {
      west: Math.max(view.west, this.coverage.west), south: Math.max(view.south, this.coverage.south),
      east: Math.min(view.east, this.coverage.east), north: Math.min(view.north, this.coverage.north),
    };
    if (bounds.west >= bounds.east || bounds.south >= bounds.north) return { roads: [] };
    return this.index.roads(bounds);
  }

  run({ from, to, fromChoice, toChoice }: RouteInput): RouteResult {
    if (!contains(this.coverage, from) || !contains(this.coverage, to)) {
      return { error: 'outside', fromOptions: [], toOptions: [] };
    }
    const start = this.index.nearest(from, fromChoice);
    const final = this.index.nearest(to, toChoice);
    const a = start.selected;
    const b = final.selected;
    const disconnected = a && b && this.index.component(a.a) !== this.index.component(b.a);
    const initial = a && b && !disconnected ? this.search([a], b) : undefined;
    let alternative: Match | undefined;
    if (b && (!initial || lineLength(initial.points) > distance(a!.point, b.point) * 2.2 + 2500)) {
      const candidates = start.matches.filter((match) => this.index.component(match.a) === this.index.component(b.a));
      const found = this.search(candidates, b, true);
      if (found && found.start.id !== a?.id &&
        (!initial || lineLength(found.points) + 500 < lineLength(initial.points))) alternative = found.start;
    }
    const snaps = {
      fromOptions: options(start.matches, a, alternative),
      toOptions: options(final.matches, b),
      fromSnap: a && publicCandidate(a),
      toSnap: b && publicCandidate(b),
    };
    if (!a || !b) return { ...snaps, error: 'snap' };
    if (disconnected) return { ...snaps, error: 'disconnected' };
    return initial ? { ...snaps, points: initial.points } : { ...snaps, error: 'no-path' };
  }

  private search(starts: Match[], end: Match, preferClose = false) {
    if (!starts.length) return undefined;
    const { graph, best, previous, seen } = this;
    if (this.revision === 0xffffffff) {
      seen.fill(0);
      this.revision = 0;
    }
    const revision = ++this.revision;
    const frontier = new Heap();
    const insert = (node: number, cost: number, parent: number) => {
      if (!Number.isFinite(cost) || (seen[node] === revision && best[node] <= cost)) return false;
      seen[node] = revision;
      best[node] = cost;
      previous[node] = parent;
      frontier.push({ node, cost, priority: cost + distance(location(graph, node), end.point) });
      return true;
    };
    const arrivalAtA = endpointCost(end.fraction, end.forward);
    const arrivalAtB = endpointCost(1 - end.fraction, end.backward);
    const roots = new Map<number, Match>();
    let goalCost = Infinity;
    let last = -1;
    let direct: Match | undefined;
    for (const start of starts) {
      const penalty = preferClose ? start.meters * 3 : 0;
      if (insert(start.a, penalty + endpointCost(start.fraction, start.backward), -1)) roots.set(start.a, start);
      if (insert(start.b, penalty + endpointCost(1 - start.fraction, start.forward), -1)) roots.set(start.b, start);
      if (start.id !== end.id) continue;
      const delta = end.fraction - start.fraction;
      const cost = penalty + endpointCost(Math.abs(delta), delta >= 0 ? start.forward : start.backward);
      if (cost < goalCost) {
        goalCost = cost;
        direct = start;
      }
    }
    while (frontier.items.length) {
      const { node, cost, priority } = frontier.pop();
      if (cost !== best[node]) continue;
      if (priority >= goalCost) break;
      const arrival = node === end.a ? arrivalAtA : node === end.b ? arrivalAtB : Infinity;
      if (cost + arrival < goalCost) {
        last = node;
        goalCost = cost + arrival;
      }
      for (let edge = graph.offsets[node]; edge < graph.offsets[node + 1]; edge++) {
        insert(graph.targets[edge], cost + graph.costs[edge], node);
      }
    }
    if (!Number.isFinite(goalCost)) return undefined;
    const route = [end.point];
    let start = direct;
    for (let node = last; node !== -1; node = previous[node]) {
      route.push(location(graph, node));
      if (previous[node] === -1) start = roots.get(node);
    }
    if (!start) return undefined;
    route.push(start.point);
    route.reverse();
    const clean = route.filter((point, index) => !index || !samePoint(route[index - 1], point));
    return { points: clean.length === 1 ? [clean[0], clean[0]] : clean, start };
  }
}
