import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createNetwork, pack, weights } from './network.mjs';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(await readFile(new URL('data/source.json', root), 'utf8'));
const [filename] = process.argv.slice(2);
if (!filename) throw new Error('Usage: npm run graph -- path/to/region.json');
const input = JSON.parse(await readFile(filename, 'utf8'));
if (!Array.isArray(input.sources) || input.sources.length !== config.files.length
  || !config.files.every(({ sha256 }) => input.sources.some((source) =>
    source.sha256 === sha256 && source.replicationTimestamp === config.timestamp))) {
  throw new Error('Graph input does not match the pinned PBFs in data/source.json');
}
const graphBounds = input.graphBounds;
if (!graphBounds || graphBounds.west >= config.bounds.west || graphBounds.east <= config.bounds.east
  || graphBounds.south >= config.bounds.south || graphBounds.north <= config.bounds.north) {
  throw new Error('Graph bounds must include the configured boundary buffer');
}
const graph = createNetwork(input.elements, graphBounds);
if (!graph.edges) throw new Error('No routable segments in the extract');
const binary = pack(graph);
const checksum = createHash('sha256').update(binary).digest('hex');
const archive = gzipSync(binary, { level: 9 });
const archiveSha256 = createHash('sha256').update(archive).digest('hex');
const file = `network-${archiveSha256.slice(0, 16)}.bin.gz`;
const publicGraph = new URL('public/graph/', root);
await mkdir(publicGraph, { recursive: true });
await writeFile(new URL(file, publicGraph), archive);
const manifest = {
  format: 2, profile: 1, file, sha256: checksum, archiveSha256, bytes: archive.length, decodedBytes: binary.length,
  nodes: graph.positions.length, edges: graph.edges, ways: graph.ways,
  clippedSegments: graph.clippedSegments, blockedNodes: graph.blockedNodes,
  weights, coverage: config.bounds, graphBounds, bufferMeters: config.bufferMeters,
  timestamp: config.timestamp, sources: config.files, upstream: config.upstream,
  attribution: '© OpenStreetMap contributors',
  license: 'https://opendatacommons.org/licenses/odbl/1-0/',
};
const temporary = new URL('.manifest.tmp', publicGraph);
await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
await rename(temporary, new URL('manifest.json', publicGraph));
console.log(`${manifest.nodes} nodes, ${manifest.edges} edges, ${manifest.bytes} bytes gzip`);
console.log(checksum);
