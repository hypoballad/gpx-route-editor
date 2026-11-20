import { samePoint } from '../geo.ts';
import type { Point } from '../geo.ts';
import type { Place } from '../reference/import.ts';

function xml(value: string) {
  return value.replace(/[&<>"']/g, (match) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[match]!);
}

export function trackSegments(lines: readonly (Point[] | undefined)[]) {
  const segments: Point[][] = [];
  let previous: Point[] | undefined;
  for (const line of lines) {
    if (!line || line.length < 2) {
      previous = undefined;
      continue;
    }
    if (previous && samePoint(previous.at(-1)!, line[0])) {
      for (let index = 1; index < line.length; index++) previous.push(line[index]);
    } else {
      previous = [...line];
      segments.push(previous);
    }
  }
  return segments;
}

export function toGpx(lines: readonly (Point[] | undefined)[], name: string, usesOsm: boolean, waypoints: Place[] = []) {
  const segments = trackSegments(lines);
  if (!segments.length && !waypoints.length) throw new Error('GPX needs at least one resolved segment or waypoint');
  const sources = usesOsm
    ? '  <metadata><link href="https://www.openstreetmap.org/copyright"><text>© OpenStreetMap contributors</text></link></metadata>\n'
    : '';
  const track = segments.map((segment) => {
    const points = segment.map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`).join('\n');
    return `    <trkseg>\n${points}\n    </trkseg>`;
  }).join('\n');
  const pins = waypoints.map(({ point: [lon, lat], name, source, sourceUrl, category, detail }) => {
    const description = detail ? `    <desc>${xml(detail)}</desc>\n` : '';
    const link = sourceUrl ? `    <link href="${xml(sourceUrl)}"/>\n` : '';
    return `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">\n    <name>${xml(name)}</name>\n${description}    <src>${xml(source)}</src>\n${link}    <type>${xml(category)}</type>\n  </wpt>\n`;
  }).join('');
  const route = segments.length ? `  <trk>\n    <name>${xml(name)}</name>\n${track}\n  </trk>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="登山ルートエディタ">\n${sources}${pins}${route}</gpx>\n`;
}

export function downloadGpx(contents: string, name: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/gpx+xml' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100)}.gpx`;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
