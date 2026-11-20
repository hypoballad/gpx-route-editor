import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bounds } from '../geo.ts';
import type { RoadResult, RouteResult, RoutingRequest, RoutingResponse } from '../routing/protocol.ts';
import { legInput } from './model.ts';
import type { Project } from './model.ts';
import { attachTransfers, referenceRoadId } from '../routing/referenceNetwork.ts';
import type { ReferenceNetwork } from '../routing/referenceNetwork.ts';

const loadError: RouteResult = { error: 'load', fromOptions: [], toOptions: [] };
type Query = { type: 'route'; input: Extract<RoutingRequest, { type: 'route' }>['input'] }
  | { type: 'roads'; bounds: Bounds };

export function useRoutes(project: Project, reference: ReferenceNetwork, viewport?: Bounds) {
  const [results, setResults] = useState(() => new Map<string, RouteResult>());
  const [roadResult, setRoadResult] = useState<{ bounds: Bounds; result: RoadResult }>();
  const worker = useRef<Worker | undefined>(undefined);
  const pending = useRef(new Map<number, (response?: RoutingResponse) => void>());
  const pendingRoutes = useRef(new Set<string>());
  const nextId = useRef(0);
  const requests = useMemo(() => project.legs.map((leg, index) => {
    if (leg.mode !== 'auto') return undefined;
    const selected = legInput(project, index);
    const policy = {
      fromTransfer: project.waypoints[index].transfer, toTransfer: project.waypoints[index + 1].transfer,
      fromOsm: !!leg.fromChoice && !referenceRoadId(leg.fromChoice),
      toOsm: !!leg.toChoice && !referenceRoadId(leg.toChoice),
    };
    const course = reference.route(selected, policy);
    const input = {
      ...selected,
      fromChoice: referenceRoadId(selected.fromChoice) ? undefined : selected.fromChoice,
      toChoice: referenceRoadId(selected.toChoice) ? undefined : selected.toChoice,
    };
    return { input, policy, course, key: JSON.stringify([leg.id, input]) };
  }), [project, reference]);

  useEffect(() => () => {
    worker.current?.terminate();
    worker.current = undefined;
    pending.current.clear();
    pendingRoutes.current.clear();
  }, []);

  const send = useCallback((query: Query, complete: (response?: RoutingResponse) => void) => {
    const fail = () => {
      const failures = [...pending.current.values()];
      pending.current.clear();
      worker.current?.terminate();
      worker.current = undefined;
      for (const callback of failures) callback();
    };
    const id = ++nextId.current;
    pending.current.set(id, complete);
    try {
      if (!worker.current) {
        worker.current = new Worker(new URL('../routing/worker.ts', import.meta.url), { type: 'module' });
        worker.current.onmessage = ({ data }: MessageEvent<RoutingResponse>) => {
          const callback = pending.current.get(data.id);
          pending.current.delete(data.id);
          callback?.(data);
        };
        worker.current.onerror = fail;
      }
      const manifestUrl = new URL(__GRAPH_MANIFEST_PATH__, document.baseURI).href;
      worker.current.postMessage({ ...query, id, manifestUrl } satisfies RoutingRequest);
    } catch {
      fail();
    }
    return () => { pending.current.delete(id); };
  }, []);

  useEffect(() => {
    for (const request of requests) {
      if (!request || request.course || results.has(request.key) || pendingRoutes.current.has(request.key)) continue;
      pendingRoutes.current.add(request.key);
      send({ type: 'route', input: request.input }, (response) => {
        pendingRoutes.current.delete(request.key);
        const result = response?.type === 'route' ? response.result : loadError;
        setResults((previous) => new Map(previous).set(request.key, result));
      });
    }
  }, [requests, results, send]);

  useEffect(() => {
    if (!viewport) return;
    return send({ type: 'roads', bounds: viewport }, (response) => {
      const result: RoadResult = response?.type === 'roads' ? response.result : { roads: [], error: 'load' };
      setRoadResult({ bounds: viewport, result });
    });
  }, [viewport, send]);

  const retry = useCallback(() => {
    setResults((previous) => new Map([...previous].filter(([, result]) => result.error !== 'load')));
  }, []);
  const resolvedRoutes = useMemo(() => requests.map((request) => {
    if (!request) return undefined;
    const result = request.course ?? results.get(request.key);
    return result && attachTransfers(result, request.input, request.policy);
  }), [requests, results]);
  const cachedBounds = roadResult?.bounds;
  const overlaps = viewport && cachedBounds && viewport.west < cachedBounds.east && viewport.east > cachedBounds.west
    && viewport.south < cachedBounds.north && viewport.north > cachedBounds.south;
  return {
    results: resolvedRoutes, retry,
    roadResult: viewport && roadResult && (cachedBounds === viewport || (overlaps && roadResult.result.roads.length))
      ? roadResult.result : undefined,
  };
}
