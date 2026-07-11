/**
 * game/projectiles.ts - ballistic guard ARROWS (round 11, GDD 7.2).
 *
 * Guards now shoot instead of only stabbing: an arrow is a point projectile
 * launched at ARROW_SPEED and pulled down by ARROW_GRAVITY every tick. It is
 * NOT a cell - arrows live in the body/AI layer beside bodies and hit-flashes,
 * so simulation.step() and chunk byte-equivalence are untouched. Flight is
 * swept in sub-cell samples each tick: the first SOLID terrain cell stops the
 * arrow dead, and the first ALIVE zombie bone pixel within ARROW_HIT_RADIUS
 * of the path takes the wound through THE GATE (applyDamage - real cells
 * released, capability loss emergent, same as melee).
 *
 * The AIMING is the round-11 point: solveArcs() returns BOTH ballistic
 * solutions for a target at fixed muzzle speed (the flat "low" arc and the
 * mortar-style "high" lob), and aimArrow() picks the first one whose swept
 * path is CLEAR of terrain - so a guard behind a wall automatically lobs OVER
 * it instead of thudding arrows into its own parapet. Range is limited only
 * by arrow velocity (max flat reach ~ SPEED^2/GRAVITY cells), not a hardcoded
 * engage vector.
 *
 * Everything here is deterministic (no RNG) and DOM-free; the arrow list is
 * module state + reset(), mirroring resources.ts / buildqueue.ts.
 */

import type { Body, BoneName } from '../characters/body';
import type { Zombie } from '../characters/zombie';
import { applyDamage } from '../characters/damage';
import { get, inBounds } from '../engine/grid';
import { isSolidForBody } from '../engine/materials';
import { registerHit } from './ui';
import {
  ARROW_SPEED,
  ARROW_GRAVITY,
  ARROW_MAX_TICKS,
  ARROW_HIT_RADIUS,
  BODY_H,
  BODY_W,
} from '../config';

/** One arrow in flight. Position/velocity in world cells (& cells/tick). */
export interface Arrow {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

const arrows: Arrow[] = [];

/** Live arrows (read-only view for the renderer). */
export function getArrows(): readonly Arrow[] {
  return arrows;
}

/** Clear all arrows (new-game init / test harness). */
export function resetArrows(): void {
  arrows.length = 0;
}

/** Loose an arrow from (x, y) with velocity (vx, vy). */
export function spawnArrow(x: number, y: number, vx: number, vy: number): void {
  arrows.push({ x, y, vx, vy, age: 0 });
}

/**
 * The two ballistic launch velocities that land a projectile of speed `speed`
 * on a target `dx` cells across and `dy` cells down (screen coords: +y is
 * DOWN) under per-tick gravity `g` - LOW (flat) arc first, HIGH lob second.
 * Empty when the target is out of range (discriminant < 0) or directly
 * above/below (|dx| too small for the tangent form - callers close in
 * instead). Pure closed-form solve, no iteration, no RNG.
 */
export function solveArcs(
  dx: number,
  dy: number,
  speed: number = ARROW_SPEED,
  g: number = ARROW_GRAVITY,
): { vx: number; vy: number }[] {
  const adx = Math.abs(dx);
  if (adx < 1) return []; // straight up/down - no tangent solution; melee range anyway
  const v2 = speed * speed;
  const h = -dy; // convert to up-positive height for the standard form
  const disc = v2 * v2 - g * (g * adx * adx + 2 * h * v2);
  if (disc < 0) return []; // out of range at this muzzle speed
  const root = Math.sqrt(disc);
  const out: { vx: number; vy: number }[] = [];
  for (const tan of [(v2 - root) / (g * adx), (v2 + root) / (g * adx)]) {
    const theta = Math.atan(tan); // elevation, up-positive
    out.push({
      vx: Math.sign(dx) * speed * Math.cos(theta),
      vy: -speed * Math.sin(theta), // screen +y is down
    });
  }
  return out;
}

/**
 * Sweep the flight from (sx, sy) at (vx, vy) and report whether it reaches
 * the neighbourhood of (tx, ty) without striking solid terrain first. The
 * first ~body-width of flight is muzzle clearance (the shooter's own cells /
 * the parapet lip it stands behind never count), and arriving within
 * ARROW_HIT_RADIUS + 1 of the target is a hit - the same tolerance the live
 * flight uses against bone pixels.
 */
export function clearShot(
  sx: number,
  sy: number,
  vx: number,
  vy: number,
  tx: number,
  ty: number,
): boolean {
  let x = sx;
  let y = sy;
  let cvy = vy;
  const arrive = (ARROW_HIT_RADIUS + 1) * (ARROW_HIT_RADIUS + 1);
  for (let t = 0; t < ARROW_MAX_TICKS; t++) {
    cvy += ARROW_GRAVITY;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(cvy))));
    for (let s = 0; s < steps; s++) {
      x += vx / steps;
      y += cvy / steps;
      const ddx = x - tx;
      const ddy = y - ty;
      if (ddx * ddx + ddy * ddy <= arrive) return true; // reached the target
      const cx = Math.round(x);
      const cy = Math.round(y);
      if (!inBounds(cx, cy)) return false; // flew off the world
      const fromMuzzle = Math.abs(x - sx) + Math.abs(y - sy);
      if (fromMuzzle <= BODY_W) continue; // muzzle clearance
      if (isSolidForBody(get(cx, cy))) return false; // terrain in the way
    }
  }
  return false;
}

/**
 * A firing solution from (sx, sy) onto (tx, ty), or null. Tries the LOW arc
 * first (flat, fast, hard to sidestep), then the HIGH lob - which is exactly
 * "smart enough to shoot over walls": when a wall blots out the flat shot,
 * the lob clears it and drops onto the target from above.
 */
export function aimArrow(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): { vx: number; vy: number } | null {
  for (const sol of solveArcs(tx - sx, ty - sy)) {
    if (clearShot(sx, sy, sol.vx, sol.vy, tx, ty)) return sol;
  }
  return null;
}

/**
 * Nearest non-destroyed bone of `body` within `radius` cells of (x, y), or
 * null. pickBone with a caller-chosen radius (the Shoot tool's fixed
 * SHOOT_PICK_RADIUS is too forgiving for a flying arrow).
 */
function boneNear(body: Body, x: number, y: number, radius: number): BoneName | null {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  let bestName: BoneName | null = null;
  let bestD = radius * radius;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const ddx = rx + bone.offset.dx + p.dx - x;
      const ddy = ry + bone.offset.dy + p.dy - y;
      const d = ddx * ddx + ddy * ddy;
      if (d <= bestD) {
        bestD = d;
        bestName = bone.name;
      }
    }
  }
  return bestName;
}

/**
 * Advance every arrow one tick: integrate gravity, sweep sub-cell samples,
 * stop on the first solid cell, and wound the first ALIVE zombie whose bone
 * pixels lie within ARROW_HIT_RADIUS of the path (applyDamage through THE
 * GATE + hit-flash). Call once per sim tick from main, after the zombie and
 * survivor updates (arrows loosed this tick fly from next tick).
 */
export function updateArrows(zombies: Zombie[]): void {
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.age++;
    if (a.age > ARROW_MAX_TICKS) {
      arrows.splice(i, 1);
      continue;
    }
    a.vy += ARROW_GRAVITY;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(a.vx), Math.abs(a.vy))));
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      a.x += a.vx / steps;
      a.y += a.vy / steps;
      const cx = Math.round(a.x);
      const cy = Math.round(a.y);
      if (!inBounds(cx, cy)) {
        dead = true;
        break;
      }
      // Zombie hit? Coarse anchor box first, exact bone-pixel test second.
      for (const z of zombies) {
        if (!z.body.alive) continue;
        const zx = Math.round(z.body.x);
        const zy = Math.round(z.body.y);
        if (Math.abs(zx - a.x) > BODY_W || a.y < zy - BODY_H - 1 || a.y > zy + 2) {
          continue;
        }
        const bone = boneNear(z.body, cx, cy, ARROW_HIT_RADIUS);
        if (bone) {
          applyDamage(z.body, bone);
          registerHit(z.body.x, z.body.y);
          dead = true;
          break;
        }
      }
      if (!dead && isSolidForBody(get(cx, cy))) {
        dead = true; // thuds into terrain
      }
    }
    if (dead) arrows.splice(i, 1);
  }
}
