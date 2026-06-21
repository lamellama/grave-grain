/**
 * characters/zombieFooting.ts — Ephemeral per-tick "body footing" set for the
 * zombie ladder-climb (post-MVP backlog, playtest v0.5 #A; GDD §7.1 funnel /
 * §13 perf).
 *
 * THE PROBLEM the climb solves: rigged bodies are SPRITES, not grid cells — the
 * shared GATE locomotion (`bodyCellsSolidAt` in locomotion.ts) only sees the
 * MATERIAL grid and knows nothing about other bodies. So a crowd pressing a wall
 * has no way to step onto each other. This module gives the zombie-AI climb
 * check (zombie.ts) a cheap, read-only snapshot of the world cells occupied by
 * ALIVE zombie bodies, so a blocked zombie can treat an ally's cells as standable
 * footing and climb the pile over a wall too tall for a single step-up.
 *
 * The set is EPHEMERAL: rebuilt once per sim tick by `rebuildZombieFooting()`
 * BEFORE the zombie update loop runs (so every zombie this tick reads the same
 * tick-start snapshot, keeping the result order-independent), then read by the
 * climb check. It is NOT stored in locomotion.ts — the shared updateBody stays
 * footing-agnostic; only the additive zombie behaviour consults this module.
 *
 * Perf: O(zombies × pixels), capped at MAX_ZOMBIES bodies (GDD §13) so the cost
 * is bounded regardless of how many corpses/spawns the array holds. No per-tick
 * world scan.
 *
 * DOM-free pure logic so it stays headless-testable.
 */

import type { Body } from './body';
import { idx } from '../engine/grid';
import { MAX_ZOMBIES } from '../config';

/**
 * Map of world-cell index (idx(x,y)) → COUNT of alive zombie bodies occupying it
 * this tick. Read-only for consumers — only rebuildZombieFooting() mutates it.
 *
 * It's a COUNT, not a plain Set, on purpose: a crowd pressing a wall stops at the
 * same x and the bodies overlap PERFECTLY. The climb check must exclude the
 * climber's OWN cells but still see an ALLY occupying the very same cell — so it
 * subtracts the climber's single contribution from the count and asks whether
 * anyone ELSE remains there (count - self > 0). A Set would lose that multiplicity
 * and a perfectly-overlapping ally would be wrongly excluded as "self".
 */
export const zombieFooting: Map<number, number> = new Map<number, number>();

/** Minimal structural shape so we don't import the concrete Zombie type. */
interface HasBody {
  body: Body;
}

/**
 * Rebuild the footing set from the live zombie list. Call once per sim tick
 * BEFORE updating any zombie. Skips dead bodies (their cells belong to the sim)
 * and destroyed bones, and stops after MAX_ZOMBIES live bodies so the cost is
 * bounded (GDD §13) — surplus bodies simply don't contribute footing this tick.
 */
export function rebuildZombieFooting(zombies: HasBody[]): void {
  zombieFooting.clear();
  let counted = 0;
  for (const z of zombies) {
    if (counted >= MAX_ZOMBIES) break; // bounded snapshot (GDD §13)
    const b = z.body;
    if (!b.alive) continue;
    counted++;
    const rx = Math.round(b.x);
    const ry = Math.round(b.y);
    for (const bone of b.rig) {
      if (bone.destroyed) continue;
      for (const p of bone.pixels) {
        const i = idx(rx + bone.offset.dx + p.dx, ry + bone.offset.dy + p.dy);
        zombieFooting.set(i, (zombieFooting.get(i) ?? 0) + 1);
      }
    }
  }
}
