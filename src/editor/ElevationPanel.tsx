import { useEffect, useMemo, useState } from 'react';
import type { Point } from '../geo.ts';
import { loadElevation } from './elevation.ts';
import type { ElevationSample } from './elevation.ts';

const chartWidth = 1000;
const chartHeight = 100;
const formatMeters = (value: number) => Math.round(value).toLocaleString('ja-JP');
const formatDistance = (value: number) => (value / 1000).toFixed(2);
type PositionHandler = (point?: Point) => void;

function buildProfile(segments: ElevationSample[][]) {
  const samples = segments.flat();
  const runs: (ElevationSample & { elevation: number })[][] = [];
  let minimum = Infinity;
  let maximum = -Infinity;
  let up = 0;
  let down = 0;
  let missing = 0;
  for (const segment of segments) {
    let run: (typeof runs)[number] | undefined;
    for (const sample of segment) {
      const { elevation } = sample;
      if (elevation === undefined) {
        missing++;
        run = undefined;
        continue;
      }
      minimum = Math.min(minimum, elevation);
      maximum = Math.max(maximum, elevation);
      const previous = run?.at(-1)?.elevation;
      if (previous !== undefined) {
        up += Math.max(0, elevation - previous);
        down += Math.max(0, previous - elevation);
      }
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push({ ...sample, elevation });
    }
  }
  return { samples, runs, minimum, maximum, up, down, missing };
}

type Profile = ReturnType<typeof buildProfile>;

function ProfileChart({ profile, onPosition }: { profile: Profile; onPosition: PositionHandler }) {
  const [index, setIndex] = useState<number>();
  const { samples } = profile;
  const limit = samples.at(-1)?.meters ?? 0;
  const x = (meters: number) => meters / (limit || 1);
  const graph = useMemo(() => {
    const range = Math.max(20, profile.maximum - profile.minimum);
    const floor = Math.floor(profile.minimum / 10) * 10;
    const ceiling = Math.max(floor + range, Math.ceil(profile.maximum / 10) * 10);
    const y = (value: number) => (ceiling - value) / (ceiling - floor) * chartHeight;
    const paths = profile.runs.map((run) => {
      const start = run[0].meters;
      const end = run.at(-1)!.meters;
      const position = (meters: number) => meters / (limit || 1) * chartWidth;
      const line = run.map(({ meters, elevation }) =>
        `${position(meters).toFixed(2)} ${y(elevation).toFixed(2)}`).join(' L ');
      return {
        line: `M ${line}`,
        area: `M ${position(start)} ${chartHeight} L ${line} L ${position(end)} ${chartHeight} Z`,
      };
    });
    return { paths, ticks: [ceiling, (ceiling + floor) / 2, floor] };
  }, [profile, limit]);

  useEffect(() => () => onPosition(undefined), [onPosition]);

  function select(next?: number) {
    setIndex(next);
    onPosition(next === undefined ? undefined : samples[next].point);
  }

  function pointAt(event: { clientX: number; currentTarget: HTMLDivElement }) {
    const box = event.currentTarget.getBoundingClientRect();
    const target = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * limit;
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (samples[mid].meters < target) lo = mid + 1;
      else hi = mid;
    }
    select(lo > 0 && target - samples[lo - 1].meters < samples[lo].meters - target ? lo - 1 : lo);
  }

  const current = index === undefined ? undefined : samples[index];
  const reading = current && `${formatDistance(current.meters)} km · ${current.elevation === undefined
    ? '標高不明' : `${formatMeters(current.elevation)} m`}`;

  return <div className="elevation-chart">
    <div className="elevation-chart-heading"><span>標高（m）</span>
      <span>{reading ?? 'グラフを指すと地図に位置を表示'}</span>
    </div>
    <div className="elevation-axis-y" aria-hidden="true">
      {graph.ticks.map((value) => <span key={value}>{formatMeters(value)}</span>)}
    </div>
    <div className="elevation-plot" onPointerMove={(event) => { if (event.pointerType === 'mouse') pointAt(event); }}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') select(); }} onClick={pointAt}>
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" aria-hidden="true">
        {[0, chartHeight / 2, chartHeight].map((y) => <line key={y} x1="0" x2={chartWidth} y1={y} y2={y} className="elevation-gridline" />)}
        {graph.paths.map(({ line, area }, i) => <g key={i}>
          <path d={area} className="elevation-area" />
          <path d={line} className="elevation-line" />
        </g>)}
      </svg>
      {current && <span className="elevation-crosshair" style={{ left: `${x(current.meters) * 100}%` }} />}
      <input type="range" min="0" max={samples.length - 1} step="1" value={index ?? 0}
        aria-label="標高グラフ上の位置" aria-valuetext={reading}
        onFocus={() => select(index ?? 0)} onBlur={() => select()}
        onChange={(event) => select(event.currentTarget.valueAsNumber)} />
    </div>
    <div className="elevation-axis-x" aria-hidden="true">
      {(limit ? [0, limit / 4, limit / 2, 3 * limit / 4, limit] : [0]).map((value) =>
        <span key={value} style={{ left: `${x(value) * 100}%` }}>
          {formatDistance(value)}{value === limit ? ' km' : ''}
        </span>)}
    </div>
  </div>;
}

export function ElevationPanel({ lines, distance, complete, onPosition }: {
  lines: Point[][];
  distance: number;
  complete: boolean;
  onPosition: PositionHandler;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ lines: Point[][]; attempt: number; profile: Profile }>();
  const profile = loaded?.lines === lines && loaded.attempt === attempt ? loaded.profile : undefined;
  const hasElevations = !!profile?.runs.length;
  useEffect(() => {
    if (!open || !complete || !lines.length || profile) return;
    const controller = new AbortController();
    void loadElevation(lines, controller.signal).then((segments) => {
      if (!controller.signal.aborted) setLoaded({ lines, attempt, profile: buildProfile(segments) });
    });
    return () => controller.abort();
  }, [open, complete, lines, attempt, profile]);

  return <section className="elevation-panel" aria-label="ルートの標高">
    <button type="button" className="elevation-toggle" aria-expanded={open} aria-controls="elevation-content"
      onClick={() => setOpen(!open)}>
      <strong>標高プロフィール</strong>
      <span>距離 <b>{lines.length ? `${formatDistance(distance)} km` : '—'}</b></span>
      <span>累積上昇 <b>{hasElevations ? `${formatMeters(profile.up)} m` : '—'}</b></span>
      <span>累積下降 <b>{hasElevations ? `${formatMeters(profile.down)} m` : '—'}</b></span>
      <span className="elevation-chevron" aria-hidden="true">{open ? '−' : '＋'}</span>
    </button>
    <div id="elevation-content" className="elevation-content" hidden={!open}>
      {open && <>
        {!complete ? <p role="status">すべての区間が確定すると標高を表示できます。</p>
          : !lines.length ? <p>ルートを作成すると標高を表示できます。</p>
            : !profile ? <p role="status">国土地理院の標高データを読み込み中…</p>
              : !hasElevations ? <p role="status">ルートの標高データを取得できませんでした。</p>
                : <ProfileChart profile={profile} onPosition={onPosition} />}
        {complete && !!lines.length && <div className="elevation-source">
          {hasElevations && profile.missing > 0 && <span>標高データがない箇所があります。上昇・下降は取得できた範囲の値です。</span>}
          {profile && (!hasElevations || profile.missing > 0) && <button type="button" onClick={() => setAttempt(attempt + 1)}>再読み込み</button>}
          <a href="https://maps.gsi.go.jp/development/demtile.html" target="_blank" rel="noreferrer">国土地理院 標高タイル（DEM10B）</a>
        </div>}
      </>}
    </div>
  </section>;
}
