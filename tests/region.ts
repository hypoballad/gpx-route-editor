import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { lineLength } from '../src/geo.ts';
import type { Point } from '../src/geo.ts';
import { decode, Router } from '../src/routing/network.ts';
import type { Manifest } from '../src/routing/protocol.ts';
import { bufferToArrayBuffer } from './fixtures.ts';

const directory = new URL('../public/graph/', import.meta.url);
const manifest: Manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
const archive = readFileSync(new URL(manifest.file, directory));
const init = performance.now();
const router = new Router(decode(bufferToArrayBuffer(gunzipSync(archive)), manifest.weights),
  manifest.coverage, manifest.graphBounds);
console.log(`Graph and line index ready in ${(performance.now() - init).toFixed(0)} ms`);

const cases: [string, Point, Point][] = [
  ['奥多摩駅 → 雲取山', [139.0961, 35.8098], [138.9439, 35.8553]],
  ['三峯神社付近 → 雲取山', [138.9305, 35.9257], [138.9439, 35.8553]],
  ['瑞牆山荘付近 → 金峰山', [138.5917, 35.8933], [138.6253, 35.8715]],
  ['金峰山 → 甲武信ヶ岳', [138.6253, 35.8715], [138.7288, 35.9091]],
  ['スバルライン五合目付近 → 富士山頂', [138.7327, 35.3943], [138.7274, 35.3606]],
  ['富士宮口五合目付近 → 富士山頂', [138.7342, 35.3365], [138.7274, 35.3606]],
];
for (const [index, [name, from, to]] of cases.entries()) {
  const start = performance.now();
  const result = router.run({ from, to });
  const time = (performance.now() - start).toFixed(1);
  let lengths: string;
  if (result.points) {
    lengths = (lineLength(result.points) / 1000).toFixed(2) + ' km';
  } else {
    lengths = result.error ?? 'unknown';
    assert.ok(result.error);
  }
  if ([0, 2, 5].includes(index)) assert.ok(result.points, name);
  if (name.startsWith('スバル')) {
    const options = result.fromOptions.map(({ id, meters }) => {
      const option = router.run({ from, to, fromChoice: id });
      return [Math.round(meters), option.points ? (lineLength(option.points) / 1000).toFixed(2) : option.error];
    });
    assert.ok(result.fromOptions.some(({ shorterRoute }) => shorterRoute), name);
    assert.ok(options.some(([, length]) => Number(length) < 10), name);
    console.log('スバルライン五合目の候補 [吸着m, km またはエラー]', options);
  }
  if (name.startsWith('奥多摩駅') && result.points) {
    console.log('奥多摩のルート上のサンプル', result.points[Math.floor(result.points.length * 0.36)],
      result.points[Math.floor(result.points.length * 0.41)]);
  }
  console.log(name, lengths, `${time} ms`);
}
