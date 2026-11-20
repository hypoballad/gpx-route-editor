import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const templateUrl = new URL('./service-worker.js', import.meta.url);

export async function writeServiceWorker(directory) {
  const template = await readFile(templateUrl, 'utf8');
  const graph = JSON.parse(await readFile(join(directory, 'graph/manifest.json'), 'utf8'));
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll('\\', '/'))
    .filter((path) => path !== 'sw.js')
    .sort();
  const assets = [];
  for (const path of files) {
    const content = await readFile(join(directory, path));
    const hash = createHash('sha256').update(content).digest('base64');
    // Some hosts serve the graph with Content-Encoding: gzip, which changes the bytes Fetch exposes.
    const decoded = path === `graph/${graph.file}` ? ` sha256-${Buffer.from(graph.sha256, 'hex').toString('base64')}` : '';
    assets.push({ path, integrity: `sha256-${hash}${decoded}` });
  }
  const version = createHash('sha256').update(template).update(JSON.stringify(assets)).digest('hex').slice(0, 20);
  await writeFile(join(directory, 'sw.js'), `const version = ${JSON.stringify(version)};\nconst assets = ${JSON.stringify(assets)};\n\n${template}`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`PWA version ${await writeServiceWorker('dist')}`);
}
