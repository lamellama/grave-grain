/**
 * game/breaching.ts — Zombies gnaw through structures (GDD §7.4). DOM-free, pure.
 *
 * A zombie blocked by a structure cell with INTEGRITY doesn't just stop — it
 * attacks the cell in front of it: each tick it has a chance to chip 1 point of
 * that cell's integrity; at integrity 0 the cell is destroyed (→ AIR) and the
 * body can push in next step. Crowd PRESSURE scales the chip rate: the more
 * zombies pressing the SAME cell, the faster it falls (GDD §7.4 "pressure scales
 * with numbers"). Material matters falls out for free — WOOD has low integrity
 * (baseIntegrity 60), FOLIAGE lower (10), and raw STONE has NO integrity yet
 * (hasIntegrity=false until Phase 8 gives walls integrity) so it is skipped.
 * Fire burning wood is handled by the fire sim, not here.
 *
 * This is a per-tick PASS over the zombie list, NOT a world scan (GDD §13):
 *   1. Each actively-advancing attacker finds the structure cell it presses.
 *   2. Attackers are grouped by that cell (a Map keyed by idx(x,y)).
 *   3. Per cell, one chip roll whose probability rises monotonically with the
 *      attacker count `n`; on success the cell loses 1 integrity, and at 0 it is
 *      destroyed + markTerrainEdit'd so navgrid/paths update.
 *
 * No combat, no new materials, no stone-wall special-case here (MVP scope).
 */

import type { Body } from '../characters/body';
import type { Zombie } from '../characters/zombie';
import { get, set, getIntegrity, setIntegrity, idx } from '../engine/grid';
import { MATERIALS, AIR, isSolidForBody } from '../engine/materials';
import { markTerrainEdit } from '../engine/navgrid';
import { BREACH_CHANCE, BREACH_PRESSURE_MULT } from '../config';

/**
 * The structure cell a body pressing in direction `dir` (-1 left / +1 right) is
 * blocked by, or null if nothing chippable is directly ahead (GDD §7.4 "the cell
 * in front of it").
 *
 * The body only ever occupies whole cells; its LEADING-EDGE column in `dir` is
 * the extreme live-pixel column (derived from the rig so it survives limb loss),
 * and the cell it presses sits ONE column beyond that edge — exactly where a
 * blocked body stops. (We derive the edge from the live rig rather than a fixed
 * BODY_W/2 half-width because the authored figure is asymmetric and may have
 * shed pixels, so a fixed offset would mis-aim by a cell.) We scan that column
 * over the body's full vertical pixel span (top→bottom) and return the FIRST
 * cell that is solid-to-a-body AND has integrity AND has integrity > 0 — i.e. a
 * breachable structure. A blocking cell with no integrity (raw STONE) is not
 * chippable and is skipped.
 */
export function findBlockingStructureCell(
  body: Body,
  dir: -1 | 1,
): { x: number; y: number } | null {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);

  // Leading-edge column + vertical span across the live (non-destroyed) rig.
  let edge: number | null = null;
  let top = Infinity;
  let bottom = -Infinity;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      if (edge === null || (dir > 0 ? wx > edge : wx < edge)) edge = wx;
      if (wy < top) top = wy;
      if (wy > bottom) bottom = wy;
    }
  }
  if (edge === null) return null; // fully dissolved rig — nothing presses

  const x = edge + dir; // the cell directly ahead of the leading edge
  for (let y = top; y <= bottom; y++) {
    const m = get(x, y);
    if (
      isSolidForBody(m) &&
      MATERIALS[m]?.hasIntegrity &&
      getIntegrity(x, y) > 0
    ) {
      return { x, y };
    }
  }
  return null;
}

/**
 * Per-tick breaching pass (GDD §7.4). Call once per tick AFTER zombies have been
 * updated (so moveDir/facing reflect this tick's intent). Bounded by the zombie
 * list: iterate, group pressers by pressed cell, roll once per cell.
 */
export function resolveBreaching(zombies: Zombie[]): void {
  // Group attackers by the structure cell they press: idx → {x, y, count}.
  const pressed = new Map<number, { x: number; y: number; n: number }>();

  for (const z of zombies) {
    if (!z.body.alive) continue;
    if (z.state !== 'attack') continue; // only an attacking zombie gnaws

    // The direction it WANTS to advance: its move intent this tick, or — if the
    // speed-gate zeroed moveDir this tick — its facing (its pursuit direction).
    const dir: -1 | 1 = z.body.moveDir !== 0 ? z.body.moveDir : z.body.facing;

    const cell = findBlockingStructureCell(z.body, dir);
    if (!cell) continue;

    const key = idx(cell.x, cell.y);
    const e = pressed.get(key);
    if (e) e.n++;
    else pressed.set(key, { x: cell.x, y: cell.y, n: 1 });
  }

  // One chip roll per pressed cell; probability rises monotonically with n.
  for (const { x, y, n } of pressed.values()) {
    // p = 1 - (1 - BREACH_CHANCE)^(1 + BREACH_PRESSURE_MULT*(n-1))
    // n=1 → BREACH_CHANCE; more attackers → higher p (compounded contact).
    const exponent = 1 + BREACH_PRESSURE_MULT * (n - 1);
    const p = 1 - Math.pow(1 - BREACH_CHANCE, exponent);

    if (Math.random() < p) {
      const next = getIntegrity(x, y) - 1;
      setIntegrity(x, y, next);
      if (next <= 0) {
        set(x, y, AIR); // GDD §7.4: integrity 0 → cell destroyed, body pushes in
        markTerrainEdit(x, y); // navgrid/paths update around the new gap
      }
    }
  }
}
