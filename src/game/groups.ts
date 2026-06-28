/**
 * game/groups.ts - Survivor grouping by sight (VS-3, GDD 6.2/7.1/13).
 *
 * Survivors partition into GROUPS by mutual visibility: two survivors share an
 * edge when they are within SIGHT_RADIUS AND have line-of-sight (no solid wall
 * between). A GROUP is a connected component of that visibility graph - so three
 * survivors A-B-C in a line all share one group even if A cannot see C directly.
 *
 * HYSTERESIS (the core of the ask): each pairwise edge is DEBOUNCED, not the raw
 * visibility. A newly-visible pair only turns its edge ON after MERGE_DEBOUNCE_
 * TICKS of continuous sight; a newly-blocked pair only turns OFF after SPLIT_
 * DEBOUNCE_TICKS. Groups are then the connected components of the DEBOUNCED-edge
 * graph. This makes "over the hill, out of sight" fork survivors (the connecting
 * edges go dark, the component splits) and "back into sight" rejoin them - while
 * a brief dip behind terrain never flickers the grouping.
 *
 * Clustering recomputes on an INTERVAL (GROUP_RECHECK_TICKS), never every tick
 * (GDD 13). Debounce is measured in real ticks, so it is independent of the
 * recompute cadence. Edges are keyed by SURVIVOR INDEX (stable for the run), so
 * there is no fragile dynamic-group-id bookkeeping; a group's canonical id is
 * just the smallest member index in its component.
 *
 * Module-level state + reset(), mirroring resources.ts / buildqueue.ts.
 */

import type { Survivor } from '../characters/survivor';
import { get, inBounds } from '../engine/grid';
import { isSolidForBody } from '../engine/materials';
import {
  SIGHT_RADIUS,
  GROUP_RECHECK_TICKS,
  SPLIT_DEBOUNCE_TICKS,
  MERGE_DEBOUNCE_TICKS,
} from '../config';

// Canonical group id per survivor index (-1 = no group: dead/turned/absent).
let groupId: number[] = [];
let lastRecheck = -1;

// Debounced pairwise edge state, keyed "i|j" (i < j), survivor indices.
//   edgeOn   : the DEBOUNCED edge (drives grouping).
//   rawPrev  : last observed raw visibility (to detect a change).
//   rawSince : tick the current raw value began (for the debounce elapsed test).
const edgeOn = new Map<string, boolean>();
const rawPrev = new Map<string, boolean>();
const rawSince = new Map<string, number>();

/** Reset all grouping state (new-game init / test harness). */
export function resetGroups(): void {
  groupId = [];
  lastRecheck = -1;
  edgeOn.clear();
  rawPrev.clear();
  rawSince.clear();
}

/** Canonical group id of survivor index i (-1 if dead/turned/out of range). */
export function groupIdOf(i: number): number {
  return i >= 0 && i < groupId.length ? groupId[i] : -1;
}

/** Number of distinct active groups. */
export function groupCount(): number {
  const s = new Set<number>();
  for (const g of groupId) if (g >= 0) s.add(g);
  return s.size;
}

/** Distinct active group ids, ascending. */
export function groupIds(): number[] {
  const s = new Set<number>();
  for (const g of groupId) if (g >= 0) s.add(g);
  return Array.from(s).sort((a, b) => a - b);
}

/** Survivor indices in group g, in index order. */
export function groupMembers(g: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < groupId.length; i++) if (groupId[i] === g) out.push(i);
  return out;
}

function isActive(s: Survivor): boolean {
  return s.body.alive && !s.turned;
}

function key(i: number, j: number): string {
  return i < j ? i + '|' + j : j + '|' + i;
}

/**
 * Grid line-of-sight between two cells: false when any cell STRICTLY BETWEEN the
 * endpoints is solid to a body (a wall blocks sight). Endpoints excluded so a
 * survivor adjacent to a wall is not trivially blind. DDA sampling over the
 * longer axis - cheap, deterministic, and good enough for a sight check.
 */
export function lineOfSight(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return true;
  for (let k = 1; k < steps; k++) {
    const x = Math.round(x0 + (dx * k) / steps);
    const y = Math.round(y0 + (dy * k) / steps);
    if (inBounds(x, y) && isSolidForBody(get(x, y))) return false;
  }
  return true;
}

/** Raw (instantaneous) mutual visibility of survivors i and j. */
function visible(survivors: Survivor[], i: number, j: number): boolean {
  const a = survivors[i].body;
  const b = survivors[j].body;
  const ddx = a.x - b.x;
  const ddy = a.y - b.y;
  if (ddx * ddx + ddy * ddy > SIGHT_RADIUS * SIGHT_RADIUS) return false;
  return lineOfSight(
    Math.round(a.x),
    Math.round(a.y),
    Math.round(b.x),
    Math.round(b.y),
  );
}

/**
 * Recompute groups for the colony. Call EVERY tick from main; the interval gate
 * inside means the actual clustering only runs every GROUP_RECHECK_TICKS. `tick`
 * is the global sim tick (drives the debounce elapsed test).
 */
export function updateGroups(survivors: Survivor[], tick: number): void {
  if (lastRecheck >= 0 && tick - lastRecheck < GROUP_RECHECK_TICKS) return;
  lastRecheck = tick;
  recompute(survivors, tick);
}

function recompute(survivors: Survivor[], tick: number): void {
  const n = survivors.length;
  if (groupId.length !== n) groupId.length = n;

  const active: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isActive(survivors[i])) active.push(i);
    else groupId[i] = -1;
  }

  // 1. Update each active pair's DEBOUNCED edge from its raw visibility.
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const i = active[a];
      const j = active[b];
      const k = key(i, j);
      const raw = visible(survivors, i, j);
      if (rawPrev.get(k) !== raw) {
        rawPrev.set(k, raw);
        rawSince.set(k, tick);
      }
      const elapsed = tick - (rawSince.get(k) ?? tick);
      let on = edgeOn.get(k);
      if (on === undefined) {
        on = raw; // first observation: adopt immediately (no debounce on init)
      } else if (raw && !on && elapsed >= MERGE_DEBOUNCE_TICKS) {
        on = true; // sustained sight -> merge
      } else if (!raw && on && elapsed >= SPLIT_DEBOUNCE_TICKS) {
        on = false; // sustained blindness -> split
      }
      edgeOn.set(k, on);
    }
  }

  // 2. Connected components of the DEBOUNCED-edge graph (union-find), canonical
  //    id = the smallest member index. Lower root wins so ids are deterministic.
  const parent = new Map<number, number>();
  for (const i of active) parent.set(i, i);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    let c = x;
    while (parent.get(c) !== r) {
      const nx = parent.get(c) as number;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const i = active[a];
      const j = active[b];
      if (edgeOn.get(key(i, j)) === true) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent.set(Math.max(ri, rj), Math.min(ri, rj));
      }
    }
  }
  for (const i of active) groupId[i] = find(i);
}
