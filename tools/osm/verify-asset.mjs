import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const directory = new URL('../../public/graph/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
const archive = await readFile(new URL(manifest.file, directory));
const binary = gunzipSync(archive);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (archive.length !== manifest.bytes || binary.length !== manifest.decodedBytes
  || hash(archive) !== manifest.archiveSha256 || hash(binary) !== manifest.sha256
  || binary.readUInt32LE(0) !== manifest.format || binary.readUInt32LE(4) !== manifest.nodes
  || binary.readUInt32LE(8) !== manifest.edges) {
  throw new Error('Published graph differs from its manifest');
}
console.log(`Verified ${manifest.file}`);
