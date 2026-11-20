import { useState } from 'react';
import { samePoint } from '../geo.ts';
import type { Point } from '../geo.ts';
import type { RouteResult } from '../routing/protocol.ts';
import { legInput } from './model.ts';
import type { Project } from './model.ts';
import { CopyText } from './CopyText.tsx';

export type ExportAttempt = {
  kind: 'full' | 'partial';
  status: 'download-requested' | 'download-error' | 'generation-error';
  contents?: string;
};

export function Diagnostics({ project, results, geometry, canExport, partialAvailable, exportAttempt }: {
  project: Project;
  results: (RouteResult | undefined)[];
  geometry: (Point[] | undefined)[];
  canExport: boolean;
  partialAvailable: boolean;
  exportAttempt?: ExportAttempt;
}) {
  const [includeCoordinates, setIncludeCoordinates] = useState(false);

  function report() {
    return JSON.stringify({
      version: __APP_REVISION__,
      graph: __GRAPH_MANIFEST_PATH__,
      environment: {
        browser: navigator.userAgent,
        installed: window.matchMedia('(display-mode: standalone)').matches,
        online: navigator.onLine,
      },
      export: {
        fullAvailable: canExport,
        partialAvailable,
        lastAttempt: exportAttempt && {
          kind: exportAttempt.kind,
          status: exportAttempt.status,
          bytes: exportAttempt.contents === undefined ? undefined : new Blob([exportAttempt.contents]).size,
        },
      },
      legs: project.legs.map((leg, index) => {
        const result = results[index];
        const points = geometry[index];
        const previous = geometry[index - 1];
        const input = includeCoordinates ? legInput(project, index) : undefined;
        return {
          section: index + 1,
          fromWaypoint: index + 1,
          toWaypoint: index + 2,
          mode: leg.mode,
          result: result?.error ?? (points ? 'resolved' : 'pending'),
          pointCount: points?.length ?? 0,
          gapBefore: points && previous ? !samePoint(previous.at(-1)!, points[0]) : undefined,
          fromSnapMeters: result?.fromSnap?.meters,
          toSnapMeters: result?.toSnap?.meters,
          nearestStartOptionMeters: result?.fromOptions.length ? Math.min(...result.fromOptions.map(({ meters }) => meters)) : undefined,
          nearestEndOptionMeters: result?.toOptions.length ? Math.min(...result.toOptions.map(({ meters }) => meters)) : undefined,
          coordinates: input && {
            from: input.from,
            to: input.to,
            fromRoad: input.fromChoice,
            toRoad: input.toChoice,
            ...(leg.mode === 'manual' && { vertices: leg.vertices.map(({ point }) => point) }),
          },
        };
      }),
    }, null, 2);
  }

  return <details className="diagnostics">
    <summary>診断モード</summary>
    <p>探索結果、吸着距離、GPXの書き出し状況をコピーできます。</p>
    <label><input type="checkbox" checked={includeCoordinates} onChange={(event) => setIncludeCoordinates(event.target.checked)} />
      正確な座標を含める</label>
    <CopyText key={String(includeCoordinates)} label="診断情報をコピー" text={report} />
  </details>;
}
