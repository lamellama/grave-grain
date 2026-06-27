/**
 * characters/pick.ts - DOM-free body-region picking for the Shoot tool (p4-t7).
 *
 * THE GATE is hand-runnable via a temporary "Shoot" pointer tool (GDD 14
 * Milestone 0 hand-test, 7.2): the player clicks a body region and that
 * region's bone takes damage (-> release pixels into the live sim). This module
 * holds ONLY the pure geometry - "which bone is under this world cell?" - so it
 * is unit-testable with no DOM and no input plumbing. `input.ts` re-exports and
 * drives it; Phase-7 real combat will replace the tool, not this query.
 */

import { SHOOT_PICK_RADIUS } from '../config';
import type { Body, BoneName } from './body';

/**
 * Pick the non-destroyed bone nearest to world cell (worldX, worldY).
 *
 * Iterates every non-destroyed bone's authored pixels (world cell =
 * Math.round(body.x) + bone.offset.dx + pixel.dx, likewise y) and returns the
 * bone whose closest pixel cell is nearest the clicked cell, by squared
 * distance. Only hits within SHOOT_PICK_RADIUS cells count; returns null if the
 * body is dead or nothing is in range.
 *
 * Pure: no DOM, no grid mutation - safe to call from a unit test.
 */
export function pickBone(body: Body, worldX: number, worldY: number): BoneName | null {
  if (!body.alive) {
    return null;
  }

  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const radiusSq = SHOOT_PICK_RADIUS * SHOOT_PICK_RADIUS;

  let bestName: BoneName | null = null;
  let bestDistSq = Infinity;

  for (const bone of body.rig) {
    if (bone.destroyed) {
      continue;
    }
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      const ddx = wx - worldX;
      const ddy = wy - worldY;
      const distSq = ddx * ddx + ddy * ddy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestName = bone.name;
      }
    }
  }

  return bestDistSq <= radiusSq ? bestName : null;
}
