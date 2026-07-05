/**
 * characters/damage.ts - THE GATE: the damage->cells handoff (GDD 5.1 #3, 7.2).
 *
 * The make-or-break trick (Vagabond pixel-release, GDD App. B): when a bone is
 * destroyed, its authored body pixels are RELEASED into the live cellular sim as
 * real cells that fall, pile, bleed and burn - visually indistinguishable from
 * loose terrain because a live body pixel and the cell it sheds share colour and
 * cell-resolution (GDD 14 gate point 5).
 *
 * SCOPE (p4-t3): the release PRIMITIVE (releaseBone) + the per-cell movement
 * rules (in simulation.ts), PLUS the damage dispatch - applyDamage(body,bone)
 * releases the hit bone and resolves the emergent consequence (GDD 7.2 table:
 * head->dissolve/death, leg->crawl, arm->lose reach, torso->bleed->disintegrate),
 * and dissolveBody(body) (the Vagabond death-collapse, App. B). NO crawl
 * locomotion (t4), NO drown/bury (t5), NO input (t7) - this layer only mutates
 * the rig + grid; it never drives movement.
 *
 * DOM-free pure logic so it stays headless-testable.
 */

import {
  BLOOD_PER_HIT,
  TORSO_DISINTEGRATE_THRESHOLD,
  CORPSE_DECAY_TICKS,
} from '../config';
import { material, idx, inBounds, placeMaterial } from '../engine/grid';
import { AIR, BLOOD, isFluid } from '../engine/materials';
import type { Body, Bone, BoneName } from './body';

/**
 * Can a released body cell be written into the cell at (x,y) WITHOUT clobbering
 * terrain? (GDD 5.1: release pixels into the sim, never overwrite the floor.)
 *
 * Displaceable iff the target is in-bounds AND either:
 *   - AIR (always free), or
 *   - a FLUID (WATER/BLOOD) the gore can sink into.
 *
 * Body cells land ONLY in free space - never erase loose terrain. This is
 * narrower than the sim's density-swap: a heavy released BONE (density 5) must
 * not delete a strictly-lighter powder (SAND/DIRT/ASH) on the one-shot release;
 * once in the grid the ongoing fall (trySwap) sorts the pile by density. The
 * static floor (stone) is neither AIR nor fluid, so the pile rests on it.
 */
function displaceable(x: number, y: number): boolean {
  if (!inBounds(x, y)) {
    return false;
  }
  const target = material[idx(x, y)];
  return target === AIR || isFluid(target);
}

/**
 * Release a bone's pixels into the live sim (GDD 5.1 #3, 7.2: severed parts
 * become loose body cells that fall/settle/bleed). Returns the number of body
 * cells written.
 *
 * - Each non-destroyed pixel is written (via placeMaterial) into its world cell
 *   ONLY if that cell is displaceable - terrain is never clobbered.
 * - The bone is marked destroyed.
 * - Up to BLOOD_PER_HIT BLOOD cells are spat into free AIR cells around the
 *   bone's footprint so the shed part bleeds.
 * - Idempotent: releasing an already-destroyed bone is a no-op returning 0.
 */
export function releaseBone(body: Body, bone: Bone): number {
  // Idempotent guard - a destroyed bone has already shed its pixels.
  if (bone.destroyed) {
    return 0;
  }

  const rx = Math.round(body.x);
  const ry = Math.round(body.y);

  // Footprint bounding box (for blood placement), tracked as we write cells.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  let released = 0;
  for (const p of bone.pixels) {
    const wx = rx + bone.offset.dx + p.dx;
    const wy = ry + bone.offset.dy + p.dy;
    if (!displaceable(wx, wy)) {
      continue; // never clobber terrain/the floor
    }
    placeMaterial(wx, wy, p.material);
    released++;
    if (wx < minX) minX = wx;
    if (wy < minY) minY = wy;
    if (wx > maxX) maxX = wx;
    if (wy > maxY) maxY = wy;
  }

  // Mark destroyed regardless - the bone is gone even if it landed in a wall and
  // had nowhere to shed (keeps the rig state consistent for t3's recompute).
  bone.destroyed = true;

  // Bleed: spit up to BLOOD_PER_HIT BLOOD cells into free AIR cells around the
  // footprint (a thin fluid that falls, seeks level and douses nothing). Scan a
  // 1-cell ring outward so blood lands beside/above the fresh gore, not inside
  // the just-written pile. Deterministic scan order keeps it headless-testable.
  if (released > 0) {
    let blood = 0;
    for (let y = minY - 1; y <= maxY + 1 && blood < BLOOD_PER_HIT; y++) {
      for (let x = minX - 1; x <= maxX + 1 && blood < BLOOD_PER_HIT; x++) {
        if (inBounds(x, y) && material[idx(x, y)] === AIR) {
          placeMaterial(x, y, BLOOD);
          blood++;
        }
      }
    }
  }

  return released;
}

/**
 * Map a destroyed limb to its capability flag(s) on the body (GDD 7.2). Legs
 * disable that limb (-> crawl in t4); arms lose that side's reach (-> Phase-7
 * combat). Head/torso carry no per-side capability flag.
 */
function markCapabilityLost(body: Body, name: BoneName): void {
  switch (name) {
    case 'lLeg':
      body.lLegLost = true;
      break;
    case 'rLeg':
      body.rLegLost = true;
      break;
    case 'lArm':
      body.lArmLost = true;
      body.reachLeft = false; // GDD 7.2: "loses that arm's reach"
      break;
    case 'rArm':
      body.rArmLost = true;
      body.reachRight = false;
      break;
    default:
      break; // head / torso: no per-side capability flag
  }
}

/**
 * Cumulative destroyed fraction = destroyed body pixels / total original body
 * pixels (GDD 7.2 torso "enough loss triggers full disintegration"). Counts
 * whole bones by their authored pixel count, so a big torso loss weighs more
 * than a thin arm. Range 0..1.
 */
function destroyedFraction(body: Body): number {
  let total = 0;
  let lost = 0;
  for (const bone of body.rig) {
    total += bone.pixels.length;
    if (bone.destroyed) {
      lost += bone.pixels.length;
    }
  }
  return total === 0 ? 0 : lost / total;
}

/**
 * Spit a few extra BLOOD cells above a bone's footprint (GDD 7.2 torso
 * "bleeds, weakens"). releaseBone already bleeds the shed part; this is the bit
 * of extra blood a torso wound weeps. Deterministic scan, AIR-only, bounded by
 * BLOOD_PER_HIT so it stays cheap and headless-testable.
 */
function bleedAbove(body: Body, bone: Bone): void {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  let spilt = 0;
  for (const p of bone.pixels) {
    if (spilt >= BLOOD_PER_HIT) {
      break;
    }
    const wx = rx + bone.offset.dx + p.dx;
    const wy = ry + bone.offset.dy + p.dy - 1; // one row above the footprint
    if (inBounds(wx, wy) && material[idx(wx, wy)] === AIR) {
      placeMaterial(wx, wy, BLOOD);
      spilt++;
    }
  }
}

/**
 * THE GATE dispatch (GDD 7.2): a hit on `boneName` releases that bone's pixels
 * into the live sim, tells the rig what it lost, then resolves the emergent
 * consequence. A single entry point so every damage source (combat in t7, fire,
 * burial) routes through the same handoff.
 *
 * | What's destroyed | Emergent effect (GDD 7.2)                          |
 * |------------------|-----------------------------------------------------|
 * | head             | body fully dissolves into falling cells -> death     |
 * | leg (l/r)        | leg drops as cells; rig disables that limb -> crawl  |
 * | arm (l/r)        | arm drops; loses that side's reach                  |
 * | torso            | bleeds/weakens; enough loss -> full disintegration   |
 *
 * No-op if the body is already dead or the bone is already destroyed.
 */
export function applyDamage(body: Body, boneName: BoneName): void {
  if (!body.alive) {
    return;
  }
  const bone = body.rig.find((b) => b.name === boneName);
  if (!bone || bone.destroyed) {
    return;
  }

  // Release the hit region's pixels into the sim, then record the loss on the rig.
  releaseBone(body, bone);
  markCapabilityLost(body, boneName);

  switch (boneName) {
    case 'head':
      // GDD 7.2: head region destroyed -> the whole body dissolves into falling
      // cells (death) - the Vagabond death-collapse (App. B).
      dissolveBody(body);
      return;

    case 'lLeg':
    case 'rLeg':
      // GDD 7.2: leg pixels drop as cells; the rig disables that limb so
      // locomotion crawls (t4). The body stays alive even if BOTH legs are lost.
      return;

    case 'lArm':
    case 'rArm':
      // GDD 7.2: arm pixels drop; that side's reach is gone (flag only, used by
      // Phase-7 combat). The body stays alive.
      return;

    case 'torso':
      // GDD 7.2: the torso bleeds and weakens; once cumulative loss crosses the
      // threshold the body fully disintegrates.
      bleedAbove(body, bone);
      if (destroyedFraction(body) >= TORSO_DISINTEGRATE_THRESHOLD) {
        dissolveBody(body);
      }
      return;
  }
}

/**
 * Death-collapse (GDD 7.2 / App. B, the Vagabond trick): the body fully
 * dissolves into falling cells. Marks the body dead and releases EVERY remaining
 * non-destroyed bone into the live sim, so the whole figure becomes a pile of
 * loose FLESH/BONE/BLOOD cells visually indistinguishable from terrain (the
 * renderer skips destroyed bones, so the sprite vanishes and only cells remain).
 * Idempotent: releaseBone no-ops on already-destroyed bones.
 */
export function dissolveBody(body: Body): void {
  body.alive = false;
  // Counterplay (revised death model, GDD 5.1/7.2): an EXTREME hit that
  // dissolves an infected/prone body before its turn timer kills it for good -
  // clear the infection so updateInfection can never reanimate a dissolved body.
  body.infected = false;
  body.prone = false;
  for (const bone of body.rig) {
    releaseBone(body, bone);
  }
}

/**
 * Lie-down/settle (revised death model, GDD 5.1 "Quiet/needs -> lie down as a
 * corpse"): a QUIET death - starvation, thirst, freezing, drowning, slow
 * bleed-out - lays the rig down as a PRONE CORPSE BODY rather than spraying it
 * into the live sim. This is DISTINCT from dissolveBody (the EXTREME death):
 *
 *   - The body is marked dead (alive=false) so every existing dead-body guard
 *     (locomotion/survivor/zombie) keeps it from being driven - a corpse is inert.
 *   - It is flagged a corpse and given CORPSE_DECAY_TICKS to decay/fade (GDD 13).
 *   - The rig is LEFT INTACT: no bone is released, NO cells are written. The
 *     figure stays whole and prone (cell release is the dissolve path's job).
 *
 * Forward-compat (later death-model tasks): if the body ever carries infection
 * flags, clear them here so a corpse can never "turn". Guarded by an `in` check
 * so this stays correct before those fields exist.
 */
export function layDownCorpse(body: Body, cause?: string): void {
  body.alive = false;
  body.corpse = true;
  // Record WHAT killed it on the body itself (playtest v0.10 R): a kill that
  // resolves in the body layer (drowning, in locomotion) never sees the
  // Survivor, so the state.ts death watcher reads this as its fallback and a
  // drowned survivor is no longer mis-reported as 'killed by zombies'.
  if (cause) body.deathCause = cause;
  body.corpseTicks = CORPSE_DECAY_TICKS;
  // A corpse from a quiet death must never reanimate (bite/turn is a separate
  // outcome) - clear any infection/downed state (revised death model, GDD 5.1).
  body.infected = false;
  body.prone = false;
}
