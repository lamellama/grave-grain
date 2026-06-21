/**
 * characters/body.ts — Hybrid character body: skeleton rig + pixel map.
 *
 * GDD §5.1 / §14 Milestone 0: a survivor is a *chunky pixel-art body rigged to
 * a simple skeleton while alive*. The body is authored at WORLD-CELL RESOLUTION
 * (CELL_SIZE pixels per body pixel) so that when Phase 4 releases a damaged
 * region's pixels into the live cellular sim, those cells are visually
 * indistinguishable from loose sand/flesh grains — that resolution match is the
 * load-bearing illusion (GDD §14 "art direction is load-bearing").
 *
 * GDD §6.1: Health is NOT a bar — it is body *integrity*. The rig below is the
 * structure Phase 4's damage→cells handoff extends (mark a bone `destroyed`,
 * release its pixels, react: leg → crawl, head → death-collapse).
 *
 * SCOPE (p3-t1): data + factory only. No locomotion (t2/t3), no damage/release
 * (Phase 4). DOM-free pure logic so it stays headless-testable.
 *
 * Phase 4 (p4-t1): each pixel now carries a body `material` (FLESH/BONE) and
 * derives its render `color` from MATERIALS[material].color, so a LIVE body
 * pixel and the cell it sheds are identical in colour and resolution — the
 * load-bearing illusion (GDD §14 gate point 5).
 */

import { MATERIALS, FLESH, BONE } from '../engine/materials';

/**
 * One authored pixel of a bone, in the bone's LOCAL cell space.
 * A pixel's world cell is:  Math.round(body.x) + bone.offset.dx + pixel.dx
 *                           Math.round(body.y) + bone.offset.dy + pixel.dy
 * (dy negative = up, since the body anchor is the feet-centre.)
 *
 * `material` (FLESH/BONE/BLOOD — GDD §5.2) is what a released pixel writes into
 * the grid when Phase 4 sheds it. `color` is DERIVED from that material so the
 * live figure and its shed cells match exactly (GDD §14 gate point 5).
 */
export interface BodyPixel {
  dx: number;
  dy: number;
  material: number; // FLESH | BONE | BLOOD — what this pixel sheds as
  color: string; // = MATERIALS[material].color (kept in sync at authoring)
}

export type BoneName = 'head' | 'torso' | 'lArm' | 'rArm' | 'lLeg' | 'rLeg';

/**
 * A rigid region of the body. `offset` is the bone's anchor relative to the
 * body's feet-centre; `pixels` are authored relative to that anchor so future
 * locomotion (t2/t3) can move/pivot a whole bone by nudging its offset.
 */
export interface Bone {
  name: BoneName;
  offset: { dx: number; dy: number };
  pixels: BodyPixel[];
  destroyed: boolean;
}

/**
 * A hybrid body. Anchor (x, y) is the FEET-CENTRE (bottom-centre) in world
 * cells — this makes the ground probe in t2 trivial (just look below y).
 */
export interface Body {
  x: number;
  y: number;
  vy: number;
  // Sub-cell horizontal accumulator (p3-t3). The body only ever occupies WHOLE
  // cells (Math.round(x)); fractional walk progress lives here and is flushed
  // into a one-cell step once it crosses a cell boundary, so collision probes
  // always run on integer columns and the body can never tunnel.
  xRemainder: number;
  grounded: boolean;
  facing: 1 | -1;
  moveDir: -1 | 0 | 1;
  rig: Bone[];
  alive: boolean;
  // Corpse state (revised death model, GDD §5.1 "Quiet/needs → lie down as a
  // corpse"). A QUIET death (starvation/thirst/drown/slow bleed-out) lays the
  // rig down as a PRONE CORPSE BODY rather than spraying its cells (that is the
  // EXTREME → dissolveBody path). `corpse` is true while the body is an inert
  // settled corpse; `alive` stays false so existing dead-body guards still
  // prevent any controller from driving it. `corpseTicks` counts the body down
  // toward decay/fade (GDD §13) and is seeded to CORPSE_DECAY_TICKS on lay-down.
  corpse: boolean;
  corpseTicks: number;
  // Bite-infection state (revised death model, GDD §5.1 outcome 3 / §7.2 "bite
  // & turning"). A zombie's BITE marks the body `infected` rather than
  // dismembering it (that is the guard's path); the body keeps acting briefly,
  // then drops `prone`, then reanimates as a zombie. `infectionTicks` counts up
  // from the bite toward INFECTION_ACTING_TICKS (drop prone) and TURN_DELAY_TICKS
  // (turn). SCOPE: the bite (this task) only SETS `infected`/`infectionTicks=0`;
  // the progression/turn that consumes these is Task 4. Kept on the Body (not
  // the controller) so combat.ts stays body-only and either side can query it.
  infected: boolean;
  infectionTicks: number;
  // True once an infected body has dropped to a downed state (GDD §7.2 "prone/
  // downed"). Seeded false here; Task-4 progression sets it. Locomotion/AI can
  // query it cheaply to stop work/fight and (optionally) slow-crawl.
  prone: boolean;
  // Consecutive ticks the head bone has sat in WATER (p4-t5, THE GATE gate
  // point 4). Incremented while ANY head cell is WATER, reset to 0 the instant
  // the head clears the surface; at DROWN_TICKS the body drowns and dissolves
  // (GDD §5.2 "water drowns bodies when head submerged too long" / §7.3).
  drownTicks: number;
  // Capability flags — what the rig has lost (GDD §7.2 emergent damage). Set by
  // Phase-4 damage when a limb's bone is destroyed and its pixels are released
  // into the sim. Kept on the Body (not just derived from bone.destroyed) so
  // locomotion (t4 crawl) and combat (t7 reach) can query them cheaply.
  lLegLost: boolean;
  rLegLost: boolean;
  lArmLost: boolean;
  rArmLost: boolean;
  // Per-side attack reach (GDD §7.2 "loses that arm's reach"). True while the
  // arm is intact; set false when that arm is lost (consumed by Phase-7 combat).
  reachLeft: boolean;
  reachRight: boolean;
}

/**
 * Build a filled w×h rectangle of BodyPixels in local cell space, with its
 * top-left at (x0, y0). Every pixel is authored with the given body `material`
 * and its colour DERIVED from MATERIALS[material].color, so the live figure and
 * any cell it later sheds are the same colour (GDD §14 gate point 5). Keeps the
 * authored figure chunky and guarantees no two pixels in a bone collide.
 */
function rect(
  w: number,
  h: number,
  x0: number,
  y0: number,
  material: number,
): BodyPixel[] {
  const color = MATERIALS[material].color;
  const out: BodyPixel[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      out.push({ dx: x0 + dx, dy: y0 + dy, material, color });
    }
  }
  return out;
}

/**
 * Re-paint the pixels of `pixels` matching `pred` to a new body `material`,
 * keeping `color` derived from MATERIALS so live figure == shed cell. Used to
 * lay BONE structure (skull cells, spine, leg columns) inside FLESH limbs.
 */
function paint(
  pixels: BodyPixel[],
  material: number,
  pred: (p: BodyPixel) => boolean,
): void {
  const color = MATERIALS[material].color;
  for (const p of pixels) {
    if (pred(p)) {
      p.material = material;
      p.color = color;
    }
  }
}

/**
 * Author one chunky ~BODY_W×BODY_H humanoid at feet-centre anchor (x, y).
 *
 * Assembled figure (col 0..5 left→right, row 0..11 top→bottom; dy = row-11 so
 * the lowest pixels sit at dy≈0 = the feet, dy negative = up):
 *
 *   row col: 0 1 2 3 4 5
 *    0       . . H H . .   head   (cols 2-3, rows 0-2)
 *    1       . . H H . .
 *    2       . . H H . .
 *    3       L T T T T R   arms   (cols 0 & 5, rows 3-7)
 *    4       L T T T T R   torso  (cols 1-4, rows 3-7)
 *    5       L T T T T R
 *    6       L T T T T R
 *    7       L T T T T R
 *    8       . a a b b .   legs   (lLeg cols 1-2, rLeg cols 3-4, rows 8-11)
 *    9       . a a b b .
 *   10       . a a b b .
 *   11       . a a b b .
 *
 * Regions are disjoint by construction, so when every offset+pixel is summed no
 * two body pixels share a world cell. Bounding box = BODY_W×BODY_H.
 */
export function createBody(x: number, y: number): Body {
  // Body matter (GDD §5.2): mostly FLESH, with a chunky BONE structure (skull
  // cap, torso spine column, one bone column per leg). No BLOOD is authored —
  // blood is emitted on hit by Phase-4 damage, not part of the live figure.
  const head = rect(2, 3, -1, -1, FLESH); // cols 2-3, rows 0-2
  paint(head, BONE, (p) => p.dy === -1); // top row = 2 skull-cap BONE cells

  const torso = rect(4, 5, -2, -2, FLESH); // cols 1-4, rows 3-7
  paint(torso, BONE, (p) => p.dx === -1); // central spine column (BONE)

  const lLeg = rect(2, 4, 0, -1, FLESH); // cols 1-2, rows 8-11
  paint(lLeg, BONE, (p) => p.dx === 1); // inner bone column

  const rLeg = rect(2, 4, 0, -1, FLESH); // cols 3-4, rows 8-11
  paint(rLeg, BONE, (p) => p.dx === 0); // inner bone column

  // Each bone: offset = its anchor relative to feet-centre; pixels local to it.
  const rig: Bone[] = [
    {
      name: 'head',
      offset: { dx: 0, dy: -10 },
      pixels: head,
      destroyed: false,
    },
    {
      name: 'torso',
      offset: { dx: 0, dy: -6 },
      pixels: torso,
      destroyed: false,
    },
    {
      name: 'lArm',
      offset: { dx: -3, dy: -6 },
      pixels: rect(1, 5, 0, -2, FLESH), // col 0, rows 3-7
      destroyed: false,
    },
    {
      name: 'rArm',
      offset: { dx: 2, dy: -6 },
      pixels: rect(1, 5, 0, -2, FLESH), // col 5, rows 3-7
      destroyed: false,
    },
    {
      name: 'lLeg',
      offset: { dx: -2, dy: -2 },
      pixels: lLeg,
      destroyed: false,
    },
    {
      name: 'rLeg',
      offset: { dx: 0, dy: -2 },
      pixels: rLeg,
      destroyed: false,
    },
  ];

  return {
    x,
    y,
    vy: 0,
    xRemainder: 0,
    grounded: false,
    facing: 1,
    moveDir: 0,
    rig,
    alive: true,
    corpse: false,
    corpseTicks: 0,
    infected: false,
    infectionTicks: 0,
    prone: false,
    drownTicks: 0,
    lLegLost: false,
    rLegLost: false,
    lArmLost: false,
    rArmLost: false,
    reachLeft: true,
    reachRight: true,
  };
}
