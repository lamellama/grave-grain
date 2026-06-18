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
 */

/**
 * One authored pixel of a bone, in the bone's LOCAL cell space.
 * A pixel's world cell is:  Math.round(body.x) + bone.offset.dx + pixel.dx
 *                           Math.round(body.y) + bone.offset.dy + pixel.dy
 * (dy negative = up, since the body anchor is the feet-centre.)
 *
 * Phase 4 will add a `material` slot here (FLESH/BONE/BLOOD — GDD §5.2) so a
 * released pixel knows which body material to write into the grid; for now only
 * a placeholder render `color` is authored.
 */
export interface BodyPixel {
  dx: number;
  dy: number;
  color: string;
  // Phase 4: material: number;  // FLESH | BONE | BLOOD — what this pixel sheds as
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
}

// Placeholder render palette (Phase 4 replaces these with real body materials).
const SKIN = '#c98a5e'; // head + arms
const SHIRT = '#4a5a7a'; // torso cloth
const TROUSERS = '#37374a'; // legs cloth

/**
 * Build a filled w×h rectangle of BodyPixels in local cell space, with its
 * top-left at (x0, y0). Keeps the authored figure chunky and guarantees no two
 * pixels in a bone collide.
 */
function rect(
  w: number,
  h: number,
  x0: number,
  y0: number,
  color: string,
): BodyPixel[] {
  const out: BodyPixel[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      out.push({ dx: x0 + dx, dy: y0 + dy, color });
    }
  }
  return out;
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
  // Each bone: offset = its anchor relative to feet-centre; pixels local to it.
  const rig: Bone[] = [
    {
      name: 'head',
      offset: { dx: 0, dy: -10 },
      pixels: rect(2, 3, -1, -1, SKIN), // cols 2-3, rows 0-2
      destroyed: false,
    },
    {
      name: 'torso',
      offset: { dx: 0, dy: -6 },
      pixels: rect(4, 5, -2, -2, SHIRT), // cols 1-4, rows 3-7
      destroyed: false,
    },
    {
      name: 'lArm',
      offset: { dx: -3, dy: -6 },
      pixels: rect(1, 5, 0, -2, SKIN), // col 0, rows 3-7
      destroyed: false,
    },
    {
      name: 'rArm',
      offset: { dx: 2, dy: -6 },
      pixels: rect(1, 5, 0, -2, SKIN), // col 5, rows 3-7
      destroyed: false,
    },
    {
      name: 'lLeg',
      offset: { dx: -2, dy: -2 },
      pixels: rect(2, 4, 0, -1, TROUSERS), // cols 1-2, rows 8-11
      destroyed: false,
    },
    {
      name: 'rLeg',
      offset: { dx: 0, dy: -2 },
      pixels: rect(2, 4, 0, -1, TROUSERS), // cols 3-4, rows 8-11
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
  };
}
