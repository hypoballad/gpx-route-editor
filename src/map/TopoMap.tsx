import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as LibreMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry, LineString } from 'geojson';
import { samePoint } from '../geo.ts';
import type { Bounds, Point } from '../geo.ts';
import type { Vertex, Waypoint } from '../editor/model.ts';
import type { Candidate, Road } from '../routing/protocol.ts';
import type { Place } from '../reference/import.ts';
import { mapDashArray, referenceOutline } from '../reference/lineStyle.ts';
import type { LineStyle } from '../reference/lineStyle.ts';
import type { ReferenceNetwork } from '../routing/referenceNetwork.ts';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);

export const regions = [
  { name: '奥多摩', center: [139.014, 35.838] as Point, zoom: 12 },
  { name: '奥秩父', center: [138.685, 35.890] as Point, zoom: 11.6 },
  { name: '富士山', center: [138.735, 35.370] as Point, zoom: 12.5 },
];

type RouteLine = { id: string; mode: 'auto' | 'manual'; points: Point[] };
type Guide = { from: Point; to: Point };
type Region = typeof regions[number];
export type Viewport = { bounds: Bounds; zoom: number };
export const ROAD_MIN_ZOOM = 11.5;
const roadLayer = 'routing-roads';
const roadWidth = 6;
type Props = {
  lines: RouteLine[];
  waypoints: Waypoint[];
  vertices: Vertex[];
  guides: Guide[];
  roads: Road[];
  referenceLines: { points: Point[]; layerId: string }[];
  referenceStyles: (LineStyle & { id: string })[];
  referenceNetwork: ReferenceNetwork;
  referencePlaces: Place[];
  savedPlaces: ReadonlySet<string>;
  selectedPlace?: string;
  placingWaypoint: boolean;
  draftWaypoint?: Point;
  elevationPoint?: Point;
  referenceFocus?: { bounds: Bounds };
  candidates: (Candidate & { side: 'from' | 'to'; label: string })[];
  selectedLeg?: string;
  selectedWaypoint?: string;
  selectedVertex?: string;
  region: Region;
  cursor: 'draw' | 'browse';
  snapRoads: boolean;
  onViewport: (view: Viewport) => void;
  onClick: (point: Point, roadId?: string) => void;
  onReferencePlace: (place: Place) => void;
  onLeg: (id: string) => void;
  onWaypoint: (id: string) => void;
  onVertex: (id: string) => void;
  onDragWaypoint: (id: string, point: Point, roadId?: string) => void;
  onDragVertex: (id: string, point: Point) => void;
  onCandidate: (side: 'from' | 'to', id: string) => void;
};

const blank: FeatureCollection = { type: 'FeatureCollection', features: [] };
const style: StyleSpecification = {
  version: 8,
  sources: {
    gsi: { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
      tileSize: 256, minzoom: 2, maxzoom: 18 },
    lines: { type: 'geojson', data: blank },
    roads: { type: 'geojson', data: blank, tolerance: 0 },
    references: { type: 'geojson', data: blank },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#e8ece2' } },
    { id: 'gsi', type: 'raster', source: 'gsi' },
    { id: 'routing-roads-outline', type: 'line', source: 'roads', minzoom: ROAD_MIN_ZOOM,
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#fff', 'line-width': roadWidth, 'line-opacity': 0.95 } },
    { id: roadLayer, type: 'line', source: 'roads', minzoom: ROAD_MIN_ZOOM,
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#c72636', 'line-width': roadWidth - 1.5 } },
    { id: 'route-border', type: 'line', source: 'lines', filter: ['!=', ['get', 'mode'], 'guide'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fffefa', 'line-width': ['case', ['get', 'selected'], 9, 7] } },
    { id: 'route-auto', type: 'line', source: 'lines', filter: ['==', ['get', 'mode'], 'auto'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#087453', 'line-width': ['case', ['get', 'selected'], 6, 4] } },
    { id: 'route-manual', type: 'line', source: 'lines', filter: ['==', ['get', 'mode'], 'manual'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#a5530e', 'line-width': ['case', ['get', 'selected'], 6, 4], 'line-dasharray': [2, 1.2] } },
    { id: 'route-guides', type: 'line', source: 'lines', filter: ['==', ['get', 'mode'], 'guide'],
      paint: { 'line-color': '#575185', 'line-width': 2, 'line-dasharray': [1, 1] } },
    { id: 'reference-places', type: 'circle', source: 'references', filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 6,
        'circle-color': ['case', ['get', 'saved'], '#077580', '#713ba4'],
        'circle-stroke-width': 2, 'circle-stroke-color': '#fffefa',
      } },
  ],
};

type MarkerItem = {
  key: string;
  point: Point;
  text: string;
  label: string;
  className: string;
  anchor?: 'bottom';
  select?: () => void;
  drag?: (point: Point, roadId?: string) => void;
};

function pickRoad(instance: LibreMap, point: Point, roads: ReadonlyMap<string, Road>, radius: number) {
  if (!roads.size || instance.getZoom() < ROAD_MIN_ZOOM || !instance.getLayer(roadLayer)) return;
  const { x, y } = instance.project(point);
  const hits = instance.queryRenderedFeatures([[x - radius, y - radius], [x + radius, y + radius]], {
    layers: [roadLayer],
  });
  let best: { point: Point; id: string; square: number } | undefined;
  for (const { properties } of hits) {
    const road = roads.get(properties.id);
    if (!road) continue;
    const [start, end] = road.points;
    const a = instance.project(start);
    const b = instance.project(end);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const size = dx * dx + dy * dy;
    if (!size) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / size));
    const square = (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2;
    if (square <= radius * radius && (!best || square < best.square || (square === best.square && road.id < best.id))) {
      best = {
        point: [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])],
        id: road.id, square,
      };
    }
  }
  return best;
}

function pickReferenceRoad(instance: LibreMap, network: ReferenceNetwork, point: Point) {
  const screen = instance.project(point);
  return network.pick(point, (position) => instance.project(position).dist(screen) <= 8);
}

export function TopoMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | undefined>(undefined);
  const elevationMarker = useRef<Marker | undefined>(undefined);
  const [drawnRoads, setDrawnRoads] = useState<Road[]>();
  const visibleRoads = props.roads.length ? drawnRoads : undefined;
  const roadLookup = useMemo(() => new Map(visibleRoads?.map((road) => [road.id, road])), [visibleRoads]);
  const placeLookup = useMemo(() => new Map(props.referencePlaces.map((place) => [place.key, place])), [props.referencePlaces]);
  const focusedPlace = props.selectedPlace ? placeLookup.get(props.selectedPlace) : undefined;
  const latest = useRef({ ...props, roadLookup, placeLookup });
  latest.current = { ...props, roadLookup, placeLookup };
  const markers = useRef(new Map<string, { marker: Marker; button: HTMLButtonElement; point: Point }>());
  const drawnReferenceStyles = useRef(new Map<string, LineStyle>());
  const [status, setStatus] = useState<'loading' | 'ready' | 'tile' | 'unavailable'>('loading');

  useEffect(() => {
    let instance: LibreMap;
    try {
      instance = new LibreMap({
        container: container.current!, style, center: latest.current.region.center, zoom: latest.current.region.zoom,
        minZoom: 3, maxZoom: 19, attributionControl: false, dragRotate: false, pitchWithRotate: false,
        renderWorldCopies: false, canvasContextAttributes: { antialias: true },
      });
    } catch {
      setStatus('unavailable');
      return;
    }
    map.current = instance;
    instance.touchZoomRotate.disableRotation();
    instance.doubleClickZoom.disable();
    instance.keyboard.disableRotation();
    instance.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    let previousView: Viewport | undefined;
    const reportViewport = () => {
      const bounds = instance.getBounds();
      const next: Viewport = {
        zoom: instance.getZoom(),
        bounds: { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() },
      };
      const previous = previousView?.bounds;
      if (previous && previousView?.zoom === next.zoom && previous.west === next.bounds.west && previous.south === next.bounds.south
        && previous.east === next.bounds.east && previous.north === next.bounds.north) return;
      previousView = next;
      latest.current.onViewport(next);
    };
    reportViewport();
    instance.on('moveend', reportViewport);
    instance.on('resize', reportViewport);
    instance.on('load', () => setStatus((previous) => previous === 'tile' ? previous : 'ready'));
    instance.on('error', (event) => {
      if ((event as { sourceId?: string }).sourceId === 'gsi') setStatus('tile');
    });
    instance.on('sourcedata', (event) => {
      if (event.sourceId === 'gsi' && event.isSourceLoaded && event.sourceDataType === 'content') setStatus('ready');
    });
    instance.on('click', (event) => {
      const current = latest.current;
      const point: Point = [event.lngLat.lng, event.lngLat.lat];
      if (current.placingWaypoint) {
        current.onClick(point);
        return;
      }
      const course = current.snapRoads && pickReferenceRoad(instance, current.referenceNetwork, point);
      if (course) {
        current.onClick(course.point, course.id);
        return;
      }
      if (current.placeLookup.size && instance.getLayer('reference-places')) {
        const hit = instance.queryRenderedFeatures(event.point, { layers: ['reference-places'] })[0];
        const place = hit && current.placeLookup.get(hit.properties.key);
        if (place) {
          current.onReferencePlace(place);
          return;
        }
      }
      if (current.cursor === 'browse') {
        const features = instance.queryRenderedFeatures(event.point, {
          layers: ['route-auto', 'route-manual'].filter((id) => instance.getLayer(id)),
        });
        const id = features[0]?.properties?.id;
        if (typeof id === 'string') current.onLeg(id);
      } else {
        const road = current.snapRoads ? pickRoad(instance, point, current.roadLookup, 8) : undefined;
        current.onClick(road?.point ?? point, road?.id);
      }
    });
    return () => {
      for (const { marker } of markers.current.values()) marker.remove();
      markers.current.clear();
      instance.remove();
      map.current = undefined;
    };
  }, []);

  useEffect(() => {
    map.current?.jumpTo({ center: props.region.center, zoom: props.region.zoom });
  }, [props.region]);

  useEffect(() => {
    const instance = map.current;
    const bounds = props.referenceFocus?.bounds;
    if (!instance || !bounds) return;
    if (bounds.west === bounds.east && bounds.south === bounds.north) {
      instance.jumpTo({ center: [bounds.west, bounds.south], zoom: Math.max(14, instance.getZoom()) });
    } else {
      instance.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 56, maxZoom: 15, duration: 0 });
    }
  }, [props.referenceFocus]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const sync = () => {
      const drawn = drawnReferenceStyles.current;
      const retained = new Set(props.referenceStyles.map(({ id }) => id));
      for (const id of drawn.keys()) {
        if (retained.has(id)) continue;
        instance.removeLayer(`reference-halo-${id}`);
        instance.removeLayer(`reference-line-${id}`);
        drawn.delete(id);
      }
      for (const { id, ...style } of props.referenceStyles) {
        const old = drawn.get(id);
        if (old?.color === style.color && old.width === style.width && old.pattern === style.pattern) continue;
        for (const outline of [true, false]) {
          const layerId = `reference-${outline ? 'halo' : 'line'}-${id}`;
          const width = style.width + (outline ? referenceOutline : 0);
          const color = outline ? '#fffefa' : style.color;
          const dash = mapDashArray(style.pattern, width);
          if (instance.getLayer(layerId)) {
            if (!outline && old?.color !== style.color) instance.setPaintProperty(layerId, 'line-color', color);
            if (old?.width !== style.width) instance.setPaintProperty(layerId, 'line-width', width);
            if (old?.pattern !== style.pattern || (dash && old?.width !== style.width)) {
              instance.setPaintProperty(layerId, 'line-dasharray', dash);
            }
          } else {
            instance.addLayer({
              id: layerId, type: 'line', source: 'references',
              filter: ['==', ['get', 'layerId'], id],
              layout: { 'line-join': 'round' },
              paint: { 'line-color': color, 'line-width': width, 'line-dasharray': dash },
            }, 'route-border');
          }
        }
        drawn.set(id, style);
      }
    };
    if (instance.getLayer('route-border')) sync();
    else instance.once('load', sync);
    return () => { instance.off('load', sync); };
  }, [props.referenceStyles]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const sync = () => {
      const features: Feature<Geometry>[] = [
        ...props.referenceLines.map(({ points, layerId }): Feature<LineString> => ({
          type: 'Feature', properties: { layerId }, geometry: { type: 'LineString', coordinates: points },
        })),
        ...props.referencePlaces.filter((place) => place.key !== props.selectedPlace).map((place): Feature<Geometry> => ({
          type: 'Feature',
          properties: { key: place.key, saved: props.savedPlaces.has(place.key) },
          geometry: { type: 'Point', coordinates: place.point },
        })),
      ];
      const source = instance.getSource('references') as GeoJSONSource | undefined;
      void source?.setData({ type: 'FeatureCollection', features });
    };
    if (instance.getSource('references')) sync();
    else instance.once('load', sync);
    return () => { instance.off('load', sync); };
  }, [props.referenceLines, props.referencePlaces, props.savedPlaces, props.selectedPlace]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    let cancelled = false;
    const markDrawn = () => {
      if (!instance.isSourceLoaded('roads')) return;
      instance.off('render', markDrawn);
      setDrawnRoads(props.roads);
    };
    const sync = async () => {
      const features: Feature<LineString>[] = props.roads.map(({ id, points }) => ({
        type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: points },
      }));
      try {
        await (instance.getSource('roads') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
        if (cancelled) return;
        if (!props.roads.length) {
          setDrawnRoads(undefined);
          return;
        }
        instance.on('render', markDrawn);
        instance.triggerRepaint();
      } catch (error) {
        if (!cancelled) console.error(error);
      }
    };
    if (instance.getSource('roads')) void sync();
    else instance.once('load', sync);
    return () => {
      cancelled = true;
      instance.off('load', sync);
      instance.off('render', markDrawn);
    };
  }, [props.roads]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const sync = () => {
      const features: Feature<LineString>[] = [
        ...props.lines.map(({ id, mode, points }): Feature<LineString> => ({
          type: 'Feature', properties: { id, mode, selected: id === props.selectedLeg },
          geometry: { type: 'LineString', coordinates: points },
        })),
        ...props.guides.map(({ from, to }): Feature<LineString> => ({
          type: 'Feature', properties: { mode: 'guide' },
          geometry: { type: 'LineString', coordinates: [from, to] },
        })),
      ];
      (instance.getSource('lines') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    };
    if (instance.getSource('lines')) sync();
    else instance.once('load', sync);
    return () => { instance.off('load', sync); };
  }, [props.lines, props.guides, props.selectedLeg]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const items: MarkerItem[] = [
      ...props.waypoints.map(({ id, point, roadId }, index) => ({
        key: 'waypoint:' + id, point, text: String(index + 1), label: `経由地点 ${index + 1}`,
        className: 'map-pin waypoint' + (roadId ? ' road-anchor' : '') + (props.selectedWaypoint === id ? ' selected' : ''),
        select: () => latest.current.onWaypoint(id),
        drag: (position: Point, edge?: string) => latest.current.onDragWaypoint(id, position, edge),
      })),
      ...props.vertices.map(({ id, point }, index) => ({
        key: 'vertex:' + id, point, text: '', label: `手描き頂点 ${index + 1}`,
        className: 'map-pin vertex' + (props.selectedVertex === id ? ' selected' : ''),
        select: () => latest.current.onVertex(id), drag: (position: Point) => latest.current.onDragVertex(id, position),
      })),
      ...props.candidates.map(({ id, point, side, label }) => ({
        key: `candidate:${side}:${id}`, point, text: label, label: `吸着候補 ${label}`,
        className: 'map-pin candidate', select: () => latest.current.onCandidate(side, id),
      })),
    ];
    for (const [index, guide] of props.guides.entries()) items.push({
      key: `snap:${index}`, point: guide.to, text: '', label: '吸着位置', className: 'map-pin snapped',
    });
    if (props.draftWaypoint) items.push({
      key: 'draft-waypoint', point: props.draftWaypoint, text: '', label: '入力中のウェイポイント',
      className: 'reference-selected-pin draft', anchor: 'bottom',
    });
    if (focusedPlace) items.push({
      key: `reference:${focusedPlace.key}`, point: focusedPlace.point, text: '',
      label: `${focusedPlace.name}（選択した参考地点）`,
      className: 'reference-selected-pin' + (props.savedPlaces.has(focusedPlace.key) ? ' saved' : ''),
      anchor: 'bottom', select: () => latest.current.onReferencePlace(focusedPlace),
    });
    for (const item of items) {
      let entry = markers.current.get(item.key);
      if (!entry) {
        const button = document.createElement('button');
        button.type = 'button';
        const marker = new Marker({ element: button, draggable: !!item.drag, anchor: item.anchor })
          .setLngLat(item.point).addTo(instance);
        marker.on('dragend', () => {
          const { lng, lat } = marker.getLngLat();
          const point: Point = [lng, lat];
          const current = latest.current;
          const road = item.key.startsWith('waypoint:')
            ? pickReferenceRoad(instance, current.referenceNetwork, point) ?? pickRoad(instance, point, current.roadLookup, 8)
            : undefined;
          if (road) marker.setLngLat(road.point);
          item.drag?.(road?.point ?? point, road?.id);
        });
        entry = { button, marker, point: item.point };
        markers.current.set(item.key, entry);
      } else if (!samePoint(entry.point, item.point)) {
        entry.marker.setLngLat(item.point);
        entry.point = item.point;
      }
      entry.button.onclick = (event) => {
        event.stopPropagation();
        if (latest.current.placingWaypoint) latest.current.onClick(item.point);
        else item.select?.();
      };
      entry.button.className = `maplibregl-marker maplibregl-marker-anchor-${item.anchor ?? 'center'} ${item.className}`;
      entry.button.textContent = item.text;
      entry.button.setAttribute('aria-label', item.label);
      entry.button.tabIndex = item.select ? 0 : -1;
      entry.button.disabled = !item.select;
    }
    const keys = new Set(items.map(({ key }) => key));
    for (const [key, { marker }] of markers.current) {
      if (!keys.has(key)) {
        marker.remove();
        markers.current.delete(key);
      }
    }
  }, [props.waypoints, props.vertices, props.candidates, props.guides, props.savedPlaces,
    props.selectedWaypoint, props.selectedVertex, props.draftWaypoint, focusedPlace]);

  useEffect(() => {
    const instance = map.current;
    const point = props.elevationPoint;
    if (!instance || !point) {
      elevationMarker.current?.remove();
      elevationMarker.current = undefined;
      return;
    }
    if (!elevationMarker.current) {
      const element = document.createElement('div');
      element.className = 'elevation-map-point';
      element.setAttribute('aria-hidden', 'true');
      elevationMarker.current = new Marker({ element }).setLngLat(point).addTo(instance);
    } else elevationMarker.current.setLngLat(point);
  }, [props.elevationPoint]);

  useEffect(() => () => { elevationMarker.current?.remove(); }, []);

  return <>
    <div className="map-canvas" ref={container} aria-label="地理院地図" data-cursor={props.cursor}
      data-status={status} data-road-count={visibleRoads?.length ?? 0} />
    {status === 'unavailable' && <div className="map-message" role="alert">このブラウザでは地図を表示できません。WebGLを有効にして開き直してください。</div>}
    {status === 'tile' && <div className="map-message" role="status">背景地図の一部を読み込めませんでした。</div>}
  </>;
}
