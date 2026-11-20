import { useEffect, useMemo, useRef, useState } from 'react';
import { contains } from '../geo.ts';
import type { Bounds } from '../geo.ts';
import { MAX_REFERENCE_BYTES, readLinkedKml, readReference } from './import.ts';
import type { Place, ReferenceLayer } from './import.ts';
import { layerLineStyle, loadLineDefault, saveLineDefault } from './lineStyle.ts';
import type { LineStyle } from './lineStyle.ts';
import { updatePlaces } from './storage.ts';

export function useReferences(viewport?: Bounds) {
  const [layers, setLayers] = useState<ReferenceLayer[]>([]);
  const [lineOverrides, setLineOverrides] = useState(() => new Map<string, LineStyle>());
  const [lineDefault, setLineDefault] = useState(loadLineDefault);
  const [saved, setSaved] = useState<Place[]>([]);
  const [showSaved, setShowSaved] = useState(true);
  const [category, setCategory] = useState('施設');
  const [onlyHere, setOnlyHere] = useState(true);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const storageQueue = useRef(Promise.resolve());
  const color = useRef(0);
  const importBusy = useRef(false);

  function store(places?: Place[], remove?: string) {
    const task = storageQueue.current.then(async () => {
      try {
        setSaved(await updatePlaces(places, remove));
        if (places?.length) setMessage(`${places.length}件をマイ地点に保存しました。`);
        if (remove) setMessage('マイ地点から削除しました。');
      } catch {
        setMessage('端末の地点データを読み込み・保存できませんでした。');
      }
    });
    storageQueue.current = task;
  }

  useEffect(() => { store(); }, []);

  async function addFiles(files: File[], focus: (bounds: Bounds) => void) {
    if (importBusy.current || !files.length) return;
    importBusy.current = true;
    setBusy(true);
    const imported: ReferenceLayer[] = [];
    const failures: string[] = [];
    try {
      for (const file of files) {
        try {
          if (file.size > MAX_REFERENCE_BYTES) throw new Error('1ファイル20 MBまで読み込めます。');
          const layer = readReference(await file.text(), file.name, layerLineStyle(lineDefault, color.current));
          if (layer.lines.length || layer.links.length) color.current++;
          imported.push(layer);
        } catch (error) {
          failures.push(`${file.name} — ${error instanceof Error ? error.message : '読み込めませんでした。'}`);
        }
      }
      if (imported.length) {
        setLayers((previous) => [...previous, ...imported]);
        const first = imported.find(({ bounds }) => bounds)?.bounds;
        if (first) focus(first);
      }
      setMessage(failures.length ? failures.join('\n') : `${imported.length}件を参考レイヤーに追加しました。`);
    } finally {
      importBusy.current = false;
      setBusy(false);
    }
  }

  async function loadLink(layer: ReferenceLayer, url: string, focus: (bounds: Bounds) => void) {
    if (importBusy.current) return;
    importBusy.current = true;
    setBusy(true);
    setMessage('リンク先の施設データを読み込んでいます…');
    try {
      const separate = layer.lines.length > 0;
      const loaded = readReference(await readLinkedKml(url), layer.name,
        separate ? layerLineStyle(lineDefault, color.current++) : layer.lineStyle);
      if (!loaded.lines.length && !loaded.places.length) throw new Error('リンク先に線や地点がありません。');
      const geometry: ReferenceLayer = {
        ...loaded, links: [], unsupportedLinks: 0,
        places: loaded.places.map((place) => ({ ...place, sourceUrl: url })),
      };
      setLayers((previous) => previous.flatMap((current) => {
        if (current.id !== layer.id) return [current];
        const links = current.links.filter((link) => link !== url);
        return links.length || current.lines.length || current.places.length
          ? [{ ...current, links }, geometry] : [geometry];
      }));
      if (geometry.bounds) focus(geometry.bounds);
      setMessage(`線${geometry.lines.length}本、地点${geometry.places.length}件を読み込みました。`);
    } catch {
      setMessage('リンク先を読み込めませんでした。施設を含むKMLを入手し、ファイルとして読み込んでください。');
    } finally {
      importBusy.current = false;
      setBusy(false);
    }
  }

  const savedKeys = useMemo(() => new Set(saved.map(({ key }) => key)), [saved]);
  const styledLayers = useMemo(() => layers.map((layer) =>
    ({ ...layer, lineStyle: lineOverrides.get(layer.id) ?? layer.lineStyle })), [layers, lineOverrides]);
  const lines = useMemo(() => layers.flatMap((layer) => layer.visible
    ? layer.lines.map((points) => ({ points, layerId: layer.id })) : []), [layers]);
  const lineStyles = useMemo(() => styledLayers.filter((layer) => layer.visible && layer.lines.length)
    .map(({ id, lineStyle }) => ({ id, ...lineStyle })), [styledLayers]);
  const displayed = useMemo(() => {
    const places = new Map<string, Place>();
    for (const layer of layers) {
      if (layer.visible) for (const place of layer.places) places.set(place.key, place);
    }
    if (showSaved) for (const place of saved) places.set(place.key, place);
    return [...places.values()];
  }, [layers, saved, showSaved]);
  const categories = useMemo(() => [...new Set(displayed.map((place) => place.category))]
    .sort((a, b) => a.localeCompare(b, 'ja')), [displayed]);
  const places = useMemo(() => {
    const query = search.trim().normalize('NFKC').toLocaleLowerCase('ja');
    return displayed.filter((place) => {
      const matchesCategory = category === 'すべて'
        || (category === '施設' ? place.category !== '軌跡点' : place.category === category);
      return matchesCategory && (!query || place.name.normalize('NFKC').toLocaleLowerCase('ja').includes(query));
    });
  }, [displayed, category, search]);
  const listed = useMemo(() => !onlyHere || !viewport ? places : places.filter(({ point }) => contains(viewport, point)),
    [onlyHere, viewport, places]);

  return {
    layers: styledLayers, saved, savedKeys, showSaved, setShowSaved, category, setCategory, onlyHere, setOnlyHere,
    categories, lines, lineStyles, places, listed, message, busy, addFiles, loadLink, search, setSearch,
    changeLineStyle: (id: string, style: LineStyle) => setLineOverrides((previous) => new Map(previous).set(id, style)),
    useLineDefault: (style: LineStyle) => {
      try {
        saveLineDefault(style);
        setLineDefault(style);
        color.current = 0;
        setMessage('新規レイヤーの初期値として保存しました。');
      } catch {
        setMessage('新規レイヤーの初期値を保存できませんでした。');
      }
    },
    toggleLayer: (id: string) => setLayers((previous) =>
      previous.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer)),
    removeLayer: (id: string) => {
      setLayers((previous) => previous.filter((layer) => layer.id !== id));
      setLineOverrides((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
    },
    save: (places: Place[]) => store(places),
    removeSaved: (key: string) => store(undefined, key),
  };
}
