import { useEffect, useRef, useState } from 'react';
import type { Bounds } from '../geo.ts';
import type { Place } from './import.ts';
import { referenceOutline, referencePatterns } from './lineStyle.ts';
import type { LinePattern, LineStyle } from './lineStyle.ts';
import type { useReferences } from './useReferences.ts';
import { isManualWaypoint, WaypointForm } from './WaypointForm.tsx';
import type { WaypointDraft } from './WaypointForm.tsx';

type Props = {
  data: ReturnType<typeof useReferences>;
  selected?: Place;
  exportPlaces: Place[];
  draft?: WaypointDraft;
  onEditWaypoint: (place: Place) => void;
  onSaveWaypoint: (place: Place) => void;
  onCancelWaypoint: () => void;
  onMoveWaypoint: () => void;
  onSelect: (place?: Place) => void;
  onFocus: (bounds: Bounds) => void;
  onFocusPlace: (place: Place) => void;
  onAddWaypoint: (place: Place) => void;
  onToggleExport: (place: Place) => void;
};

function paintSwatch(color: string, pattern?: readonly [number, number]) {
  if (!pattern) return color;
  const [dash, gap] = pattern;
  return `repeating-linear-gradient(90deg, ${color} 0 ${dash}px, transparent ${dash}px ${dash + gap}px)`;
}

function LineSwatch({ style }: { style: LineStyle }) {
  const pattern = referencePatterns[style.pattern].pixels;
  return <span className="reference-swatch" aria-hidden="true" style={{
    height: style.width + referenceOutline, background: paintSwatch('#fffefa', pattern),
  }}>
    <span style={{ height: style.width, background: paintSwatch(style.color, pattern) }} />
  </span>;
}

export function ReferencePanel({ data, selected, exportPlaces, draft, onEditWaypoint, onSaveWaypoint, onCancelWaypoint, onMoveWaypoint,
  onSelect, onFocus, onFocusPlace, onAddWaypoint, onToggleExport }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(40);
  const [styleEditor, setStyleEditor] = useState<{ id: string; original: LineStyle }>();
  const exported = exportPlaces.some((place) => place.key === selected?.key);
  const editable = selected && exported && isManualWaypoint(selected);
  const saved = selected && data.savedKeys.has(selected.key);
  const unsaved = data.listed.filter((place) => !data.savedKeys.has(place.key));
  const [pendingBulk, setPendingBulk] = useState<Place[]>();
  useEffect(() => {
    if (selected) detail.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  return <section className="reference-panel" aria-label="参考レイヤーの管理">
    {draft && <WaypointForm key={draft.place?.key ?? 'new-waypoint'} draft={draft}
      onSave={onSaveWaypoint} onCancel={onCancelWaypoint} onMove={onMoveWaypoint} />}
    <div className="reference-import" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(event) => {
        event.preventDefault();
        void data.addFiles(Array.from(event.dataTransfer.files), onFocus);
      }}>
      <button className="reference-primary" type="button" disabled={data.busy} onClick={() => input.current?.click()}>GPX・KMLを追加</button>
      <input ref={input} type="file" multiple accept=".gpx,.kml" aria-label="参考レイヤーのファイル" hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void data.addFiles(files, onFocus);
        }} />
      <small>ファイルをここにドロップできます。</small>
    </div>
    {data.message && <p className="reference-message" aria-live="polite">{data.message}</p>}
    {!!data.layers.length && <ul className="reference-files">
      {data.layers.map((layer) => <li key={layer.id}>
        <label className="reference-file">
          <input type="checkbox" checked={layer.visible} onChange={() => {
            if (layer.visible && layer.places.some((place) => place.key === selected?.key)) onSelect();
            data.toggleLayer(layer.id);
          }} />
          {layer.lines.length > 0 && <LineSwatch style={layer.lineStyle} />}
          <span>{layer.name}</span>
        </label>
        <small>線 {layer.lines.length} 本 · 地点 {layer.places.length} 件</small>
        <div className="reference-buttons">
          {layer.bounds && <button type="button" onClick={() => onFocus(layer.bounds!)}>全体表示</button>}
          {layer.lines.length > 0 && <button type="button" aria-expanded={styleEditor?.id === layer.id}
            onClick={() => setStyleEditor(styleEditor?.id === layer.id ? undefined : { id: layer.id, original: layer.lineStyle })}>
            線の設定
          </button>}
          <button type="button" disabled={data.busy} onClick={() => {
            if (layer.places.some((place) => place.key === selected?.key)) onSelect();
            data.removeLayer(layer.id);
          }}>レイヤーを外す</button>
        </div>
        {styleEditor?.id === layer.id && <fieldset className="reference-style">
          <legend>参考線の見た目</legend>
          <label className="reference-width" htmlFor={`reference-width-${layer.id}`}>
            <span>太さ <span>{layer.lineStyle.width} px <small>（白縁込み {layer.lineStyle.width + referenceOutline} px）</small></span></span>
            <input id={`reference-width-${layer.id}`} type="range" min="2" max="8" step="1" value={layer.lineStyle.width}
              onChange={(event) => data.changeLineStyle(layer.id, { ...layer.lineStyle, width: event.target.valueAsNumber })} />
          </label>
          <div className="reference-palette">
            <label htmlFor={`reference-color-${layer.id}`}>線の色</label>
            <input id={`reference-color-${layer.id}`} type="color" value={layer.lineStyle.color}
              onChange={(event) => data.changeLineStyle(layer.id, {
                ...layer.lineStyle, color: event.target.value,
              })} />
            <span className="reference-color-value">{layer.lineStyle.color}</span>
          </div>
          <label className="reference-pattern">線種
            <select value={layer.lineStyle.pattern} onChange={(event) => data.changeLineStyle(layer.id, {
              ...layer.lineStyle, pattern: event.target.value as LinePattern,
            })}>
              {Object.entries(referencePatterns).map(([value, { name }]) => <option key={value} value={value}>{name}</option>)}
            </select>
          </label>
          <div className="reference-buttons">
            <button type="button" onClick={() => data.changeLineStyle(layer.id, styleEditor.original)}>元に戻す</button>
            <button type="button" onClick={() => data.useLineDefault(layer.lineStyle)}>新規レイヤーの初期値にする</button>
          </div>
        </fieldset>}
        {layer.links.map((url) => <div key={url} className="reference-link">
          <button type="button" disabled={data.busy} onClick={() => { void data.loadLink(layer, url, onFocus); }}>リンク先を読み込む</button>
          <a href={url} target="_blank" rel="noreferrer">KMLを取得</a>
        </div>)}
        {layer.unsupportedLinks > 0 && <small>対応外の外部リンク {layer.unsupportedLinks} 件</small>}
      </li>)}
    </ul>}

    <div className="reference-filters">
      <label><input type="checkbox" checked={data.showSaved} onChange={(event) => {
        setPendingBulk(undefined);
        if (!event.target.checked && saved) onSelect();
        data.setShowSaved(event.target.checked);
      }} />マイ地点を表示（{data.saved.length} 件）</label>
      {(data.layers.length > 0 || data.saved.length > 0) && <>
        <label>種類 <select value={data.category} onChange={(event) => {
          data.setCategory(event.target.value);
          setLimit(40);
          setPendingBulk(undefined);
        }}>
          <option value="施設">施設・その他</option>
          <option value="すべて">すべて（軌跡点を含む）</option>
          {[...new Set([...data.categories, data.category].filter((value) => value !== '施設' && value !== 'すべて'))]
            .map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label><input type="checkbox" checked={data.onlyHere} onChange={(event) => {
          data.setOnlyHere(event.target.checked);
          setLimit(40);
          setPendingBulk(undefined);
        }} />地図の表示範囲内だけ</label>
        <label>地点名 <input type="search" value={data.search} onChange={(event) => {
          data.setSearch(event.target.value);
          setLimit(40);
          setPendingBulk(undefined);
        }} /></label>
      </>}
    </div>

    {selected && !draft && <div className="reference-detail" ref={detail} aria-label="選択した地点">
      <strong>{selected.name}</strong>
      <small>{selected.category} · {selected.source}</small>
      {selected.folder && <small>{selected.folder}</small>}
      {selected.detail && <p>{selected.detail}</p>}
      <div className="reference-buttons">
        <button type="button" onClick={() => onFocusPlace(selected)}>地図で見る</button>
        {saved
          ? <button type="button" onClick={() => data.removeSaved(selected.key)}>マイ地点から削除</button>
          : <button type="button" onClick={() => data.save([selected])}>マイ地点に保存</button>}
        <button type="button" onClick={() => onAddWaypoint(selected)}>経由地点に追加</button>
        {editable && <button type="button" onClick={() => onEditWaypoint(selected)}>ウェイポイントを編集</button>}
        {editable ? <button type="button" onClick={() => {
          onToggleExport(selected);
          onSelect();
        }}>ウェイポイントを削除</button> : <button type="button" aria-pressed={exported} onClick={() => onToggleExport(selected)}>
          {exported ? 'GPXから外す' : 'GPXにウェイポイントとして含める'}
        </button>}
      </div>
    </div>}

    {!!data.listed.length && <div className="reference-place-list">
      <h2>地点 <small>{data.listed.length} 件</small></h2>
      {pendingBulk ? <div className="reference-buttons">
        <button type="button" onClick={() => { data.save(pendingBulk); setPendingBulk(undefined); }}>{pendingBulk.length}件を保存する</button>
        <button type="button" onClick={() => setPendingBulk(undefined)}>キャンセル</button>
      </div> : unsaved.length > 0 && <button type="button" onClick={() => setPendingBulk(unsaved)}>絞り込んだ地点をまとめて保存</button>}
      <ul>
        {data.listed.slice(0, limit).map((place) => <li key={place.key}>
          <button type="button" aria-pressed={selected?.key === place.key} onClick={() => onSelect(place)}>
            <span>{place.name}</span><small>{place.category}{data.savedKeys.has(place.key) ? ' · 保存済み' : ''}</small>
          </button>
        </li>)}
      </ul>
      {data.listed.length > limit && <button type="button" onClick={() => setLimit(limit + 40)}>さらに表示</button>}
    </div>}

    {!!exportPlaces.length && <div className="reference-place-list">
      <h2>GPXに含める地点 <small>{exportPlaces.length} 件</small></h2>
      <ul>
        {exportPlaces.map((place) => <li key={place.key}>
          <button type="button" onClick={() => onSelect(place)}>{place.name}</button>
        </li>)}
      </ul>
    </div>}
  </section>;
}
