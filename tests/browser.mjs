import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const base = '/gpx-local-test/';
const server = await preview({ base, preview: { host: '127.0.0.1', port: 0 } });
const url = `http://127.0.0.1:${server.httpServer.address().port}${base}`;
let browser;

const okutama = { center: [139.014, 35.838], zoom: 12 };
const fuji = { center: [138.735, 35.370], zoom: 12.5 };
const mercatorY = (latitude) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
async function pixel(page, [lon, lat], view) {
  const box = await page.locator('.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('Map canvas is absent');
  const span = 512 * 2 ** view.zoom;
  const position = [
    box.x + box.width / 2 + (lon - view.center[0]) / 360 * span,
    box.y + box.height / 2 + (mercatorY(lat) - mercatorY(view.center[1])) * span,
  ];
  assert.ok(position[0] > box.x && position[0] < box.x + box.width
    && position[1] > box.y && position[1] < box.y + box.height, 'Test point must be visible');
  return position;
}

async function loaded(page, verifyGsi = false) {
  const messages = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') messages.push(message.text());
  });
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('requestfailed', (request) => messages.push(`${request.failure()?.errorText} ${request.url()}`));
  const firstTile = verifyGsi ? page.waitForResponse((response) =>
    /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/std\/.+\.png$/.test(response.url()) && response.ok(),
  { timeout: 22000 }).then(() => true, () => false) : undefined;
  try {
    const response = await page.goto(url);
    assert.ok(response?.ok(), `Page failed at ${url}: ${response?.status()}`);
    await page.locator('.map-canvas[data-status="ready"]').waitFor({ timeout: 25000 });
    if (firstTile) assert.ok(await firstTile, 'No successful GSI tile response');
  } catch (error) {
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/load-error.png' });
    const state = await page.locator('.map-canvas').getAttribute('data-status', { timeout: 1000 }).catch(() => 'missing');
    console.error(JSON.stringify({ url, state, messages: messages.slice(0, 12) }, null, 2));
    throw error;
  }
}

async function resolved(page, index) {
  await page.waitForFunction((index) => {
    const status = document.querySelector(`[data-testid="leg-status-${index}"]`)?.textContent;
    return status?.endsWith(' km') || status === '未解決';
  }, index);
  const status = await page.getByTestId(`leg-status-${index}`).textContent();
  assert.match(status, / km$/, `Leg ${index + 1}: ${JSON.stringify({
    status, waypoints: await page.locator('.waypoints small').allTextContents(),
    issues: await page.locator('.section-panel .error-text').allTextContents(),
  })}`);
}

async function drag(page, selector, to) {
  const marker = page.locator(selector);
  await marker.waitFor();
  const box = await marker.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 12 });
  await page.mouse.up();
}

async function verifyEdgeScroll(page) {
  await loaded(page);
  const map = page.locator('.map-canvas');
  const box = await map.boundingBox();
  const x = Math.floor(box.x + box.width - 48);
  const y = Math.floor(box.y + box.height - 80);
  await page.mouse.click(x, y);
  const pin = page.locator('.map-pin.waypoint');
  await pin.waitFor();
  const measure = () => map.evaluate((element) => {
    const viewport = document.documentElement;
    return {
      width: viewport.clientWidth, height: viewport.clientHeight,
      pageWidth: viewport.scrollWidth, pageHeight: viewport.scrollHeight,
      pageX: viewport.scrollLeft, pageY: viewport.scrollTop,
      mapX: element.scrollLeft, mapY: element.scrollTop,
    };
  });
  const before = await measure();
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await page.mouse.move(x - 170, y - 170);
  await page.mouse.down();
  await page.mouse.move(x - 55, y - 50, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const map = document.querySelector('.map-canvas').getBoundingClientRect();
    const pin = document.querySelector('.map-pin.waypoint').getBoundingClientRect();
    return pin.left > map.right && pin.top > map.bottom;
  });
  assert.deepEqual(await measure(), before, 'Panning an edge marker out of view must preserve the scroll area');
  await pin.evaluate((element) => element.focus());
  assert.deepEqual(await measure(), before, 'Focusing an off-map marker must preserve the scroll area');
  assert.match(await map.getAttribute('class'), /\bmaplibregl-map\b/);
}

try {
  browser = await chromium.launch({
    executablePath, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking'],
  });
  const desktop = await browser.newContext({ viewport: { width: 1500, height: 960 }, acceptDownloads: true, serviceWorkers: 'block' });
  const page = await desktop.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  await loaded(page, true);
  for (const point of [[139.0961, 35.8098], [139.007614, 35.82804], [138.9439, 35.8553]]) {
    await page.mouse.click(...await pixel(page, point, okutama));
  }
  assert.equal(await page.locator('.map-pin.waypoint').count(), 3);
  await resolved(page, 0);
  await resolved(page, 1);
  const before = await page.locator('.waypoints .point-row small').nth(1).textContent();
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await drag(page, '.map-pin[aria-label="経由地点 2"]', await pixel(page, [138.986553, 35.83029], okutama));
  await page.waitForFunction((previous) => document.querySelectorAll('.waypoints .point-row small')[1].textContent !== previous, before);
  await resolved(page, 0);
  await resolved(page, 1);
  assert.equal(await page.locator('.map-pin.waypoint').count(), 3);

  await page.getByRole('button', { name: '区間 1：自動探索', exact: true }).click();
  await page.getByRole('button', { name: '手描きに切り替え', exact: true }).click();
  const testedVertex = [139.055, 35.82];
  await page.mouse.click(...await pixel(page, [139.055, 35.816], okutama));
  await drag(page, '.map-pin[aria-label="手描き頂点 1"]', await pixel(page, testedVertex, okutama));
  await page.getByRole('button', { name: '頂点を削除', exact: true }).click();
  await page.locator('.map-pin.vertex').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await page.locator('.map-pin.vertex').waitFor();
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await page.locator('.map-pin.vertex').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await page.locator('.map-pin.vertex').waitFor();

  await page.getByLabel('ルート名').fill('奥多摩 & GPX');
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: /GPXを書き出す/ }).click(),
  ]);
  const text = await readFile(await download.path(), 'utf8');
  const gpx = await page.evaluate((text) => {
    const document = new DOMParser().parseFromString(text, 'application/xml');
    return {
      namespace: document.documentElement.namespaceURI,
      version: document.documentElement.getAttribute('version'),
      name: document.querySelector('trk > name')?.textContent,
      segments: document.querySelectorAll('trkseg').length,
      points: Array.from(document.querySelectorAll('trkpt'), (p) =>
        [Number(p.getAttribute('lon')), Number(p.getAttribute('lat'))]),
    };
  }, text);
  assert.equal(gpx.namespace, 'http://www.topografix.com/GPX/1/1');
  assert.equal(gpx.version, '1.1');
  assert.equal(gpx.name, '奥多摩 & GPX');
  assert.equal(gpx.segments, 2);
  assert.ok(gpx.points.length > 20);
  assert.ok(gpx.points.some(([lon, lat]) => Math.abs(lon - testedVertex[0]) < 0.0003
    && Math.abs(lat - testedVertex[1]) < 0.0003));
  assert.match(text, /© OpenStreetMap contributors/);

  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png' });
  assert.deepEqual(errors, []);
  console.log(`Chrome desktop: real GSI tiles, three waypoints, two recalculated legs, manual vertices, undo/redo, GPX (${gpx.points.length} points)`);

  const elevations = page.getByRole('region', { name: 'ルートの標高' });
  const profileToggle = elevations.getByRole('button', { name: /^標高プロフィール/ });
  const demResponses = [];
  page.on('response', (response) => {
    if (response.ok() && response.url().includes('/xyz/dem_png/14/')) demResponses.push(response.url());
  });
  await profileToggle.click();
  await elevations.locator('.elevation-area').first().waitFor({ timeout: 25000 });
  assert.ok(demResponses.length, 'Profile reads real GSI elevation tiles');
  assert.match(await profileToggle.innerText(), /累積上昇\s+[1-9][\d,]* m/);
  assert.match(await profileToggle.innerText(), /累積下降\s+[1-9][\d,]* m/);
  assert.match(await profileToggle.innerText(), new RegExp((await page.getByTestId('distance').textContent()).replace('.', '\\.')));
  const plot = elevations.locator('.elevation-plot');
  const plotBox = await plot.boundingBox();
  await plot.hover({ position: { x: plotBox.width / 2, y: plotBox.height / 2 } });
  const mapReading = page.locator('.elevation-map-point');
  await mapReading.waitFor();
  assert.match(await elevations.locator('.elevation-chart-heading').innerText(), /km · [\d,]+ m/);
  const profileSlider = elevations.getByRole('slider', { name: '標高グラフ上の位置' });
  const position = Number(await profileSlider.inputValue());
  await profileSlider.press('ArrowRight');
  assert.equal(Number(await profileSlider.inputValue()), position + 1);
  await page.screenshot({ path: 'test-results/elevation.png' });
  await profileToggle.click();
  await mapReading.waitFor({ state: 'detached' });
  assert.equal(await profileToggle.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []);
  console.log('Elevation: real GSI tiles, manual and automatic legs, map cursor, keyboard control and collapse');

  const roadsPage = await desktop.newPage();
  await loaded(roadsPage);
  const toggle = roadsPage.getByRole('button', { name: '探索できる道', exact: true });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  const [graphResponse] = await Promise.all([
    roadsPage.waitForResponse('**/graph/network-*.bin.gz'), toggle.click(),
  ]);
  assert.ok(graphResponse.ok());
  await roadsPage.waitForFunction(() => Number(document.querySelector('.map-canvas')?.dataset.roadCount) > 0);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await roadsPage.mouse.click(...await pixel(roadsPage, [139.095593, 35.810545], okutama));
  await roadsPage.locator('.map-pin.road-anchor').waitFor();
  await roadsPage.mouse.click(...await pixel(roadsPage, [138.986553, 35.83029], okutama));
  await roadsPage.waitForFunction(() => document.querySelectorAll('.map-pin.road-anchor').length === 2);
  await resolved(roadsPage, 0);
  await roadsPage.screenshot({ path: 'test-results/roads.png' });
  const oldRoadCount = await roadsPage.locator('.map-canvas').getAttribute('data-road-count');
  await roadsPage.evaluate(() => {
    const canvas = document.querySelector('.map-canvas');
    const observer = new MutationObserver((changes) => {
      if (canvas.dataset.roadCount === '0' || changes.some(({ oldValue }) => oldValue === '0')) {
        canvas.dataset.roadInterrupted = 'true';
      }
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-road-count'], attributeOldValue: true });
  });
  await roadsPage.mouse.move(950, 240);
  await roadsPage.mouse.down();
  await roadsPage.mouse.move(1010, 240, { steps: 8 });
  await roadsPage.mouse.up();
  await roadsPage.waitForFunction((previous) => {
    const count = document.querySelector('.map-canvas').dataset.roadCount;
    return Number(count) > 0 && count !== previous;
  }, oldRoadCount);
  assert.equal(await roadsPage.locator('.map-canvas').getAttribute('data-road-interrupted'), null);
  await roadsPage.getByRole('button', { name: '奥多摩', exact: true }).click();
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  await roadsPage.mouse.click(...await pixel(roadsPage, [138.9439, 35.8553], okutama));
  await resolved(roadsPage, 1);
  assert.equal(await roadsPage.locator('.map-pin.road-anchor').count(), 2);
  await toggle.click();
  await roadsPage.locator('button.maplibregl-ctrl-zoom-out').click();
  await roadsPage.getByText('拡大すると道を表示します').waitFor();
  console.log('Chrome Okutama: showed and hid graph roads, clicked two road-anchored waypoints and routed between them');

  const alt = await desktop.newPage();
  const manifest = JSON.parse(await readFile('public/graph/manifest.json', 'utf8'));
  const rawArchive = await readFile(`public/graph/${manifest.file}`);
  await alt.route('**/graph/network-*.bin.gz', (request) => request.fulfill({
    contentType: 'application/gzip', body: rawArchive,
  }));
  await loaded(alt);
  await alt.getByRole('button', { name: '富士山', exact: true }).click();
  for (const point of [[138.7327, 35.3943], [138.7274, 35.3606]]) {
    await alt.mouse.click(...await pixel(alt, point, fuji));
  }
  await resolved(alt, 0);
  const detour = parseFloat(await alt.getByTestId('distance').textContent());
  await alt.getByRole('button', { name: '始点の吸着候補', exact: true }).click();
  await alt.getByRole('button', { name: /別経路あり/ }).click();
  await resolved(alt, 0);
  const alternative = parseFloat(await alt.getByTestId('distance').textContent());
  assert.ok(detour > 20 && alternative < 10);
  await alt.screenshot({ path: 'test-results/fuji.png' });
  console.log(`Chrome Fuji: alternative snap reduced ${detour} km to ${alternative} km`);

  const delayed = await desktop.newPage();
  let release;
  const waitToServe = new Promise((resolve) => { release = resolve; });
  await delayed.route('**/graph/network-*.bin.gz', async (request) => {
    await waitToServe;
    await request.continue();
  });
  try {
    await loaded(delayed);
    const archiveRequested = delayed.waitForRequest('**/graph/network-*.bin.gz', { timeout: 10000 });
    for (const point of [[139.0961, 35.8098], [139.007614, 35.82804], [138.9439, 35.8553]]) {
      await delayed.mouse.click(...await pixel(delayed, point, okutama));
    }
    await archiveRequested;
    await delayed.getByRole('button', { name: '終了', exact: true }).click();
    await drag(delayed, '.map-pin[aria-label="経由地点 2"]', await pixel(delayed, [139.035, 35.851], okutama));
    const moved = await delayed.locator('.waypoints .point-row small').nth(1).textContent();
    assert.match(moved, /35\.85.*139\.03/);
    release();
    await delayed.waitForFunction(() =>
      [0, 1].every((index) => document.querySelector(`[data-testid="leg-status-${index}"]`)?.textContent === '未解決'));
    assert.equal(await delayed.locator('.waypoints .point-row small').nth(1).textContent(), moved);
    await delayed.getByRole('button', { name: '区間 2：自動探索', exact: true }).click();
    await delayed.getByRole('button', { name: '手描きに切り替え', exact: true }).click();
    await resolved(delayed, 1);
    assert.equal(await delayed.getByTestId('leg-status-0').textContent(), '未解決');
    assert.equal(await delayed.getByRole('button', { name: /GPXを書き出す/ }).isEnabled(), false);
    const review = delayed.getByRole('region', { name: 'GPXの書き出し状況' });
    await review.getByRole('button', { name: '区間 1（地点 1 → 2）' }).click();
    const legEditor = delayed.getByRole('region', { name: '選択した区間の編集' });
    await legEditor.getByText(/50 m以内に吸着先がありません/).waitFor();
    const [partial] = await Promise.all([
      delayed.waitForEvent('download'), review.getByRole('button', { name: '確定済みの区間だけ保存' }).click(),
    ]);
    assert.match(partial.suggestedFilename(), /確定済み区間のみ/);
    const text = await readFile(await partial.path(), 'utf8');
    assert.equal(text.match(/<trkseg>/g)?.length, 1);
    await delayed.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('Clipboard blocked')) },
    }));
    await review.getByRole('button', { name: 'GPXの内容をコピー' }).click();
    assert.equal(await review.getByLabel('GPXの内容をコピー用のテキスト').inputValue(), text);
    await delayed.getByText('診断モード', { exact: true }).click();
    const diagnostic = delayed.locator('.diagnostics');
    const copy = diagnostic.getByRole('button', { name: '診断情報をコピー' });
    const report = diagnostic.getByLabel('診断情報をコピー用のテキスト');
    await copy.click();
    const privateReport = JSON.parse(await report.inputValue());
    assert.equal(privateReport.legs[0].result, 'snap');
    assert.equal(privateReport.legs[1].result, 'resolved');
    assert.equal(privateReport.legs[0].coordinates, undefined);
    assert.equal(privateReport.export.lastAttempt.status, 'download-requested');
    await diagnostic.getByLabel('正確な座標を含める').check();
    await copy.click();
    assert.ok(JSON.parse(await report.inputValue()).legs[0].coordinates.from.length === 2);
    console.log('Chrome: unresolved section jump, partial GPX, clipboard fallback and coordinate opt-in');
  } finally {
    release();
  }

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const mobile = await touch.newPage();
  await loaded(mobile);
  await mobile.touchscreen.tap(...await pixel(mobile, [139.013, 35.837], okutama));
  await mobile.touchscreen.tap(...await pixel(mobile, [139.016, 35.835], okutama));
  assert.equal(await mobile.locator('.map-pin.waypoint').count(), 2);
  await mobile.getByRole('button', { name: /手描きに切り替え/ }).tap();
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.touchscreen.tap(...await pixel(mobile, [139.021, 35.841], okutama));
  await mobile.locator('.map-pin.vertex').waitFor();
  assert.ok(await mobile.getByRole('button', { name: /GPXを書き出す/ }).isEnabled());
  await mobile.screenshot({ path: 'test-results/touch.png' });
  await mobile.getByRole('button', { name: /^標高プロフィール/ }).tap();
  const mobilePlot = mobile.locator('.elevation-plot');
  await mobilePlot.tap({ timeout: 25000 });
  await mobile.locator('.elevation-map-point').waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390);
  await mobile.screenshot({ path: 'test-results/elevation-touch.png' });
  console.log('Chrome touch emulation: waypoint and manual vertex taps, GPX action enabled, elevation chart linked to map');

  for (const viewport of [{ width: 740, height: 530 }, { width: 420, height: 720 }]) {
    const edge = await browser.newPage({ viewport, serviceWorkers: 'block' });
    await verifyEdgeScroll(edge);
    await edge.close();
  }
  console.log('Map edge: panning and focusing an off-map waypoint preserved desktop and narrow-page scroll dimensions');

  const reference = await desktop.newPage();
  const referenceStyleErrors = [];
  reference.on('console', (message) => {
    if (message.type() === 'error' && /reference-(?:line|halo)-|line-dasharray/.test(message.text())) {
      referenceStyleErrors.push(message.text());
    }
  });
  await loaded(reference);
  await reference.getByRole('button', { name: '参考レイヤー', exact: true }).click();
  const input = reference.locator('input[type=file]');
  await input.setInputFiles([
    { name: '施設.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(`
      <kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Placemark><name>試験登山口</name><Point><coordinates>139.014,35.838</coordinates></Point></Placemark>
        <Placemark><name>試験トイレ</name><Point><coordinates>139.015,35.839</coordinates></Point></Placemark>
        <Placemark><LineString><coordinates>139.014,35.838 139.014,35.839</coordinates></LineString></Placemark>
        <Folder><name>track_points</name><Placemark><name>試験の軌跡点</name>
          <Point><coordinates>139.015,35.838</coordinates></Point>
        </Placemark></Folder>
      </Document></kml>`) },
    { name: '参考線.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(`
      <gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
        <trkpt lon="139.014" lat="35.839"/><trkpt lon="139.015" lat="35.838"/>
      </trkseg></trk></gpx>`) },
  ]);
  const imports = reference.locator('.reference-files');
  await imports.getByText('線 1 本 · 地点 0 件').waitFor();
  await imports.getByText('線 1 本 · 地点 3 件').waitFor();
  const kmlLayer = imports.locator('li').filter({ hasText: '施設.kml' });
  const gpxLayer = imports.locator('li').filter({ hasText: '参考線.gpx' });
  const settings = (layer) => layer.getByRole('button', { name: '線の設定', exact: true });
  const colorPicker = (layer) => layer.getByLabel('線の色', { exact: true });
  await settings(kmlLayer).click();
  const width = kmlLayer.getByRole('slider', { name: /太さ/ });
  const color = colorPicker(kmlLayer);
  await width.press('ArrowRight');
  await width.press('ArrowRight');
  assert.equal(await width.inputValue(), '6');
  const customColor = '#f8e129';
  await color.fill(customColor);
  await kmlLayer.getByText(customColor, { exact: true }).waitFor();
  await kmlLayer.getByLabel('線種').selectOption('solid');
  await kmlLayer.getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.equal(await width.inputValue(), '4');
  assert.equal(await kmlLayer.getByLabel('線種').inputValue(), 'long');
  assert.equal(await color.inputValue(), '#713ba4');
  await width.press('ArrowRight');
  await color.fill(customColor);
  await kmlLayer.getByLabel('線種').selectOption('short');
  await kmlLayer.getByRole('button', { name: '新規レイヤーの初期値にする', exact: true }).click();
  await reference.getByText('新規レイヤーの初期値として保存しました。').waitFor();
  await settings(gpxLayer).click();
  assert.equal(await gpxLayer.getByRole('slider', { name: /太さ/ }).inputValue(), '4');
  assert.equal(await colorPicker(gpxLayer).inputValue(), '#065e68');
  await settings(gpxLayer).click();
  assert.equal(await reference.getByRole('button', { name: /試験の軌跡点/ }).count(), 0);
  await reference.getByLabel('種類').selectOption('軌跡点');
  await reference.getByRole('button', { name: /試験の軌跡点/ }).waitFor();
  const selectedPin = reference.locator('.reference-selected-pin');
  const placeList = reference.locator('.reference-place-list').first();
  await reference.getByLabel('種類').selectOption('施設');
  await placeList.getByRole('button', { name: /試験登山口/ }).click();
  assert.match(await selectedPin.getAttribute('aria-label'), /試験登山口/);
  await reference.getByLabel('種類').selectOption('トイレ');
  await placeList.getByRole('button', { name: /試験トイレ/ }).click();
  assert.match(await selectedPin.getAttribute('aria-label'), /試験トイレ/);
  assert.equal(await selectedPin.count(), 1);
  await reference.getByRole('button', { name: 'マイ地点に保存', exact: true }).click();
  await reference.getByRole('button', { name: 'マイ地点から削除', exact: true }).waitFor();
  await reference.getByLabel('種類').selectOption('登山口');
  await reference.getByRole('button', { name: '絞り込んだ地点をまとめて保存', exact: true }).click();
  await reference.getByRole('button', { name: '1件を保存する', exact: true }).click();
  await reference.getByLabel('マイ地点を表示（2 件）').waitFor();
  await reference.getByLabel('種類').selectOption('トイレ');
  await reference.getByLabel('施設.kml').uncheck();
  await selectedPin.waitFor({ state: 'detached' });
  await placeList.getByRole('button', { name: /試験トイレ/ }).click();
  await reference.getByRole('button', { name: 'GPXにウェイポイントとして含める', exact: true }).click();
  const [pinDownload] = await Promise.all([
    reference.waitForEvent('download'), reference.getByRole('button', { name: /GPXを書き出す/ }).click(),
  ]);
  const pinGpx = await readFile(await pinDownload.path(), 'utf8');
  assert.match(pinGpx, /<wpt lat="35\.8390000" lon="139\.0150000">/);
  assert.match(pinGpx, /<name>試験トイレ<\/name>/);
  assert.doesNotMatch(pinGpx, /<trk>/);
  await reference.getByRole('button', { name: '経由地点に追加', exact: true }).click();
  await reference.locator('.map-pin.waypoint').waitFor();
  await reference.locator('.waypoints').getByText('試験トイレ', { exact: true }).waitFor();
  assert.equal(await selectedPin.evaluate((marker) => {
    const pin = marker.getBoundingClientRect();
    const waypoint = document.querySelector('.map-pin.waypoint').getBoundingClientRect();
    const x = pin.left + pin.width / 2;
    return Math.abs(x - (waypoint.left + waypoint.width / 2)) <= 1
      && Math.abs(pin.bottom - (waypoint.top + waypoint.height / 2)) <= 1
      && document.elementFromPoint(x, pin.bottom - 8)?.closest('.reference-selected-pin') === marker;
  }), true, 'Selected map pin is on top and its tip is at the waypoint coordinate');
  await reference.reload();
  await reference.getByRole('button', { name: '参考レイヤー', exact: true }).click();
  await reference.getByRole('button', { name: /試験トイレ/ }).waitFor();
  assert.equal(await reference.locator('.reference-files').count(), 0);
  await input.setInputFiles({ name: '再読み込み後.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(`
    <gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
      <trkpt lon="139.014" lat="35.839"/><trkpt lon="139.015" lat="35.838"/>
    </trkseg></trk></gpx>`) });
  await settings(imports.locator('li')).click();
  assert.equal(await imports.getByRole('slider', { name: /太さ/ }).inputValue(), '5');
  assert.equal(await imports.getByLabel('線種').inputValue(), 'short');
  assert.equal(await colorPicker(imports).inputValue(), customColor);
  assert.deepEqual(referenceStyleErrors, []);
  console.log('Reference layers: separate GPX/KML line styles, reset and defaults after reload, saved places and pin export');

  const waypointPage = await desktop.newPage();
  await loaded(waypointPage);
  await waypointPage.getByRole('button', { name: '＋ ウェイポイント追加', exact: true }).click();
  await waypointPage.mouse.click(...await pixel(waypointPage, [139.020, 35.832], okutama));
  const waypointForm = waypointPage.locator('.waypoint-form');
  await waypointForm.getByLabel('ウェイポイント名').fill('城山茶屋');
  await waypointForm.getByLabel('地点の種類').selectOption('茶屋・売店');
  await waypointForm.getByLabel('メモ').fill('営業日を確認');
  await waypointForm.getByRole('button', { name: 'GPXに追加', exact: true }).click();
  const waypointDetail = waypointPage.getByLabel('選択した地点');
  await waypointDetail.getByText('城山茶屋', { exact: true }).waitFor();
  const exportList = waypointPage.locator('.reference-place-list').filter({ has: waypointPage.getByRole('heading', { name: /GPXに含める地点/ }) });
  await exportList.getByRole('button', { name: '城山茶屋', exact: true }).waitFor();
  assert.equal(await waypointPage.locator('.map-pin.waypoint').count(), 0);
  await waypointDetail.getByRole('button', { name: 'ウェイポイントを編集', exact: true }).click();
  await waypointForm.getByLabel('ウェイポイント名').fill('城山茶屋・入口');
  await waypointForm.getByRole('button', { name: '地図で位置を変更', exact: true }).click();
  const moved = [139.023, 35.827];
  await waypointPage.mouse.click(...await pixel(waypointPage, moved, okutama));
  await waypointForm.getByRole('button', { name: '変更を保存', exact: true }).click();
  await waypointDetail.getByText('城山茶屋・入口', { exact: true }).waitFor();
  await waypointPage.screenshot({ path: 'test-results/manual-waypoint.png' });
  const [manualDownload] = await Promise.all([
    waypointPage.waitForEvent('download'), waypointPage.getByRole('button', { name: /GPXを書き出す/ }).click(),
  ]);
  const manualGpx = await readFile(await manualDownload.path(), 'utf8');
  const positionMatch = manualGpx.match(/<wpt lat="([^"]+)" lon="([^"]+)">/);
  assert.ok(positionMatch);
  assert.ok(Math.abs(Number(positionMatch[1]) - moved[1]) < 0.0002);
  assert.ok(Math.abs(Number(positionMatch[2]) - moved[0]) < 0.0002);
  assert.match(manualGpx, /<name>城山茶屋・入口<\/name>\s*<desc>営業日を確認<\/desc>/);
  assert.match(manualGpx, /<type>茶屋・売店<\/type>/);
  assert.doesNotMatch(manualGpx, /<trk>/);
  await waypointDetail.getByRole('button', { name: 'マイ地点に保存', exact: true }).click();
  await waypointDetail.getByRole('button', { name: 'マイ地点から削除', exact: true }).waitFor();
  await waypointDetail.getByRole('button', { name: 'ウェイポイントを削除', exact: true }).click();
  await exportList.waitFor({ state: 'detached' });
  assert.equal(await waypointPage.getByRole('button', { name: /GPXを書き出す/ }).isDisabled(), true);
  await waypointPage.reload();
  await waypointPage.getByRole('button', { name: '参考レイヤー', exact: true }).click();
  await waypointPage.getByRole('button', { name: /城山茶屋・入口/ }).waitFor();
  console.log('Manual waypoint: placed, edited, relocated, exported, saved and removed from current GPX');

  const course = await desktop.newPage();
  const courseErrors = [];
  course.on('console', (message) => { if (message.type() === 'error' && /route-auto|route-border/.test(message.text())) courseErrors.push(message.text()); });
  await loaded(course);
  await course.getByRole('button', { name: '参考レイヤー', exact: true }).click();
  await course.locator('input[type=file]').setInputFiles({
    name: '大会コース.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(`
      <gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
        <trkpt lon="138.993" lat="35.818"/><trkpt lon="139.000" lat="35.832"/>
        <trkpt lon="139.007614" lat="35.82804"/><trkpt lon="138.96" lat="35.78"/>
        <trkpt lon="138.993" lat="35.818"/>
      </trkseg></trk></gpx>`),
  });
  await course.getByRole('button', { name: '線の設定', exact: true }).click();
  await course.getByLabel('線の色', { exact: true }).fill('#174bd1');
  await course.getByText('#174bd1', { exact: true }).waitFor();
  await course.getByLabel('探索に使う').check();
  await course.getByRole('button', { name: 'ルート編集', exact: true }).click();
  await course.getByRole('button', { name: '奥多摩', exact: true }).click();
  const graphRequests = [];
  course.on('request', (request) => { if (request.url().includes('/graph/network-')) graphRequests.push(request.url()); });
  await course.mouse.click(...await pixel(course, [138.993, 35.818], okutama));
  await course.mouse.click(...await pixel(course, [139.007614, 35.82804], okutama));
  const courseLeg = course.getByRole('button', { name: '区間 1：参考GPX', exact: true });
  await courseLeg.waitFor();
  assert.notEqual(await courseLeg.locator('.line-key').evaluate((element) => getComputedStyle(element).borderTopColor), 'rgb(23, 75, 209)');
  assert.deepEqual(graphRequests, []);
  assert.equal(await course.locator('.map-pin.road-anchor').count(), 1);
  const [courseFile] = await Promise.all([
    course.waitForEvent('download'), course.getByRole('button', { name: /GPXを書き出す/ }).click(),
  ]);
  const courseGpx = await readFile(await courseFile.path(), 'utf8');
  assert.match(courseGpx, /<trkpt lat="35\.8320000" lon="139\.0000000"\/>/);
  assert.doesNotMatch(courseGpx, /openstreetmap\.org\/copyright/);
  await course.mouse.click(...await pixel(course, [139.0961, 35.8098], okutama));
  await course.getByText(/同じGPXの連続した線でつながりません/).waitFor();
  await course.locator('.waypoints .point-row').nth(1).click();
  await course.getByRole('button', { name: 'OSMとの接続点', exact: true }).click();
  await resolved(course, 1);
  assert.ok(graphRequests.length > 0);
  const [mixedFile] = await Promise.all([
    course.waitForEvent('download'), course.getByRole('button', { name: /GPXを書き出す/ }).click(),
  ]);
  const mixedGpx = await readFile(await mixedFile.path(), 'utf8');
  assert.match(mixedGpx, /openstreetmap\.org\/copyright/);
  assert.equal(mixedGpx.match(/<trkseg>/g)?.length, 1);
  assert.deepEqual(courseErrors, []);
  console.log('Reference routing: short path from shared start and finish, distinct route color, original GPX bend and explicit OSM connection');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
