import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bufferToArrayBuffer, makeNetwork } from './fixtures.ts';
import { decode, Router } from '../src/routing/network.ts';
import { createNetwork, wayPolicy, weights } from '../tools/osm/network.mjs';
import { edit, emptyProject, insertWaypoint, legInput, manualLine, moveWaypoint, redo, setWaypoints, undo, updateLeg } from '../src/editor/model.ts';
import { toGpx, trackSegments } from '../src/gpx/export.ts';
import type { Bounds, Point } from '../src/geo.ts';

const bounds: Bounds = { west: 138.97, east: 139.03, south: 35.77, north: 35.83 };
const along = (longitude: number): Point => [longitude, 35.8];

test('walk rules enforce access, separate sidewalks, directional tags and conditional closures', () => {
  assert.ok(wayPolicy({ highway: 'service', access: 'private', foot: 'yes' }));
  assert.equal(wayPolicy({ highway: 'path', foot: 'no' }), null);
  assert.equal(wayPolicy({ highway: 'path', 'foot:conditional': 'no @ (Nov-Apr)' }), null);
  assert.equal(wayPolicy({ highway: 'primary', sidewalk: 'separate' }), null);
  assert.deepEqual(wayPolicy({ highway: 'footway', 'oneway:foot': '-1' }),
    { weight: 0, forward: false, backward: true });
});

test('same-segment projection respects one-way travel and coverage', () => {
  const line = { ids: [1, 2], points: [along(139), along(139.01)], tags: { 'oneway:foot': 'yes' } };
  const packed = makeNetwork(bounds, [line]);
  const graph = decode(bufferToArrayBuffer(packed), weights);
  const router = new Router(graph, bounds, bounds);
  const start: Point = [139.002, 35.8001];
  const end: Point = [139.006, 35.8001];
  const forward = router.run({ from: start, to: end });
  assert.equal(forward.points?.length, 2);
  assert.ok(forward.points?.every((point) => point[1] === 35.8));
  assert.equal(router.run({ from: end, to: start }).error, 'no-path');
  assert.equal(router.run({ from: [140, 35.8], to: end }).error, 'outside');
  assert.equal(router.run({ from: [139.002, 35.805], to: end }).error, 'snap');
});

test('visible roads use the same selectable segment IDs as routing and stop at the coverage boundary', () => {
  const packed = makeNetwork(bounds, [
    { ids: [1, 2], points: [along(138.98), along(139.02)], tags: { 'oneway:foot': '-1' } },
    { ids: [3, 4], points: [[139, 35.812], [139.02, 35.812]], tags: { foot: 'no' } },
  ]);
  const coverage = { ...bounds, west: 139, east: 139.01 };
  const router = new Router(decode(bufferToArrayBuffer(packed), weights), coverage, bounds);
  const { roads } = router.roads(bounds);
  assert.deepEqual(roads, [{ id: '0:1', points: [along(139), along(139.01)] }]);
  const east = along(139.008);
  const west = along(139.002);
  const result = router.run({ from: east, to: west, fromChoice: roads[0].id, toChoice: roads[0].id });
  assert.equal(result.fromSnap?.id, roads[0].id);
  assert.equal(result.toSnap?.id, roads[0].id);
  assert.ok(result.points);
  assert.equal(router.run({ from: west, to: east, fromChoice: roads[0].id, toChoice: roads[0].id }).error, 'no-path');
  assert.deepEqual(router.roads({ ...bounds, east: 138.99 }).roads, []);
});

test('an anchored waypoint supplies the selected road to both neighboring legs', () => {
  const first = { id: 'a', point: along(139) };
  const middle = { id: 'b', point: along(139.002), roadId: '0:1' };
  const last = { id: 'c', point: along(139.004) };
  const project = setWaypoints(emptyProject, [first, middle, last]);
  assert.equal(legInput(project, 0).toChoice, '0:1');
  assert.equal(legInput(project, 1).fromChoice, '0:1');
  const alternate = updateLeg(project, project.legs[0].id, (leg) => ({ ...leg, toChoice: null }));
  assert.equal(legInput(alternate, 0).toChoice, undefined);
  assert.equal(legInput(alternate, 1).fromChoice, '0:1');
  assert.equal(legInput(moveWaypoint(project, 'b', along(139.003)), 0).toChoice, undefined);
});

test('geometrically crossing ways connect only through shared OSM nodes', () => {
  const west = along(138.99);
  const east = along(139.01);
  const south: Point = [139, 35.79];
  const north: Point = [139, 35.81];
  const crossing = along(139);
  const disconnected = makeNetwork(bounds, [
    { ids: [1, 2], points: [west, east] },
    { ids: [3, 4], points: [south, north] },
  ]);
  const router = new Router(decode(bufferToArrayBuffer(disconnected), weights), bounds, bounds);
  assert.equal(router.run({ from: west, to: north }).error, 'disconnected');
  const connected = makeNetwork(bounds, [
    { ids: [1, 5, 2], points: [west, crossing, east] },
    { ids: [3, 5, 4], points: [south, crossing, north] },
  ]);
  const shared = new Router(decode(bufferToArrayBuffer(connected), weights), bounds, bounds);
  assert.deepEqual(shared.run({ from: west, to: north }).points, [west, crossing, north]);
});

test('blocked barrier nodes and missing geometry cannot form a shortcut', () => {
  const points = [along(139), along(139.001), along(139.002)].map(([lon, lat]) => ({ lon, lat }));
  const way = { id: 1, type: 'way', tags: { highway: 'path' }, nodes: [1, 2, 3], geometry: points };
  const graph = createNetwork([way, { type: 'node', id: 2, tags: { barrier: 'gate', locked: 'yes' } }], bounds);
  assert.equal(graph.edges, 0);
  assert.throws(() => createNetwork([{ ...way, geometry: points.slice(1) }], bounds), /Invalid references/);
});

test('manual vertices survive waypoint moves, insertion and undo/redo', () => {
  const start = { id: 'a', point: along(139) };
  const end = { id: 'b', point: along(139.012) };
  const first = { id: 'x', point: along(139.004) };
  const second = { id: 'y', point: along(139.008) };
  const base = setWaypoints(emptyProject, [start, end]);
  const manual = updateLeg(base, base.legs[0].id, (leg) => ({ ...leg, mode: 'manual', vertices: [first, second] }));
  const moved = moveWaypoint(manual, end.id, along(139.015));
  assert.deepEqual(manualLine(moved, 0), [start.point, first.point, second.point, along(139.015)]);
  const split = insertWaypoint(moved, 1, { id: 'middle', point: along(139.006) }, 1);
  assert.deepEqual(split.legs.map((leg) => leg.vertices.map(({ id }) => id)), [['x'], ['y']]);
  const history = edit({ past: [], present: moved, future: [] }, split);
  assert.equal(undo(history).present, moved);
  assert.equal(redo(undo(history)).present, split);
});

test('GPX preserves disconnected segments and escapes editor names', () => {
  const lines = [[along(139), along(139.01)], [along(139.01), along(139.02)], [along(139.025), along(139.027)]];
  assert.deepEqual(trackSegments(lines).map((segment) => segment.length), [3, 2]);
  const exported = toGpx(lines, '峰 & 谷 <計画>', true);
  assert.match(exported, /峰 &amp; 谷 &lt;計画&gt;/);
  assert.match(exported, /openstreetmap\.org\/copyright/);
  assert.equal(exported.match(/<trkseg>/g)?.length, 2);
  assert.throws(() => toGpx([], 'empty', false));
});
