/**
 * game/pathfinding.ts — A* router over the coarse navgrid (GDD §13).
 *
 * The navgrid (engine/navgrid.ts) gives, per coarse cell, whether a body can
 * stand there and at what surface height. This router walks that graph with A*
 * to return world-cell waypoints for a rigged body to steer along (bodies path
 * as POINTS — far cheaper than soft bodies, GDD §5.1/§13). Local steering and
 * the actual walk are Phase-3 locomotion's job; we only produce the route.
 *
 * **Edges** connect horizontally-adjacent walkable coarse cells whose surface
 * heights are traversable by Phase-3 locomotion: a climb of ≤ STEP_UP_MAX cells
 * up, or ANY drop down (a body walks off a ledge and falls — locomotion has no
 * fall-height limit, only a no-tunnel sweep). Cost = world distance travelled
 * plus a small step/drop penalty so the router prefers flatter routes.
 *
 * **Local-only staleness** (the §13 key requirement): a Path records the epoch
 * of every coarse cell it crosses AND those cells' neighbours. isPathStale is
 * true iff an edit bumped one of those epochs — i.e. an edit happened ON or
 * ADJACENT to the path. Edits anywhere else touch different coarse cells and
 * never flag the path stale.
 *
 * DOM-free; uses flat typed arrays for the search (GDD §13, AGENTS §4).
 */

import { NAV_CELL, STEP_UP_MAX } from '../config';
import {
  NAV_W,
  NAV_H,
  coarseOf,
  isWalkable,
  surfaceY,
  epochAt,
} from '../engine/navgrid';

/** A waypoint in WORLD cell coordinates (feet target, one above the floor). */
export interface Waypoint {
  x: number;
  y: number;
}

/**
 * A planned route plus the epoch fingerprint used for local staleness checks.
 * `coarseEpochs` holds the epoch (at plan time) of every coarse cell the path
 * crosses and each of their 8-neighbours, so an edit on or beside the path is
 * detectable without scanning the whole grid (GDD §13).
 */
export interface Path {
  waypoints: Waypoint[];
  coarseEpochs: Array<{ cx: number; cy: number; epoch: number }>;
}

/** Step/drop penalty (world-cell units) added per unit of surface-height change. */
const HEIGHT_PENALTY = 0.5;

/** Centre world-x of a coarse column (where we place that cell's waypoint). */
function columnCenterX(cx: number): number {
  return cx * NAV_CELL + Math.floor(NAV_CELL / 2);
}

/**
 * Is moving from a cell with floor row `sa` to an adjacent cell with floor row
 * `sb` traversable by Phase-3 locomotion? Climb ≤ STEP_UP_MAX up; any drop down.
 * (`sa - sb` > 0 means the destination floor is HIGHER → a climb.)
 */
function traversable(sa: number, sb: number): boolean {
  return sa - sb <= STEP_UP_MAX;
}

/**
 * Pick the best start/goal node in a coarse column: the walkable coarse cell
 * whose surface is vertically closest to the query world-y. This makes the API
 * forgiving (the caller passes a body/target world position, not a coarse id).
 * Returns the coarse-cell linear id, or -1 if the whole column is unwalkable.
 */
function nodeInColumn(cx: number, queryY: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let cy = 0; cy < NAV_H; cy++) {
    if (!isWalkable(cx, cy)) continue;
    const d = Math.abs(surfaceY(cx, cy) - queryY);
    if (d < bestDist) {
      bestDist = d;
      best = cy * NAV_W + cx;
    }
  }
  return best;
}

// --- Minimal binary min-heap over coarse-cell ids, keyed by an fScore array ---
class MinHeap {
  private heap: number[] = [];
  constructor(private readonly f: Float64Array) {}
  get size(): number {
    return this.heap.length;
  }
  push(id: number): void {
    const h = this.heap;
    h.push(id);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[h[p]] <= this.f[h[i]]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): number {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < h.length && this.f[h[l]] < this.f[h[s]]) s = l;
        if (r < h.length && this.f[h[r]] < this.f[h[s]]) s = r;
        if (s === i) break;
        [h[s], h[i]] = [h[i], h[s]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * A* over walkable coarse cells. Returns ordered world waypoints (one per coarse
 * cell on the route, at its surface), or null if the goal is unreachable.
 *
 * Heuristic = Manhattan world distance between cell surfaces (admissible: it
 * never exceeds the true cost, which adds non-negative height penalties), so the
 * search is optimal for the chosen cost model.
 */
export function findPath(
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
): Path | null {
  const sCoarse = coarseOf(startX, startY);
  const gCoarse = coarseOf(goalX, goalY);
  const start = nodeInColumn(sCoarse.cx, startY);
  const goal = nodeInColumn(gCoarse.cx, goalY);
  if (start === -1 || goal === -1) return null;

  const gx = goal % NAV_W;
  const gSurf = surfaceY(gx, Math.floor(goal / NAV_W));

  const N = NAV_W * NAV_H;
  const gScore = new Float64Array(N).fill(Infinity);
  const fScore = new Float64Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);

  const heuristic = (cx: number, cy: number): number =>
    Math.abs(cx - gx) * NAV_CELL + Math.abs(surfaceY(cx, cy) - gSurf);

  const open = new MinHeap(fScore);
  gScore[start] = 0;
  fScore[start] = heuristic(start % NAV_W, Math.floor(start / NAV_W));
  open.push(start);

  let found = false;
  while (open.size > 0) {
    const current = open.pop();
    if (current === goal) {
      found = true;
      break;
    }
    if (closed[current]) continue;
    closed[current] = 1;

    const cx = current % NAV_W;
    const cy = Math.floor(current / NAV_W);
    const sa = surfaceY(cx, cy);

    // Neighbours: horizontally-adjacent columns. A coarse column can hold more
    // than one walkable cell (ground + a platform above), so scan the column and
    // keep every cell reachable by a ≤STEP_UP_MAX climb or any drop.
    for (let dir = -1; dir <= 1; dir += 2) {
      const ncx = cx + dir;
      if (ncx < 0 || ncx >= NAV_W) continue;
      for (let ncy = 0; ncy < NAV_H; ncy++) {
        if (!isWalkable(ncx, ncy)) continue;
        const sb = surfaceY(ncx, ncy);
        if (!traversable(sa, sb)) continue;
        const nId = ncy * NAV_W + ncx;
        if (closed[nId]) continue;
        // Cost: one coarse step across (NAV_CELL world cells) + height change
        // + a small penalty so flat routes win ties over needless climbs/drops.
        const dh = Math.abs(sa - sb);
        const tentative = gScore[current] + NAV_CELL + dh + dh * HEIGHT_PENALTY;
        if (tentative < gScore[nId]) {
          cameFrom[nId] = current;
          gScore[nId] = tentative;
          fScore[nId] = tentative + heuristic(ncx, ncy);
          open.push(nId);
        }
      }
    }
  }

  if (!found) return null;

  // Reconstruct the coarse-cell route start→goal.
  const route: number[] = [];
  for (let n = goal; n !== -1; n = cameFrom[n]) route.push(n);
  route.reverse();

  // World waypoints: one per coarse cell, at the column centre, feet resting one
  // cell above the floor (surface row). Locomotion steers between these.
  const waypoints: Waypoint[] = route.map((id) => {
    const cx = id % NAV_W;
    const cy = Math.floor(id / NAV_W);
    return { x: columnCenterX(cx), y: surfaceY(cx, cy) - 1 };
  });

  // Epoch fingerprint: every route cell plus its 8-neighbours (GDD §13 local
  // staleness). De-duplicated so isPathStale is a cheap linear compare.
  const seen = new Set<number>();
  const coarseEpochs: Array<{ cx: number; cy: number; epoch: number }> = [];
  for (const id of route) {
    const cx = id % NAV_W;
    const cy = Math.floor(id / NAV_W);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= NAV_W || ny < 0 || ny >= NAV_H) continue;
        const key = ny * NAV_W + nx;
        if (seen.has(key)) continue;
        seen.add(key);
        coarseEpochs.push({ cx: nx, cy: ny, epoch: epochAt(nx, ny) });
      }
    }
  }

  return { waypoints, coarseEpochs };
}

/**
 * Is the path stale? True ONLY if a terrain edit has bumped the epoch of a coarse
 * cell on or adjacent to the path since it was planned (GDD §13 local-only
 * invalidation). Edits elsewhere bump other cells' epochs and are ignored.
 */
export function isPathStale(path: Path): boolean {
  for (const e of path.coarseEpochs) {
    if (epochAt(e.cx, e.cy) !== e.epoch) return true;
  }
  return false;
}
