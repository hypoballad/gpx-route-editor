import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const manifest = readFileSync(new URL('./public/graph/manifest.json', import.meta.url));
const revision = createHash('sha256').update(manifest).digest('hex').slice(0, 16);
const versionedManifest = `graph/manifest-${revision}.json`;

export default defineConfig(({ command }) => ({
  base: './',
  worker: { format: 'es' },
  define: { __GRAPH_MANIFEST_PATH__: JSON.stringify(command === 'build' ? versionedManifest : 'graph/manifest.json') },
  plugins: [{
    name: 'versioned-graph-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: versionedManifest, source: manifest });
    },
  }],
}));
