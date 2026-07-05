/**
 * game/breaching.ts - Zombies gnaw through structures (GDD 7.4). DOM-free, pure.
 *
 * A zombie blocked by a structure cell with INTEGRITY doesn't just stop - it
 * attacks the cell in front of it: each tick it has a chance to chip 1 point of
 * that cell's integrity; at integrity 0 the cell is destroyed (-> AIR) and the
 * body can push in next step. Crowd PRESSURE scales the chip rate: the more
 * zombies pressing the SAME cell, the faster it falls (GDD 7.4 "pressure scales
 * with numbers"). Material matters falls out for free - WOOD has low integrity
 * (baseIntegrity 60), FOLIAGE lower (10), and raw STONE has NO integrity yet
 * (hasIntegrity=false until Phase 8 gives walls integrity) so it is skipped.
 * Fire burning wood is handled by the fire sim, not here.
 *
 * This is a per-tick PASS over the zombie list, NOT a world scan (GDD 13):
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
import { MATERIALS, AIR, DOOR, isSolidForBody } from '../engine/materials';
import { markTerrainEdit } from '../engine/navgrid';
import { BREACH_CHANCE, BREACH_PRESSURE_MULT, CHIP_FLASH_TICKS } from '../config';

// ---------------------------------------------------------------------------
// Chip-flash registry (task 11-4, GDD 7.4 / 12).
// recentChips maps cell index -> the breach-tick at which a chip last landed.
// The renderer reads it to flash chipped cells; entries are pruned every tick
// once their age exceeds CHIP_FLASH_TICKS so the Map stays bounded.
// getBreachTick() is the monotone counter the renderer compares against.
// ---------------------------------------------------------------------------

let _breachTick = 0;

/** Monotone tick counter incremented once per resolveBreaching() call. */
export function getBreachTick(): number {
  return _breachTick;
}

/**
 * Map<cellIdx, tickStamp> of recently-chipped cells.
 * Exported read-write so the renderer and UI can read it; the test can seed it
 * directly. Pruned in resolveBreaching every tick (bounded, never grows large).
 */
export const recentChips = new Map<number, number>();

/**
 * The structure cell a body pressing in direction `dir` (-1 left / +1 right) is
 * blocked by, or null if nothing chippable is directly ahead (GDD 7.4 "the cell
 * in front of it").
 *
 * The body only ever occupies whole cells. We compute its leading-edge column
 * PER ROW (not one global edge for the whole rig): the authored figure is
 * ASYMMETRIC - an arm pixel overhangs one column further out than the torso/
 * legs, and may sit ABOVE a short structure. A single global edge (the extreme
 * pixel column across the WHOLE rig) would be that arm column and would probe
 * the air PAST a low fence, missing it entirely (the cell the body is actually
 * blocked by is at the torso/leg rows). So for EACH row `y` in the body's
 * vertical pixel span we find that row's leading-edge column (the rightmost live
 * pixel for dir>0 / leftmost for dir<0, derived from the live rig so it survives
 * limb loss), probe the cell ONE column beyond it `(rowEdge + dir, y)`, and
 * return the FIRST cell that is solid-to-a-body AND has integrity AND has
 * integrity > 0 - i.e. a breachable structure. A blocking cell with no integrity
 * (raw STONE) is not chippable and is skipped. We return null only if NO row has
 * a breachable cell directly ahead.
 */
export function findBlockingStructureCell(
  body: Body,
  dir: -1 | 1,
): { x: number; y: number } | null {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);

  // Per-row leading-edge column across the live (non-destroyed) rig: for each
  // world row the body occupies, the extreme live-pixel column in `dir`.
  const rowEdge = new Map<number, number>();
  let top = Infinity;
  let bottom = -Infinity;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      const cur = rowEdge.get(wy);
      if (cur === undefined || (dir > 0 ? wx > cur : wx < cur)) {
        rowEdge.set(wy, wx);
      }
      if (wy < top) top = wy;
      if (wy > bottom) bottom = wy;
    }
  }
  if (rowEdge.size === 0) return null; // fully dissolved rig - nothing presses

  // Probe each row's own leading edge; return the first breachable hit. This
  // finds the fence at the rows where the body is actually blocked (torso/legs)
  // and ignores an overhanging arm row that clears a short structure.
  for (let y = top; y <= bottom; y++) {
    const edge = rowEdge.get(y);
    if (edge === undefined) continue; // no live pixel on this row
    const x = edge + dir; // the cell directly ahead of this row's edge
    const m = get(x, y);
    // A DOOR is not solid-for-body in general (the living walk through), but
    // every presser HERE is a zombie, to whom it IS a wall (v0.10 R8) - so it
    // counts as a blocking, chippable structure like fence/wall.
    if (
      (isSolidForBody(m) || m === DOOR) &&
      MATERIALS[m]?.hasIntegrity &&
      getIntegrity(x, y) > 0
    ) {
      return { x, y };
    }
  }
  return null;
}

/**
 * Per-tick breaching pass (GDD 7.4). Call once per tick AFTER zombies have been
 * updated (so moveDir/facing reflect this tick's intent). Bounded by the zombie
 * list: iterate, group pressers by pressed cell, roll once per cell.
 */
export function resolveBreaching(zombies: Zombie[]): void {
  // Advance the breach-tick counter FIRST so the renderer always reads a
  // monotonically increasing value after each sim tick (task 11-4).
  _breachTick++;

  // Prune expired chip entries (age >= CHIP_FLASH_TICKS) to keep Map bounded.
  for (const [key, chipTick] of recentChips) {
    if (_breachTick - chipTick >= CHIP_FLASH_TICKS) {
      recentChips.delete(key);
    }
  }

  // Group attackers by the structure cell they press: idx -> {x, y, count}.
  const pressed = new Map<number, { x: number; y: number; n: number }>();

  for (const z of zombies) {
    if (!z.body.alive) continue;
    if (z.state !== 'attack') continue; // only an attacking zombie gnaws

    // The direction it WANTS to advance: its move intent this tick, or - if the
    // speed-gate zeroed moveDir this tick - its facing (its pursuit direction).
    const dir: -1 | 1 = z.body.moveDir !== 0 ? z.body.moveDir : z.body.facing;

    const cell = findBlockingStructureCell(z.body, dir);
    if (!cell) continue;

    const key = idx(cell.x, cell.y);
    const e = pressed.get(key);
    if (e) e.n++;
    else pressed.set(key, { x: cell.x, y: cell.y, n: 1 });
  }

  // One chip roll per pressed cell; probability rises monotonically with n.
  for (const [cellKey, { x, y, n }] of pressed.entries()) {
    // p = 1 - (1 - BREACH_CHANCE)^(1 + BREACH_PRESSURE_MULT*(n-1))
    // n=1 -> BREACH_CHANCE; more attackers -> higher p (compounded contact).
    const exponent = 1 + BREACH_PRESSURE_MULT * (n - 1);
    const p = 1 - Math.pow(1 - BREACH_CHANCE, exponent);

    if (Math.random() < p) {
      const next = getIntegrity(x, y) - 1;
      setIntegrity(x, y, next);
      // Record this chip for the renderer flash (task 11-4, GDD 12).
      // We ONLY record; we never alter the chip decision or rates.
      recentChips.set(cellKey, _breachTick);
      if (next <= 0) {
        set(x, y, AIR); // GDD 7.4: integrity 0 -> cell destroyed, body pushes in
        markTerrainEdit(x, y); // navgrid/paths update around the new gap
      }
    }
  }
}
