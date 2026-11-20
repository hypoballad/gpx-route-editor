export const referencePalette = [
  { name: '濃い紫', color: '#713ba4' },
  { name: '濃い青緑', color: '#065e68' },
  { name: '濃紺', color: '#263e72' },
  { name: 'こげ茶', color: '#78441c' },
  { name: 'えんじ', color: '#843256' },
  { name: '墨色', color: '#373c46' },
] as const;

export const referencePatterns = {
  solid: { name: '実線', pixels: undefined },
  long: { name: '長い破線', pixels: [15, 6] },
  short: { name: '短い破線', pixels: [7, 5] },
  dot: { name: '点線', pixels: [2.5, 5] },
} as const;

export type LinePattern = keyof typeof referencePatterns;
export type LineStyle = { width: number; color: string; pattern: LinePattern };
export const referenceOutline = 3;
const defaultLine: LineStyle = { width: 4, color: referencePalette[0].color, pattern: 'long' };
const storageKey = 'gpx-route-editor-reference-line-v1';

export function loadLineDefault(): LineStyle {
  try {
    const saved: Partial<LineStyle> | null = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved && typeof saved.width === 'number' && Number.isInteger(saved.width) && saved.width >= 2 && saved.width <= 8
      && typeof saved.color === 'string' && /^#[0-9a-f]{6}$/.test(saved.color)
      && typeof saved.pattern === 'string' && Object.hasOwn(referencePatterns, saved.pattern)) {
      return saved as LineStyle;
    }
  } catch {
    // A storage failure or older value falls back to the built-in style.
  }
  return defaultLine;
}

export function saveLineDefault(style: LineStyle) {
  localStorage.setItem(storageKey, JSON.stringify(style));
}

export function layerLineStyle(defaults: LineStyle, index: number): LineStyle {
  const start = referencePalette.findIndex(({ color }) => color === defaults.color);
  const colors = referencePalette.map(({ color }) => color);
  const rotation = start < 0 ? [defaults.color, ...colors] : [...colors.slice(start), ...colors.slice(0, start)];
  return { ...defaults, color: rotation[index % rotation.length] };
}

export function mapDashArray(pattern: LinePattern, width: number) {
  // MapLibre scales each dash by the width of its layer. Preserve matching gaps in the casing.
  return referencePatterns[pattern].pixels?.map((part) => part / width);
}
