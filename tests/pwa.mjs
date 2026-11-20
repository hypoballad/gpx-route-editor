import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { writeServiceWorker } from '../tools/pwa/build.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const base = '/editor-preview/';
const staging = await mkdtemp(join(tmpdir(), 'gpx-pwa-'));
const first = join(staging, 'first');
const second = join(staging, 'second');
let release = first;
let staleHtml = false;
let browser;
let server;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

async function stageVersion(directory, name) {
  await cp('dist', directory, { recursive: true });
  const index = join(directory, 'index.html');
  await writeFile(index, (await readFile(index, 'utf8')).replace('<html lang="ja">', `<html lang="ja" data-release="${name}">`));
  return writeServiceWorker(directory);
}

try {
  const [a, b] = await Promise.all([stageVersion(first, 'first'), stageVersion(second, 'second')]);
  assert.notEqual(a, b, 'Even an HTML-only change must produce a new service worker');
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!path.startsWith(base)) {
      response.writeHead(404).end();
      return;
    }
    const file = path.slice(base.length) || 'index.html';
    try {
      const bytes = await readFile(join(file === 'index.html' && staleHtml ? first : release, file));
      const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=600' };
      if (release === second && extname(file) === '.gz') headers['Content-Encoding'] = 'gzip';
      response.writeHead(200, headers).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${base}`;
  browser = await chromium.launch({
    executablePath, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'],
  });
  const context = await browser.newContext();
  await context.route('https://cyberjapandata.gsi.go.jp/**', (route) => route.abort());
  const page = await context.newPage();
  const other = await context.newPage();
  const installed = (tab) => tab.waitForFunction(() => !!navigator.serviceWorker.controller);
  const updateButton = (tab) => tab.getByRole('button', { name: '更新する', exact: true });
  const check = (tab) => tab.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  const releaseName = (tab) => tab.locator('html').getAttribute('data-release');
  const routeName = (tab) => tab.getByLabel('ルート名');

  await page.goto(url);
  await installed(page);
  await other.goto(url);
  await installed(other);
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope), url);
  assert.equal(await updateButton(page).count(), 0);
  assert.equal(await releaseName(page), 'first');
  const manifest = await page.evaluate(async () => {
    const { href } = document.querySelector('link[rel="manifest"]');
    return { href, content: await (await fetch(href)).json() };
  });
  assert.equal(new URL(manifest.content.start_url, manifest.href).href, url);
  assert.equal(manifest.content.display, 'standalone');
  assert.ok(manifest.content.icons.some(({ sizes }) => sizes === '512x512'));
  const graph = JSON.parse(await readFile('dist/graph/manifest.json', 'utf8'));
  const versioned = (await readdir('dist/graph')).find((name) => /^manifest-[0-9a-f]{16}\.json$/.test(name));
  assert.ok(versioned);
  await context.setOffline(true);
  await page.reload();
  await routeName(page).fill('編集中のルート');
  assert.equal(await releaseName(page), 'first');
  assert.ok(await page.evaluate(async ([manifest, asset]) => {
    const responses = await Promise.all([fetch('graph/' + manifest), fetch('graph/' + asset)]);
    return responses.every((response) => response.ok) && (await responses[1].arrayBuffer()).byteLength > 1_000_000;
  }, [versioned, graph.file]));
  await context.setOffline(false);
  await routeName(other).fill('別タブの編集中ルート');

  // A CDN may still serve old HTML when a new service-worker script first becomes visible.
  release = second;
  staleHtml = true;
  const rejected = page.evaluate(() => new Promise((resolve) => {
    navigator.serviceWorker.getRegistration().then((registration) => {
      const watch = () => registration.installing?.addEventListener('statechange', (event) => {
        if (event.target.state === 'redundant') resolve(true);
      });
      registration.addEventListener('updatefound', watch);
      watch();
      registration.update().catch(() => {});
    });
  }));
  assert.ok(await Promise.race([rejected, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('The mixed deployment was not rejected')), 15000);
    timer.unref();
  })]));
  assert.equal(await updateButton(page).count(), 0);
  assert.equal(await releaseName(page), 'first');
  assert.equal(await routeName(page).inputValue(), '編集中のルート');

  staleHtml = false;
  await check(page);
  await updateButton(page).waitFor({ timeout: 20000 });
  await page.getByText(/再読み込みで編集中の内容が消えます/).waitFor();
  assert.equal(await routeName(page).inputValue(), '編集中のルート');
  await updateButton(page).click();
  await page.locator('html[data-release="second"]').waitFor();
  assert.equal(await updateButton(page).count(), 0);
  await updateButton(other).waitFor();
  assert.equal(await releaseName(other), 'first');
  assert.equal(await routeName(other).inputValue(), '別タブの編集中ルート');
  await updateButton(other).click();
  await other.locator('html[data-release="second"]').waitFor();
  await context.setOffline(true);
  await page.reload();
  assert.equal(await releaseName(page), 'second');
  console.log('PWA: scoped manifest, offline shell and graph, mixed-deployment protection, consent-based update and independent tabs');
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(staging, { recursive: true, force: true });
}
