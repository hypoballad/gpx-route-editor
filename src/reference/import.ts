import type { Bounds, Point } from '../geo.ts';
import type { LineStyle } from './lineStyle.ts';

export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_COORDINATES = 200_000;
const GX = 'http://www.google.com/kml/ext/2.2';

export type Place = {
  key: string;
  name: string;
  category: string;
  point: Point;
  source: string;
  sourceUrl?: string;
  folder?: string;
  detail?: string;
};

export type ReferenceLayer = {
  id: string;
  name: string;
  format: 'gpx' | 'kml';
  lineStyle: LineStyle;
  routable?: boolean;
  visible: boolean;
  lines: Point[][];
  places: Place[];
  bounds?: Bounds;
  links: string[];
  unsupportedLinks: number;
};

const child = (element: Element, name: string) =>
  Array.from(element.children).find((item) => item.localName === name && item.namespaceURI === element.namespaceURI);
const descendants = (element: Element, name: string) =>
  Array.from(element.getElementsByTagNameNS(element.namespaceURI, name));
const text = (element: Element, name: string) => child(element, name)?.textContent?.trim() ?? '';

function location(lon: string | null, lat: string | null): Point | undefined {
  if (!lon?.trim() || !lat?.trim()) return;
  const x = Number(lon);
  const y = Number(lat);
  if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 85.05112878) return [x, y];
}

function coordinates(value: string, separator: RegExp): Point | undefined {
  const [lon, lat] = value.trim().split(separator);
  return location(lon, lat);
}

function folderName(element: Element) {
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (current.localName === 'Folder') return text(current, 'name');
  }
  return '';
}

function classify(name: string, folder: string, trackPoint: boolean, declared = '') {
  if (trackPoint || /^track[ _-]?points$/i.test(folder)) return '軌跡点';
  const value = [name, declared, folder].join(' ').normalize('NFKC');
  if (/トイレ|便所|お手洗い|\b(?:toilets?|restrooms?|wc)\b/i.test(value)) return 'トイレ';
  if (/登山口|入山口|trailhead/i.test(value)) return '登山口';
  if (/茶屋|売店|食堂|店舗|店$|自動販売機|vending|\bshops?\b/i.test(value)) return '茶屋・売店';
  if (/水場|給水|エイド|drinking.water|aid.station/i.test(value)) return '水場・エイド';
  if (/山小屋|避難小屋|hut|shelter/i.test(value)) return '山小屋';
  if (/駐車場|バス停|\bparking\b|bus.stop/i.test(value) || /駅$/.test(name.trim())) return '交通';
  return 'その他';
}

function myMapsLink(raw: string) {
  try {
    const url = new URL(raw);
    const mid = url.searchParams.get('mid');
    if (url.origin !== 'https://www.google.com' || url.pathname !== '/maps/d/kml'
      || url.username || url.password || !mid || !/^[\w-]{6,100}$/.test(mid)) return;
    const parameters = new URLSearchParams({ forcekml: '1', mid });
    return `https://www.google.com/maps/d/kml?${parameters}`;
  } catch {
    return undefined;
  }
}

export function readReference(markup: string, name: string, lineStyle: LineStyle): ReferenceLayer {
  if (/<!DOCTYPE/i.test(markup)) throw new Error('DTDを含むファイルには対応していません。');
  const document = new DOMParser().parseFromString(markup, 'application/xml');
  const root = document.documentElement;
  if (root.localName === 'parsererror'
    || document.getElementsByTagNameNS('http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror').length) {
    throw new Error('XMLを読み取れませんでした。');
  }
  const namespace = root.namespaceURI;
  const gpx = root.localName === 'gpx' && (!namespace || /^http:\/\/www\.topografix\.com\/GPX\/1\/[01]$/.test(namespace));
  const kml = root.localName === 'kml' && (!namespace || namespace === 'http://www.opengis.net/kml/2.2'
    || /^http:\/\/earth\.google\.com\/kml\/2\.[012]$/.test(namespace));
  if (!gpx && !kml) throw new Error('GPXまたはKML形式のファイルを選んでください。');
  const lines: Point[][] = [];
  const places: Place[] = [];
  const links = new Set<string>();
  let unsupportedLinks = 0;
  let visited = 0;
  let bounds: Bounds | undefined;
  function check(point: Point | undefined) {
    if (++visited > MAX_COORDINATES) throw new Error('1ファイルにつき座標20万件まで読み込めます。');
    if (!point) return;
    const [lon, lat] = point;
    bounds = bounds ? {
      west: Math.min(bounds.west, lon), south: Math.min(bounds.south, lat),
      east: Math.max(bounds.east, lon), north: Math.max(bounds.north, lat),
    } : { west: lon, south: lat, east: lon, north: lat };
  }
  function addLine(points: Iterable<Point | undefined>) {
    let run: Point[] = [];
    for (const point of points) {
      check(point);
      if (point) run.push(point);
      else {
        if (run.length >= 2) lines.push(run);
        run = [];
      }
    }
    if (run.length >= 2) lines.push(run);
  }
  function addPlace(point: Point | undefined, rawName: string, category: string, folder: string, description: string) {
    check(point);
    if (!point) return;
    const title = (rawName || '名称なし').slice(0, 160);
    const detail = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    const key = JSON.stringify([title.normalize('NFKC').trim(), ...point.map((number) => Number(number.toFixed(5)))]);
    places.push({ key, name: title, point, category, source: name, folder: folder.slice(0, 160) || undefined, detail: detail || undefined });
  }
  if (gpx) {
    const gpxPoint = (node: Element) => location(node.getAttribute('lon'), node.getAttribute('lat'));
    for (const segment of descendants(root, 'trkseg')) {
      addLine(descendants(segment, 'trkpt').map(gpxPoint));
    }
    for (const route of descendants(root, 'rte')) addLine(descendants(route, 'rtept').map(gpxPoint));
    for (const waypoint of descendants(root, 'wpt')) {
      const title = text(waypoint, 'name');
      addPlace(gpxPoint(waypoint), title, classify(title, '', false, text(waypoint, 'type')), '', text(waypoint, 'desc'));
    }
  } else {
    for (const placemark of descendants(root, 'Placemark')) {
      const title = text(placemark, 'name');
      const folder = folderName(placemark);
      const trackPoint = /^track[ _-]?points$/i.test(folder)
        || descendants(placemark, 'Data').some((field) => field.getAttribute('name') === 'track_seg_point_id');
      for (const point of descendants(placemark, 'Point')) {
        addPlace(coordinates(text(point, 'coordinates'), /\s*,\s*/), title, classify(title, folder, trackPoint),
          folder, text(placemark, 'description'));
      }
      for (const line of descendants(placemark, 'LineString')) {
        addLine(text(line, 'coordinates').split(/\s+/).map((tuple) => coordinates(tuple, /,/)));
      }
      for (const track of Array.from(placemark.getElementsByTagNameNS(GX, 'Track'))) {
        addLine(Array.from(track.getElementsByTagNameNS(GX, 'coord'),
          (node) => coordinates(node.textContent ?? '', /\s+/)));
      }
    }
    for (const link of descendants(root, 'NetworkLink')) {
      const reference = child(link, 'Link') ?? child(link, 'Url');
      const url = reference && myMapsLink(text(reference, 'href'));
      if (url) links.add(url);
      else unsupportedLinks++;
    }
  }
  if (!lines.length && !places.length && !links.size && !unsupportedLinks) {
    throw new Error('表示できる線や地点が見つかりませんでした。');
  }
  return {
    id: crypto.randomUUID(), name, format: gpx ? 'gpx' : 'kml', lineStyle, visible: true,
    lines, places, bounds, links: [...links], unsupportedLinks,
  };
}

export async function readLinkedKml(url: string) {
  if (myMapsLink(url) !== url) throw new Error('このリンクには対応していません。');
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error('リンク先のKMLを取得できませんでした。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_REFERENCE_BYTES) {
      await reader.cancel();
      throw new Error('リンク先のKMLが20 MBを超えています。');
    }
    text += decoder.decode(value, { stream: true });
  }
}
