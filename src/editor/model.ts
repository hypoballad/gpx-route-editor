import type { Point } from '../geo.ts';
import type { RouteInput } from '../routing/protocol.ts';

export type Vertex = { id: string; point: Point };
export type Waypoint = Vertex & { roadId?: string; name?: string };
export type Leg = {
  id: string;
  from: string;
  to: string;
  mode: 'auto' | 'manual';
  vertices: Vertex[];
  fromChoice?: string | null;
  toChoice?: string | null;
};
export type Project = { waypoints: Waypoint[]; legs: Leg[] };
export const emptyProject: Project = { waypoints: [], legs: [] };
export type History = { past: Project[]; present: Project; future: Project[] };

export function edit(history: History, project: Project): History {
  if (history.present === project) return history;
  return { past: [...history.past.slice(-99), history.present], present: project, future: [] };
}

export function undo(history: History): History {
  const previous = history.past.at(-1);
  return previous ? {
    past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future],
  } : history;
}

export function redo(history: History): History {
  const next = history.future[0];
  return next ? {
    past: [...history.past, history.present], present: next, future: history.future.slice(1),
  } : history;
}

function legId(from: string, to: string) {
  return `${from}/${to}`;
}

export function setWaypoints(project: Project, waypoints: Waypoint[]): Project {
  const previous = new Map(project.legs.map((leg) => [leg.id, leg]));
  const legs = waypoints.slice(1).map(({ id: to }, index) => {
    const from = waypoints[index].id;
    const id = legId(from, to);
    return previous.get(id) ?? { id, from, to, mode: 'auto' as const, vertices: [] };
  });
  return { waypoints, legs };
}

export function insertWaypoint(project: Project, index: number, waypoint: Waypoint, splitAt = 0): Project {
  const old = project.legs[index - 1];
  const insert = setWaypoints(project, [
    ...project.waypoints.slice(0, index), waypoint, ...project.waypoints.slice(index),
  ]);
  if (old?.mode !== 'manual') return insert;
  return {
    ...insert,
    legs: insert.legs.map((leg, legIndex) => {
      if (legIndex === index - 1) return { ...leg, mode: 'manual', vertices: old.vertices.slice(0, splitAt) };
      if (legIndex === index) return { ...leg, mode: 'manual', vertices: old.vertices.slice(splitAt) };
      return leg;
    }),
  };
}

export function moveWaypoint(project: Project, id: string, point: Point, roadId?: string): Project {
  return {
    waypoints: project.waypoints.map((waypoint) => waypoint.id === id ? { ...waypoint, point, roadId } : waypoint),
    legs: project.legs.map((leg) => {
      if (leg.from === id) return { ...leg, fromChoice: undefined };
      if (leg.to === id) return { ...leg, toChoice: undefined };
      return leg;
    }),
  };
}

export function updateLeg(project: Project, id: string, update: (leg: Leg) => Leg): Project {
  return { ...project, legs: project.legs.map((leg) => leg.id === id ? update(leg) : leg) };
}

export function legInput(project: Project, index: number): RouteInput {
  const { fromChoice, toChoice } = project.legs[index];
  const from = project.waypoints[index];
  const to = project.waypoints[index + 1];
  return {
    from: from.point, to: to.point,
    fromChoice: fromChoice === undefined ? from.roadId : fromChoice ?? undefined,
    toChoice: toChoice === undefined ? to.roadId : toChoice ?? undefined,
  };
}

export function manualLine(project: Project, index: number): Point[] {
  const input = legInput(project, index);
  return [input.from, ...project.legs[index].vertices.map(({ point }) => point), input.to];
}
