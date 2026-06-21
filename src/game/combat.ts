/**
 * game/combat.ts — Shared melee primitives (GDD §7.2). DOM-free, pure.
 *
 * Combat in Gravegrain has NO hit-table and NO HP bar: a successful strike
 * RELEASES the target region's body pixels into the live cellular sim and tells
 * the rig what it lost — exactly the Phase-4 GATE handoff (applyDamage). This
 * module is the thin, side-agnostic layer that both the zombie side (t3, wired
 * here) and the guard side (t4) call: pick a region, then route the wound
 * through applyDamage. We DO NOT re-implement gore/release/death here — that all
 * lives in characters/damage.ts (THE GATE). Same emergent model both ways.
 */

import type { Body, BoneName } from '../characters/body';
import { applyDamage } from '../characters/damage';
import { registerHit } from './ui';
import { ATTACK_REACH, BODY_W, BODY_H, TURN_FROM_BITE } from '../config';

/**
 * Footprint proximity test (GDD §7.2 melee reach). Two rigged bodies are
 * "adjacent" — close enough to strike — when their feet-centre anchors satisfy
 * BOTH:
 *
 *   horizontal:  |round(a.x) - round(b.x)|  <=  reach + BODY_W
 *   vertical:    |round(a.y) - round(b.y)|  <=  BODY_H
 *
 * The horizontal slack is `reach` (ATTACK_REACH=2) plus a full BODY_W (=6, i.e.
 * bodyHalfWidth*2): two bodies standing flush side-by-side on a floor have
 * anchors ~BODY_W apart (each is BODY_W wide, centres one width apart), so they
 * register with reach to spare, while bodies a half-dozen+ cells apart do not.
 * The vertical bound is BODY_H so two figures whose torsos overlap at all count
 * (same-floor neighbours have dy≈0); a body a full height above/below does not.
 * Integer-rounded because a body only ever occupies whole cells (round(x/y)).
 */
export function bodiesAdjacent(a: Body, b: Body, reach = ATTACK_REACH): boolean {
  const dx = Math.abs(Math.round(a.x) - Math.round(b.x));
  const dy = Math.abs(Math.round(a.y) - Math.round(b.y));
  return dx <= reach + BODY_W && dy <= BODY_H;
}

/** Is `target`'s bone `name` present and not yet destroyed? */
function intact(target: Body, name: BoneName): boolean {
  const bone = target.rig.find((b) => b.name === name);
  return !!bone && !bone.destroyed;
}

/** First still-standing bone in rig order, or null if the whole rig is gone. */
function anyIntact(target: Body): BoneName | null {
  for (const bone of target.rig) {
    if (!bone.destroyed) return bone.name;
  }
  return null;
}

/**
 * Choose a NON-destroyed bone to strike for the given aim (GDD §7.2 — weapon
 * choice & positioning pick the region):
 *   'leg'   → an intact leg (lLeg, else rLeg); else torso; else any remaining.
 *   'head'  → head if intact, else null (no opportunistic substitute).
 *   'torso' → torso if intact, else any remaining.
 *   'auto'  → torso if intact, else head if intact, else any remaining.
 * Returns null only when EVERY bone is already destroyed.
 */
export function pickAttackRegion(
  target: Body,
  aim: 'leg' | 'head' | 'torso' | 'auto',
): BoneName | null {
  switch (aim) {
    case 'leg':
      if (intact(target, 'lLeg')) return 'lLeg';
      if (intact(target, 'rLeg')) return 'rLeg';
      if (intact(target, 'torso')) return 'torso';
      return anyIntact(target);

    case 'head':
      return intact(target, 'head') ? 'head' : null;

    case 'torso':
      if (intact(target, 'torso')) return 'torso';
      return anyIntact(target);

    case 'auto':
      if (intact(target, 'torso')) return 'torso';
      if (intact(target, 'head')) return 'head';
      return anyIntact(target);
  }
}

/**
 * Land a melee blow on `target`'s `region`: a thin wrapper over THE GATE
 * (applyDamage) so combat correctness — pixel release, capability loss,
 * head/torso → death-collapse — is shared with fire and burial, never forked.
 */
export function meleeAttack(target: Body, region: BoneName): void {
  applyDamage(target, region);
  // Register a brief hit-flash ring at the target's world position (task 11-7,
  // GDD §12 UX readability). registerHit is bounded and non-blocking.
  registerHit(target.x, target.y);
}

/**
 * The ZOMBIE's signature melee (GDD §7.2 "bite & turning" / §5.1 outcome 3): a
 * BITE that INFECTS rather than dismembers. Unlike meleeAttack (the guard's
 * path), a bite does NOT call applyDamage — it releases no cells, destroys no
 * bones, and never triggers THE GATE/dissolve. It simply marks an un-infected
 * body `infected` (with TURN_FROM_BITE probability — the optional balance knob:
 * not every bite need infect) and resets its infection clock to 0. The
 * acting→prone→turn progression that consumes these is Task 4; here the bite
 * only starts the process.
 *
 * NOTE: the Math.random() below lives in the BODY/AI layer (combat), never
 * inside simulation.step()/the chunked CA, so it can't perturb chunk
 * byte-equivalence (GDD §13 determinism).
 */
export function biteAttack(target: Body): void {
  if (!target.infected && Math.random() < TURN_FROM_BITE) {
    target.infected = true;
    target.infectionTicks = 0;
  }
  // Brief hit-flash for feedback — a bite still reads as a hit (GDD §12), even
  // though it sheds no cells.
  registerHit(target.x, target.y);
}
