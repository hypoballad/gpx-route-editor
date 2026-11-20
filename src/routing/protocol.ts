import type { Bounds, Point } from '../geo.ts';

export type Manifest = {
  format: number;
  file: string;
  sha256: string;
  bytes: number;
  nodes: number;
  edges: number;
  weights: number[];
  coverage: Bounds;
  graphBounds: Bounds;
  timestamp: string;
};

export type Candidate = { id: string; point: Point; meters: number; shorterRoute?: boolean };
export type RouteInput = { from: Point; to: Point; fromChoice?: string; toChoice?: string };
export type RouteResult = {
  points?: Point[];
  error?: 'outside' | 'snap' | 'disconnected' | 'no-path' | 'load';
  fromOptions: Candidate[];
  toOptions: Candidate[];
  fromSnap?: Candidate;
  toSnap?: Candidate;
  graphVersion?: string;
};
export type Road = { id: string; points: [Point, Point] };
export type RoadResult = { roads: Road[]; limited?: boolean; error?: 'load' };
export type RoutingRequest = { id: number; manifestUrl: string } & (
  | { type: 'route'; input: RouteInput }
  | { type: 'roads'; bounds: Bounds }
);
export type RoutingResponse = { id: number } & (
  | { type: 'route'; result: RouteResult }
  | { type: 'roads'; result: RoadResult }
);
