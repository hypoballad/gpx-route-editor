import { decode, Router } from './network.ts';
import type { Manifest, RoutingRequest, RoutingResponse } from './protocol.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ready: Promise<{ router: Router; version: string }> | undefined;

async function load(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Graph manifest request failed');
  const manifest: Manifest = await response.json();
  if (manifest.format !== 2 || !/^network-[a-f0-9]{16}\.bin\.gz$/.test(manifest.file)) {
    throw new Error('Unsupported graph manifest');
  }
  const archive = await fetch(new URL(manifest.file, url));
  if (!archive.ok) throw new Error('Graph request failed');
  const payload = await archive.arrayBuffer();
  const prefix = new Uint8Array(payload, 0, Math.min(payload.byteLength, 2));
  // Static servers can send a .gz payload either as a file or as HTTP content encoding.
  const buffer = prefix[0] === 0x1f && prefix[1] === 0x8b
    ? await new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    : payload;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== manifest.sha256) throw new Error('Graph checksum mismatch');
  const graph = decode(buffer, manifest.weights);
  if (graph.offsets.length !== manifest.nodes + 1 || graph.targets.length !== manifest.edges) {
    throw new Error('Graph dimensions do not match the manifest');
  }
  return { router: new Router(graph, manifest.coverage, manifest.graphBounds), version: sha256 };
}

scope.addEventListener('message', async ({ data }: MessageEvent<RoutingRequest>) => {
  const pending = ready ??= load(data.manifestUrl);
  let response: RoutingResponse;
  try {
    const { router, version } = await pending;
    response = data.type === 'route'
      ? { id: data.id, type: 'route', result: { ...router.run(data.input), graphVersion: version } }
      : { id: data.id, type: 'roads', result: router.roads(data.bounds) };
  } catch (error) {
    if (ready === pending) ready = undefined;
    console.error(error);
    response = data.type === 'route'
      ? { id: data.id, type: 'route', result: { error: 'load', fromOptions: [], toOptions: [] } }
      : { id: data.id, type: 'roads', result: { error: 'load', roads: [] } };
  }
  scope.postMessage(response);
});
