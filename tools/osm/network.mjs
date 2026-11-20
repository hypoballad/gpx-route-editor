export const weights = [1, 1.45, 2, 3, 4];
const trails = new Set(['path', 'footway', 'steps', 'track', 'pedestrian', 'bridleway']);
const roadWeights = new Map([
  ['service', 1], ['residential', 1], ['living_street', 1], ['unclassified', 1],
  ['tertiary', 2], ['secondary', 3], ['primary', 4],
]);
const allowed = new Set(['yes', 'designated', 'permissive', 'official']);
const blocked = new Set(['no', 'private', 'customers', 'permit', 'destination', 'delivery', 'agricultural', 'forestry', 'use_sidepath']);
const walkableBarriers = new Set(['bollard', 'cycle_barrier', 'stile', 'kissing_gate']);

export function restricted(tags) {
  if (tags['foot:conditional'] || tags['access:conditional']) return true;
  if (allowed.has(tags.foot)) return false;
  return blocked.has(tags.foot) || blocked.has(tags.access);
}

export function wayPolicy(tags) {
  const weight = trails.has(tags.highway) ? 0 : roadWeights.get(tags.highway);
  if (weight === undefined || restricted(tags) || tags.area === 'yes'
    || (tags.motorroad === 'yes' && !allowed.has(tags.foot))
    || (tags.sidewalk === 'separate' && !allowed.has(tags.foot))
    || ['emergency_access', 'drive-through'].includes(tags.service)) return null;
  const oneWay = tags['oneway:foot'];
  const forward = oneWay !== '-1' && !blocked.has(tags['foot:forward']) && !tags['foot:forward:conditional'];
  const backward = !['yes', '1', 'true'].includes(oneWay)
    && !blocked.has(tags['foot:backward']) && !tags['foot:backward:conditional'];
  return forward || backward ? { weight, forward, backward } : null;
}

function blockedNode(tags) {
  return restricted(tags) || tags.locked === 'yes'
    || (tags.barrier && !walkableBarriers.has(tags.barrier) && !allowed.has(tags.foot));
}

export function createNetwork(elements, bounds) {
  const decisions = new Map();
  const deniedNodes = new Set();
  for (const entry of elements) {
    if (entry.type === 'node' && blockedNode(entry.tags ?? {})) deniedNodes.add(entry.id);
  }
  const nodeIds = new Map();
  const positions = [];
  const adjacency = [];
  const inside = ({ lon, lat }) => lon >= bounds.west && lon <= bounds.east
    && lat >= bounds.south && lat <= bounds.north;
  function getNode(id, point) {
    const location = [Math.round(point.lon * 1e6), Math.round(point.lat * 1e6)];
    const existing = nodeIds.get(id);
    if (existing !== undefined) {
      if (positions[existing][0] !== location[0] || positions[existing][1] !== location[1]) {
        throw new Error(`Conflicting locations for OSM node ${id}`);
      }
      return existing;
    }
    const index = positions.length;
    nodeIds.set(id, index);
    positions.push(location);
    adjacency.push([]);
    return index;
  }
  let ways = 0;
  let clippedSegments = 0;
  for (const entry of elements) {
    if (entry.type !== 'way') continue;
    const { id, nodes, geometry, tags = {} } = entry;
    if (decisions.has(id)) throw new Error(`Duplicate OSM way ${id}`);
    const policy = wayPolicy(tags);
    decisions.set(id, policy);
    if (!policy) continue;
    if (!Array.isArray(nodes) || geometry?.length !== nodes.length) {
      throw new Error(`Invalid references for OSM way ${id}`);
    }
    let added = false;
    for (let i = 1; i < nodes.length; i++) {
      const first = geometry[i - 1];
      const second = geometry[i];
      if (!first || !second || !inside(first) || !inside(second)) {
        clippedSegments++;
        continue;
      }
      const from = nodes[i - 1];
      const to = nodes[i];
      if (from === to || deniedNodes.has(from) || deniedNodes.has(to)) continue;
      const a = getNode(from, first);
      const b = getNode(to, second);
      if (policy.forward) adjacency[a].push([b, policy.weight]);
      if (policy.backward) adjacency[b].push([a, policy.weight]);
      added = true;
    }
    if (added) ways++;
  }
  let edges = 0;
  for (let node = 0; node < adjacency.length; node++) {
    const neighbors = adjacency[node];
    if (neighbors.length > 1) {
      neighbors.sort(([a, wa], [b, wb]) => a - b || wa - wb);
      let write = 1;
      for (let read = 1; read < neighbors.length; read++) {
        if (neighbors[read][0] !== neighbors[write - 1][0]) neighbors[write++] = neighbors[read];
      }
      neighbors.length = write;
    }
    edges += neighbors.length;
  }
  return { positions, adjacency, edges, ways, clippedSegments, blockedNodes: deniedNodes.size };
}

export function pack({ positions, adjacency, edges }) {
  const output = Buffer.allocUnsafe(12 + positions.length * 15 + edges * 5);
  output.writeUInt32LE(2, 0);
  output.writeUInt32LE(positions.length, 4);
  output.writeUInt32LE(edges, 8);
  let cursor = 12;
  const signed = (value) => value < 0 ? -2 * value - 1 : 2 * value;
  function write(value) {
    while (value >= 128) {
      output[cursor++] = 128 + value % 128;
      value = Math.floor(value / 128);
    }
    output[cursor++] = value;
  }
  let lastLon = 0;
  let lastLat = 0;
  for (const [lon, lat] of positions) {
    write(signed(lon - lastLon));
    write(signed(lat - lastLat));
    lastLon = lon;
    lastLat = lat;
  }
  for (const [node, neighbors] of adjacency.entries()) {
    write(neighbors.length);
    for (const [target, weight] of neighbors) write(signed(target - node) * weights.length + weight);
  }
  return output.subarray(0, cursor);
}
