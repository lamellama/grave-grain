/**
 * game/projectiles.ts - Guard arrows: visible, arcing, region-wounding shafts.
 *
 * GDD 7.2: an armed guard no longer trades hand-to-hand blows - it looses an
 * ARROW that flies a gravity ARC and, on impact, wounds whatever body region it
 * strikes. Damage stays fully emergent: the arrow does NOT carry an HP number;
 * it picks the bone under its impact cell and routes the wound through THE GATE
 * (applyDamage) - the exact same release-pixels-into-the-sim handoff melee used,
 * so head->dissolve, leg->crawl, arm->lose-reach, torso->bleed all fall out for
 * free (characters/damage.ts). This module owns ONLY the flight + collision; it
 * never drives a body.
 *
 * DETERMINISM (GDD 13): the arc integrator uses no RNG and lives in the BODY/AI
 * layer (updated from the game loop, NOT simulation.step()), so it can never
 * perturb the chunked CA's byte-equivalence.
 *
 * DOM-free pure logic (bar the registerHit juice call, itself DOM-free) so it
 * stays headless-testable.
 */

import {
  ARROW_FLIGHT_TICKS,
  ARROW_GRAVITY,
  ARROW_HIT_RADIUS,
  ARROW_MAX_TICKS,
  MAX_ARROWS,
} from '../config';
import { get, inBounds } from '../engine/grid';
import { isSolidForBody } from '../engine/materials';
import { applyDamage } from '../characters/damage';
import { pickBoneNear } from '../characters/pick';
import type { Body } from '../characters/body';
import type { Zombie } from '../characters/zombie';
import { registerHit } from './ui';

/**
 * One in-flight arrow. Position/velocity are in WORLD CELLS (float) and
 * cells/tick; (prevX, prevY) is last tick's position so the renderer can draw
 * the shaft as a short streak along its travel and updateArrows can sweep the
 * segment for collisions (no tunnelling through a thin body/wall).
 */
export interface Arrow {
  x: number;
  y: number;
  vx: number;
  vy: number;
  prevX: number;
  prevY: number;
  alive: boolean;
  age: number; // ticks in flight (retired past ARROW_MAX_TICKS)
}

// The live arrow pool. A single module-global list mirrors how the renderer and
// game loop already share the zombies array by reference (GDD 13 data-oriented).
const arrows: Arrow[] = [];

/** The live arrow list (renderer + tests read this by reference). */
export function getArrows(): Arrow[] {
  return arrows;
}

/** Drop every arrow (called on world (re)init so none leak across a restart). */
export function resetArrows(): void {
  arrows.length = 0;
}

/**
 * Launch an arrow from (sx, sy) so it ARCS to (tx, ty) over ARROW_FLIGHT_TICKS
 * under ARROW_GRAVITY. The launch velocity is solved to match the semi-implicit
 * Euler integrator updateArrows uses, so an unobstructed arrow lands exactly on
 * the aim cell at tick T:
 *
 *   x_T = sx + T*vx                        -> vx  = (tx - sx) / T
 *   y_T = sy + T*vy0 + g*T*(T+1)/2         -> vy0 = (ty - sy - g*T*(T+1)/2) / T
 *
 * vy0 comes out NEGATIVE (upward) for a level/near shot, so the shaft lofts up
 * then falls back down - the visible arc. Oldest arrow is evicted once the pool
 * is full so the list is hard-bounded (GDD 13 perf).
 */
export function launchArrow(sx: number, sy: number, tx: number, ty: number): void {
  const T = ARROW_FLIGHT_TICKS;
  const g = ARROW_GRAVITY;
  const vx = (tx - sx) / T;
  const vy = (ty - sy - (g * T * (T + 1)) / 2) / T;

  if (arrows.length >= MAX_ARROWS) {
    arrows.shift(); // evict oldest - O(n), n <= MAX_ARROWS, negligible
  }
  arrows.push({ x: sx, y: sy, vx, vy, prevX: sx, prevY: sy, alive: true, age: 0 });
}

/**
 * Which non-destroyed bone of any ALIVE zombie sits at world cell (cx, cy)?
 * Broad-phase by anchor bounding box (cheap integer compares) before the precise
 * pixel scan, so a distant zombie costs almost nothing. Returns the first match
 * in list order (arrows are point strikes; overlap is effectively unique).
 */
function zombieRegionAt(
  cx: number,
  cy: number,
  zombies: Zombie[],
): { body: Body; region: ReturnType<typeof pickBoneNear> } | null {
  for (const z of zombies) {
    const b = z.body;
    if (!b.alive) continue;
    const bx = Math.round(b.x);
    const by = Math.round(b.y);
    // Bounding box around the authored figure (BODY_W wide, BODY_H tall above
    // the feet anchor) with a 1-cell margin for the pick radius. Skip the pixel
    // scan entirely when the cell is nowhere near this body.
    if (cx < bx - 5 || cx > bx + 5) continue;
    if (cy < by - 13 || cy > by + 1) continue;
    const region = pickBoneNear(b, cx, cy, ARROW_HIT_RADIUS);
    if (region) return { body: b, region };
  }
  return null;
}

/**
 * Advance every live arrow one tick and resolve collisions (call once per sim
 * tick from the game loop, AFTER survivors have fired this tick's shots). For
 * each arrow:
 *   1. apply gravity to vy, then sweep from the old position to the new one in
 *      integer sub-steps (so a fast shaft cannot tunnel through a body/wall);
 *   2. at each swept cell: out-of-bounds or body-solid terrain -> the arrow
 *      embeds and dies; a zombie body region -> wound that region through THE
 *      GATE (applyDamage) and die;
 *   3. otherwise it flies on, retiring after ARROW_MAX_TICKS.
 * Only ZOMBIES are tested for body hits - a guard's arrow never wounds the
 * colony (no friendly fire). Dead arrows are pruned in place afterwards.
 */
export function updateArrows(zombies: Zombie[]): void {
  for (const a of arrows) {
    if (!a.alive) continue;

    a.prevX = a.x;
    a.prevY = a.y;
    a.vy += ARROW_GRAVITY;

    // Sweep the segment this tick in integer sub-steps sized to the faster axis
    // so we never skip a cell the shaft passes through.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(a.vx), Math.abs(a.vy))));
    const sx = a.vx / steps;
    const sy = a.vy / steps;
    let lastCx = Math.round(a.x);
    let lastCy = Math.round(a.y);

    let struck = false;
    for (let i = 0; i < steps; i++) {
      a.x += sx;
      a.y += sy;
      const cx = Math.round(a.x);
      const cy = Math.round(a.y);
      // Only test a cell once as we cross into it.
      if (cx === lastCx && cy === lastCy) continue;
      lastCx = cx;
      lastCy = cy;

      // Left the world, or buried into terrain a body could not pass -> stop.
      if (!inBounds(cx, cy) || isSolidForBody(get(cx, cy))) {
        a.alive = false;
        struck = true;
        break;
      }

      // Hit a zombie's body region -> emergent wound through THE GATE.
      const hit = zombieRegionAt(cx, cy, zombies);
      if (hit && hit.region) {
        applyDamage(hit.body, hit.region);
        registerHit(cx, cy);
        a.alive = false;
        struck = true;
        break;
      }
    }
    if (struck) continue;

    a.age++;
    if (a.age >= ARROW_MAX_TICKS) a.alive = false;
  }

  // Prune retired arrows in place (the renderer holds this same reference).
  for (let i = arrows.length - 1; i >= 0; i--) {
    if (!arrows[i].alive) arrows.splice(i, 1);
  }
}
