import { useEffect, useRef } from 'react';
import type { Point } from '../geo.ts';
import type { Place } from './import.ts';

export type WaypointDraft = { point: Point; place?: Place };
const categories = ['その他', '登山口', 'トイレ', '茶屋・売店', '水場・エイド', '山小屋', '交通'];

export function isManualWaypoint(place: Place) {
  return place.key.startsWith('manual:');
}

export function WaypointForm({ draft, onSave, onCancel, onMove }: {
  draft: WaypointDraft;
  onSave: (place: Place) => void;
  onCancel: () => void;
  onMove: () => void;
}) {
  const nameInput = useRef<HTMLInputElement>(null);
  const { point, place } = draft;
  useEffect(() => {
    nameInput.current?.focus();
  }, [draft]);

  return <form className="waypoint-form" aria-label={place ? 'ウェイポイントの編集' : '新しいウェイポイント'} onSubmit={(event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get('name') ?? '').trim();
    if (!name) {
      nameInput.current?.setCustomValidity('地点名を入力してください。');
      nameInput.current?.reportValidity();
      return;
    }
    onSave({
      key: place?.key ?? `manual:${crypto.randomUUID()}`,
      source: '手動追加',
      point,
      name,
      category: String(fields.get('category')),
      detail: String(fields.get('memo') ?? '').trim() || undefined,
    });
  }}>
    <h2>{place ? 'ウェイポイントの編集' : '新しいウェイポイント'}</h2>
    <small>{point[1].toFixed(5)}, {point[0].toFixed(5)}</small>
    <label>ウェイポイント名
      <input ref={nameInput} name="name" defaultValue={place?.name} maxLength={160} required
        onInput={(event) => event.currentTarget.setCustomValidity('')} />
    </label>
    <label>地点の種類
      <select name="category" defaultValue={place?.category ?? 'その他'}>
        {categories.map((category) => <option key={category}>{category}</option>)}
      </select>
    </label>
    <label>メモ
      <textarea name="memo" defaultValue={place?.detail} rows={2} maxLength={500} />
    </label>
    <div className="reference-buttons">
      <button type="submit" className="reference-primary">{place ? '変更を保存' : 'GPXに追加'}</button>
      <button type="button" onClick={onMove}>地図で位置を変更</button>
      <button type="button" onClick={onCancel}>キャンセル</button>
    </div>
  </form>;
}
