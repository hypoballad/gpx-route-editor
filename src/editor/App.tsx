import { useMemo, useRef, useState } from 'react';
import { lineLength, samePoint } from '../geo.ts';
import type { Bounds, Point } from '../geo.ts';
import { downloadGpx, toGpx, trackSegments } from '../gpx/export.ts';
import { regions, ROAD_MIN_ZOOM, TopoMap } from '../map/TopoMap.tsx';
import type { Viewport } from '../map/TopoMap.tsx';
import { edit, emptyProject, insertWaypoint, legInput, manualLine, moveWaypoint, redo, setWaypoints, undo, updateLeg } from './model.ts';
import type { History, Project, Vertex } from './model.ts';
import { useRoutes } from './useRoutes.ts';
import type { Candidate, Road, RouteResult } from '../routing/protocol.ts';
import { ReferencePanel } from '../reference/ReferencePanel.tsx';
import { useReferences } from '../reference/useReferences.ts';
import type { Place } from '../reference/import.ts';
import { ElevationPanel } from './ElevationPanel.tsx';
import { PwaUpdate } from './PwaUpdate.tsx';
import { isManualWaypoint } from '../reference/WaypointForm.tsx';
import type { WaypointDraft } from '../reference/WaypointForm.tsx';

type Action = 'add' | 'browse' | 'move' | 'insert' | 'vertex' | 'place';
type Side = 'from' | 'to';
const emptyRoads: Road[] = [];
const emptyVertices: Vertex[] = [];
const errors: Record<NonNullable<RouteResult['error']>, string> = {
  outside: '自動探索の対象範囲外です。',
  snap: '50 m以内に吸着先がありません。候補を選ぶか、地点を移動してください。',
  disconnected: '選んだ道同士はつながっていません。',
  'no-path': '通行方向の条件を満たす経路が見つかりません。',
  load: '探索用データを読み込めませんでした。',
};

function whereToInsert(line: Point[], click: Point) {
  const scale = Math.cos(click[1] * Math.PI / 180);
  let nearest = 0;
  let best = Infinity;
  for (let index = 0; index + 1 < line.length; index++) {
    const a = line[index];
    const b = line[index + 1];
    const dx = (b[0] - a[0]) * scale;
    const dy = b[1] - a[1];
    const x = (click[0] - a[0]) * scale;
    const y = click[1] - a[1];
    const length = dx * dx + dy * dy;
    const fraction = length ? Math.max(0, Math.min(1, (x * dx + y * dy) / length)) : 0;
    const score = (x - fraction * dx) ** 2 + (y - fraction * dy) ** 2;
    if (score < best) { nearest = index; best = score; }
  }
  return nearest;
}

function fileDistance(meters: number) {
  return (meters / 1000).toFixed(2) + ' km';
}

export function App() {
  const [history, setHistory] = useState<History>({ past: [], present: emptyProject, future: [] });
  const [name, setName] = useState('登山ルート');
  const [region, setRegion] = useState(regions[0]);
  const [showRoads, setShowRoads] = useState(false);
  const [viewport, setViewport] = useState<Viewport>();
  const [action, setAction] = useState<Action>('add');
  const [legId, setLegId] = useState<string>();
  const [waypointId, setWaypointId] = useState<string>();
  const [vertexId, setVertexId] = useState<string>();
  const [candidateSide, setCandidateSide] = useState<Side>();
  const [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<'route' | 'reference'>('route');
  const [referenceFocus, setReferenceFocus] = useState<{ bounds: Bounds }>();
  const [selectedPlace, setSelectedPlace] = useState<Place>();
  const [exportPlaces, setExportPlaces] = useState<Place[]>([]);
  const [waypointDraft, setWaypointDraft] = useState<WaypointDraft>();
  const [elevationPoint, setElevationPoint] = useState<Point>();
  const mapShell = useRef<HTMLElement>(null);
  const references = useReferences(viewport?.bounds);
  const mapPlaces = useMemo(() => {
    const manual = exportPlaces.filter(isManualWaypoint);
    if (!manual.length) return references.places;
    const manualKeys = new Set(manual.map(({ key }) => key));
    return [...references.places.filter(({ key }) => !manualKeys.has(key)), ...manual];
  }, [references.places, exportPlaces]);
  const project = history.present;
  const roadBounds = showRoads && viewport && viewport.zoom >= ROAD_MIN_ZOOM ? viewport.bounds : undefined;
  const { results, retry, roadResult } = useRoutes(project, roadBounds);
  const selected = project.legs.find((leg) => leg.id === legId) ?? project.legs.at(-1);
  const selectedIndex = selected ? project.legs.indexOf(selected) : -1;
  const activeRoute = results[selectedIndex];
  const activeWaypoint = project.waypoints.findIndex((point) => point.id === waypointId);
  const activeVertex = selected?.vertices.find((point) => point.id === vertexId);
  const lines = useMemo(() => project.legs.flatMap((leg, index) => {
    const points = leg.mode === 'manual' ? manualLine(project, index) : results[index]?.points;
    return points ? [{ id: leg.id, mode: leg.mode, points }] : [];
  }), [project, results]);
  const distances = new Map(lines.map((line) => [line.id, lineLength(line.points)]));
  const total = [...distances.values()].reduce((sum, length) => sum + length, 0);
  const canExport = lines.length === project.legs.length && (lines.length > 0 || exportPlaces.length > 0);
  const outputLines = useMemo(() => lines.map(({ points }) => points), [lines]);
  const fileSegments = canExport ? trackSegments(outputLines).length : 0;
  const guides = useMemo(() => project.legs.flatMap((leg, index) => {
    if (leg.mode !== 'auto') return [];
    const { from, to } = legInput(project, index);
    const { fromSnap, toSnap } = results[index] ?? {};
    const display = (point: Point, marker?: Candidate) => marker && !samePoint(point, marker.point)
      ? [{ from: point, to: marker.point }] : [];
    return [...display(from, fromSnap), ...display(to, toSnap)];
  }), [project, results]);
  const candidateList = candidateSide === 'from' ? activeRoute?.fromOptions : activeRoute?.toOptions;
  const candidates = useMemo(() => candidateSide ? (candidateList ?? []).map((candidate, index) => ({
    ...candidate, label: String(index + 1), side: candidateSide,
  })) : [], [candidateList, candidateSide]);

  const commit = (change: (previous: Project) => Project) => {
    setNotice('');
    setHistory((previous) => edit(previous, change(previous.present)));
  };

  function selectLeg(id: string) {
    setLegId(id);
    setVertexId(undefined);
    setCandidateSide(undefined);
    setAction('browse');
  }

  function selectWaypoint(id: string) {
    setWaypointId(id);
    if (action !== 'add') setAction('browse');
  }

  function chooseCandidate(side: Side, id: string) {
    if (!selected) return;
    commit((previous) => updateLeg(previous, selected.id, (leg) => ({
      ...leg, [side === 'from' ? 'fromChoice' : 'toChoice']: id || null,
    })));
    setCandidateSide(undefined);
  }

  function pointOnMap(point: Point, roadId?: string) {
    if (action === 'place') {
      setWaypointDraft((previous) => ({ point, place: previous?.place }));
      setPanel('reference');
      setAction('browse');
      return;
    }
    if (action === 'move' && waypointId) {
      commit((previous) => moveWaypoint(previous, waypointId, point, roadId));
      setCandidateSide(undefined);
      setAction('browse');
      return;
    }
    if (action === 'vertex' && selected?.mode === 'manual') {
      const index = whereToInsert(manualLine(project, selectedIndex), point);
      const vertex: Vertex = { point, id: crypto.randomUUID() };
      commit((previous) => updateLeg(previous, selected.id, (leg) => ({
        ...leg, vertices: [...leg.vertices.slice(0, index), vertex, ...leg.vertices.slice(index)],
      })));
      setVertexId(vertex.id);
      return;
    }
    if (action !== 'add' && action !== 'insert') return;
    const waypoint = { point, roadId, id: crypto.randomUUID() };
    if (action === 'insert' && selected) {
      const split = selected.mode === 'manual' ? whereToInsert(manualLine(project, selectedIndex), point) : 0;
      commit((previous) => insertWaypoint(previous, selectedIndex + 1, waypoint, split));
      setLegId(undefined);
      setAction('browse');
    } else {
      commit((previous) => insertWaypoint(previous, previous.waypoints.length, waypoint));
      setLegId(undefined);
    }
    setWaypointId(waypoint.id);
    setCandidateSide(undefined);
  }

  function addReferenceWaypoint(place: Place) {
    const waypoint = { id: crypto.randomUUID(), point: place.point, name: place.name };
    commit((previous) => insertWaypoint(previous, previous.waypoints.length, waypoint));
    setWaypointId(waypoint.id);
    setLegId(undefined);
    setCandidateSide(undefined);
    setAction('browse');
    setPanel('route');
  }

  function toggleExport(place: Place) {
    setExportPlaces((previous) => previous.some(({ key }) => key === place.key)
      ? previous.filter(({ key }) => key !== place.key) : [...previous, place]);
  }

  function saveWaypoint(place: Place) {
    setExportPlaces((previous) => previous.some(({ key }) => key === place.key)
      ? previous.map((current) => current.key === place.key ? place : current)
      : [...previous, place]);
    if (references.savedKeys.has(place.key)) references.save([place]);
    setSelectedPlace(place);
    setWaypointDraft(undefined);
  }

  function selectPlace(place?: Place) {
    setWaypointDraft(undefined);
    setSelectedPlace(place);
  }

  function changeWaypointOrder(delta: number) {
    if (activeWaypoint < 0) return;
    commit((previous) => {
      const waypoints = [...previous.waypoints];
      const target = activeWaypoint + delta;
      if (target < 0 || target >= waypoints.length) return previous;
      [waypoints[activeWaypoint], waypoints[target]] = [waypoints[target], waypoints[activeWaypoint]];
      return setWaypoints(previous, waypoints);
    });
    setCandidateSide(undefined);
    setAction('browse');
  }

  function switchMode() {
    if (!selected) return;
    const mode = selected.mode === 'auto' ? 'manual' : 'auto';
    commit((previous) => updateLeg(previous, selected.id, (leg) => ({ ...leg, mode })));
    setAction(mode === 'manual' ? 'vertex' : 'browse');
    setCandidateSide(undefined);
  }

  function historyStep(direction: 'undo' | 'redo') {
    setHistory(direction === 'undo' ? undo : redo);
    setAction('browse');
    setCandidateSide(undefined);
    setNotice('');
  }

  const hint = {
    add: roadResult?.roads.length ? '赤い道をクリックして経由地点を追加' : '地図をクリックして経由地点を追加',
    browse: '地図を移動、地点をドラッグ',
    move: '地点の移動先をクリック',
    insert: '選んだ区間に挿入する地点をクリック',
    vertex: '地図をクリックして手描き頂点を追加',
    place: '地図をクリックしてウェイポイントを置く',
  }[action];
  const roadsHint = !showRoads ? '' : !roadBounds ? '拡大すると道を表示します'
    : !roadResult ? '道を読み込み中…' : roadResult.error ? '道を表示できませんでした'
      : roadResult.limited ? '道が多いため、拡大してください'
        : !roadResult.roads.length ? 'この範囲に探索できる道はありません' : '';

  return <div className="app">
    <header className="top">
      <div className="brand"><span className="brand-icon" aria-hidden="true"><span /></span>
        <div><h1>登山ルートエディタ</h1><p>地理院地図で計画を描く</p></div>
      </div>
      <button type="button" className="export" disabled={!canExport} onClick={() => {
        const title = name.trim() || '登山ルート';
        downloadGpx(toGpx(outputLines, title, lines.some(({ mode }) => mode === 'auto'), exportPlaces), title);
        setNotice('GPXを書き出しました。');
      }}>GPXを書き出す <span aria-hidden="true">↓</span></button>
    </header>
    <PwaUpdate hasEditing={!!(project.waypoints.length || exportPlaces.length || references.layers.length || waypointDraft)
      || name !== '登山ルート'} />

    <main className="studio">
      <aside className="editor" aria-label="ルートと参考レイヤー">
        <nav className="editor-tabs" aria-label="編集パネル">
          <button type="button" aria-pressed={panel === 'route'} onClick={() => setPanel('route')}>ルート編集</button>
          <button type="button" aria-pressed={panel === 'reference'} onClick={() => setPanel('reference')}>参考レイヤー</button>
        </nav>
        <div hidden={panel !== 'route'}>
        <div className="editor-top">
          <label className="name-label" htmlFor="route-name">ルート名</label>
          <input id="route-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          <div className="stats">
            <div><span>合計距離</span><strong data-testid="distance">{lines.length ? fileDistance(total) : '—'}</strong></div>
            <div><span>経由地点</span><strong>{project.waypoints.length}<small> 地点</small></strong></div>
          </div>
          {fileSegments > 1 && <p className="muted">吸着点と入力地点が離れている箇所は、GPX内で別のトラックセグメントになります。</p>}
        </div>
        <div className="actions">
          <button type="button" className="primary" aria-pressed={action === 'add'} onClick={() => {
            setAction(action === 'add' ? 'browse' : 'add');
            setCandidateSide(undefined);
          }}>＋ 地点を追加</button>
          <div className="history">
            <button type="button" title="元に戻す" aria-label="元に戻す" disabled={!history.past.length} onClick={() => historyStep('undo')}>↶</button>
            <button type="button" title="やり直す" aria-label="やり直す" disabled={!history.future.length} onClick={() => historyStep('redo')}>↷</button>
          </div>
        </div>
        <div className="route-list">
          <h2>経由地点と区間</h2>
          {!project.waypoints.length && <div className="empty">
            <span className="empty-pin" aria-hidden="true">＋</span>
            <p>地図をクリックして、出発地点を置いてください。</p>
            <span>2地点を置くと、歩ける道に沿って経路を引きます。</span>
          </div>}
          <ol className="waypoints">
            {project.waypoints.map((waypoint, index) => {
              const leg = project.legs[index];
              const result = results[index];
              const length = leg && distances.get(leg.id);
              return <li key={waypoint.id}>
                <button type="button" className="point-row" aria-pressed={index === activeWaypoint}
                  onClick={() => selectWaypoint(waypoint.id)}>
                  <span className="number">{index + 1}</span>
                  <span><strong>{waypoint.name ?? (index === 0 ? '出発地点' : index === project.waypoints.length - 1 ? '到着地点' : `経由地点 ${index + 1}`)}</strong>
                    <small>{waypoint.point[1].toFixed(5)}, {waypoint.point[0].toFixed(5)}</small></span>
                </button>
                {leg && <button type="button" className={`leg-row ${leg.mode}`} aria-pressed={selected?.id === leg.id}
                  aria-label={`区間 ${index + 1}：${leg.mode === 'manual' ? '手描き' : '自動探索'}`} onClick={() => selectLeg(leg.id)}>
                  <span className="line-key" aria-hidden="true" />
                  <span>{leg.mode === 'manual' ? '手描き' : '自動探索'}</span>
                  <span className={result?.error ? 'error-text' : ''} data-testid={`leg-status-${index}`}>
                    {length !== undefined ? fileDistance(length) : result?.error ? '未解決' : '探索中…'}
                  </span>
                </button>}
              </li>;
            })}
          </ol>
          {activeWaypoint >= 0 && <div className="point-actions" aria-label="選択した経由地点">
            <button type="button" onClick={() => { setAction('move'); setCandidateSide(undefined); }}>地点を移動</button>
            <button type="button" aria-label="地点を前へ" disabled={activeWaypoint === 0} onClick={() => changeWaypointOrder(-1)}>↑</button>
            <button type="button" aria-label="地点を後へ" disabled={activeWaypoint + 1 === project.waypoints.length} onClick={() => changeWaypointOrder(1)}>↓</button>
            <button type="button" className="delete" onClick={() => {
              commit((previous) => setWaypoints(previous, previous.waypoints.filter(({ id }) => id !== waypointId)));
              setWaypointId(undefined);
              setCandidateSide(undefined);
              setAction('browse');
            }}>地点を削除</button>
          </div>}
        </div>
        {selected && <section className="section-panel" aria-label="選択した区間の編集">
          <div className="section-title"><h2>区間 {selectedIndex + 1}</h2>
            <span className={`chip ${selected.mode}`}>{selected.mode === 'auto' ? '自動探索' : '手描き'}</span></div>
          {activeRoute?.error && <p className="error-text" role="status">{errors[activeRoute.error]}</p>}
          {selected.mode === 'auto' && activeRoute?.points && guides.length > 0 && <p className="muted">紫の点線は入力地点から道への吸着を示します。</p>}
          <div className="section-actions">
            <button type="button" onClick={switchMode}>{selected.mode === 'auto' ? '手描きに切り替え' : '自動探索に戻す'}</button>
            <button type="button" onClick={() => { setAction('insert'); setCandidateSide(undefined); }}>区間に地点を挿入</button>
            {activeRoute?.error === 'load' && <button type="button" onClick={retry}>読み込みを再試行</button>}
            {selected.mode === 'manual' && <button type="button" aria-pressed={action === 'vertex'} onClick={() => setAction(action === 'vertex' ? 'browse' : 'vertex')}>頂点を追加</button>}
            {selected.mode === 'manual' && activeVertex && <button type="button" className="delete" onClick={() => {
              commit((previous) => updateLeg(previous, selected.id, (leg) => ({
                ...leg, vertices: leg.vertices.filter(({ id }) => id !== activeVertex.id),
              })));
              setVertexId(undefined);
            }}>頂点を削除</button>}
          </div>
          {selected.mode === 'manual' && selected.vertices.length > 0
            && <p className="muted">{selected.vertices.length} 頂点。ドラッグで移動できます。</p>}
          {activeRoute && (activeRoute.fromOptions.length > 0 || activeRoute.toOptions.length > 0) && <div className="snap-review">
            {(['from', 'to'] as const).map((side) => <button key={side} type="button" aria-pressed={candidateSide === side}
              disabled={!(side === 'from' ? activeRoute.fromOptions : activeRoute.toOptions).length}
              onClick={() => { setAction('browse'); setCandidateSide(candidateSide === side ? undefined : side); }}>
              {side === 'from' ? '始点' : '終点'}の吸着候補
            </button>)}
            {candidateSide && <div className="choices" aria-label="吸着候補の一覧">
              <button type="button" onClick={() => chooseCandidate(candidateSide, '')}>自動選択に戻す</button>
              {candidates.map((candidate) => <button type="button" key={candidate.id}
                onClick={() => chooseCandidate(candidate.side, candidate.id)}>
                候補 {candidate.label} · {candidate.meters.toFixed(0)} m{candidate.shorterRoute ? ' · 別経路あり' : ''}
              </button>)}
            </div>}
          </div>}
        </section>}
        </div>
        {panel === 'reference' && <ReferencePanel data={references} selected={selectedPlace} exportPlaces={exportPlaces}
          draft={waypointDraft} onEditWaypoint={(place) => setWaypointDraft({ point: place.point, place })}
          onSaveWaypoint={(place) => { saveWaypoint(place); setAction('browse'); }}
          onCancelWaypoint={() => { setWaypointDraft(undefined); setAction('browse'); }}
          onMoveWaypoint={() => {
            setAction('place');
            mapShell.current?.scrollIntoView({ block: 'nearest' });
          }}
          onSelect={selectPlace} onFocus={(bounds) => setReferenceFocus({ bounds })}
          onFocusPlace={({ point: [lon, lat] }) => setReferenceFocus({ bounds: { west: lon, east: lon, south: lat, north: lat } })}
          onAddWaypoint={addReferenceWaypoint} onToggleExport={toggleExport} />}
        <p className="notice" aria-live="polite">{notice}</p>
      </aside>

      <div className="map-workspace">
      <section ref={mapShell} className="map-shell" aria-label="地図と地域切替">
        <TopoMap region={region} lines={lines} guides={guides}
          roads={roadResult?.roads ?? emptyRoads} onViewport={setViewport}
          referenceLines={references.lines} referencePlaces={mapPlaces} savedPlaces={references.savedKeys}
          referenceStyles={references.lineStyles}
          selectedPlace={waypointDraft ? undefined : selectedPlace?.key} referenceFocus={referenceFocus} elevationPoint={elevationPoint}
          placingWaypoint={action === 'place'} draftWaypoint={waypointDraft?.point}
          onReferencePlace={(place) => { selectPlace(place); setPanel('reference'); }}
          snapRoads={action === 'add' || action === 'move' || action === 'insert'}
          selectedLeg={selected?.id} selectedWaypoint={waypointId} selectedVertex={vertexId}
          waypoints={project.waypoints} vertices={selected?.mode === 'manual' ? selected.vertices : emptyVertices}
          candidates={candidates} cursor={action === 'browse' ? 'browse' : 'draw'}
          onClick={pointOnMap} onLeg={selectLeg} onWaypoint={selectWaypoint}
          onVertex={setVertexId} onCandidate={chooseCandidate}
          onDragWaypoint={(id, point, roadId) => {
            commit((previous) => moveWaypoint(previous, id, point, roadId));
            setWaypointId(id);
            setCandidateSide(undefined);
          }}
          onDragVertex={(id, point) => {
            if (!selected) return;
            commit((previous) => updateLeg(previous, selected.id, (leg) => ({
              ...leg, vertices: leg.vertices.map((vertex) => vertex.id === id ? { id, point } : vertex),
            })));
            setVertexId(id);
          }} />
        <div className="map-top">
          <nav aria-label="表示する地域" className="regions">
            {regions.map((item) => <button type="button" key={item.name} aria-pressed={region.name === item.name} onClick={() => setRegion({ ...item })}>{item.name}</button>)}
          </nav>
          <div className="map-hint road-toggle">
            <button type="button" aria-pressed={showRoads} onClick={() => setShowRoads(!showRoads)}>
              <span aria-hidden="true" />探索できる道
            </button>
            {roadsHint && <span role="status">{roadsHint}</span>}
          </div>
          <div className="map-hint waypoint-toggle">
            <button type="button" aria-pressed={action === 'place'} onClick={() => {
              if (action === 'place') {
                setAction('browse');
                return;
              }
              setPanel('reference');
              selectPlace();
              setCandidateSide(undefined);
              setAction('place');
            }}>＋ ウェイポイント追加</button>
          </div>
          <div className="map-hint"><span>{hint}</span>
            {action !== 'browse' && <button type="button" onClick={() => setAction('browse')}>終了</button>}
          </div>
        </div>
        <div className="sources">
          <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル（国土地理院）</a>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
          <a href="./graph/manifest.json" target="_blank" rel="noreferrer">探索データ</a>
        </div>
      </section>
      <ElevationPanel lines={outputLines} distance={total} complete={lines.length === project.legs.length}
        onPosition={setElevationPoint} />
      </div>
    </main>
  </div>;
}
