/**
 * engine/simulation.ts — Falling-sand cellular update (Phase 1)
 * MVP scope: AIR + SAND + STONE + WATER (task p1-t4 adds water + density swap).
 *
 * Three correctness pillars (all load-bearing):
 *  - BOTTOM-UP scan (GDD Appendix B takeaway #1): the world is updated from the
 *    bottom row to the top each tick. A top-down scan would carry one grain down
 *    through every row in a single tick (teleporting) — bottom-up only ever lets
 *    a grain advance one row per tick.
 *  - EXPLICIT moved-guard (new in p1-t4): a per-cell "moved this tick" flag.
 *    For sand the bottom-up order was a free moved-guard (sand only moves DOWN,
 *    into already-processed rows). That invariant breaks for water — water moves
 *    SIDEWAYS within a row the scan has not finished, and density swaps push the
 *    lighter material UP into the current cell — so without an explicit flag a
 *    grain could be re-processed and skid multiple cells per tick. The flag
 *    makes "one action per cell per tick" hold for every material.
 *  - DENSITY swap (GDD §5.2): a heavier non-static grain swaps with a lighter,
 *    non-static cell below it — so sand (density 3) sinks through water
 *    (density 1) and the water rises above it. Stone (static/255) never moves.
 *    Falling into AIR is just the swap with the lightest material, so the same
 *    rule covers "fall" and "sink".
 */

import {
  WORLD_W,
  WORLD_H,
  DIRT_SPILL_CHANCE,
  SMOKE_DISSIPATE,
  FIRE_LIFETIME,
  FIRE_SPREAD_CHANCE,
  SMOKE_EMIT_CHANCE,
  MAX_GORE_CELLS,
  GORE_FADE_PER_TICK,
  GORE_RECOUNT_INTERVAL,
} from '../config';
import { material, integrity, idx, set, setIntegrity } from './grid';
import { reactions } from './reactions';
import {
  AIR,
  SAND,
  WATER,
  DIRT,
  ASH,
  SMOKE,
  FIRE,
  FLESH,
  BONE,
  BLOOD,
  density,
  isStatic,
  isFluid,
  isFlammable,
} from './materials';

/**
 * Tick parity counter. Drives the per-tick column scan-direction flip so neither
 * piling nor water flow shows a left/right drift bias (PLAN Phase 1:
 * "scan-direction flip per row each frame to kill left/right bias").
 */
let tick = 0;

/**
 * "Moved this tick" guard, one byte per cell (0 = free, 1 = already acted).
 * Cleared at the start of every step(). Any cell that has already moved or been
 * swapped this tick is skipped, and is never chosen as a swap target — this is
 * what prevents double-moves now that material travels sideways and swaps
 * upward within a single bottom-up pass.
 */
export const moved = new Uint8Array(WORLD_W * WORLD_H);

/**
 * Advance the cellular simulation by one tick.
 *
 * Scan order is BOTTOM row (y = WORLD_H-1) → TOP row (y = 0), with the per-row
 * column direction flipped every tick to kill lateral bias (GDD App. B).
 */
export function step(): void {
  // Clear the moved-guard for the new tick.
  moved.fill(0);

  // Cross-material adjacency reactions run FIRST, before the movement scan
  // (GDD §5.2 interactions). Rationale:
  //  - They read the START-OF-TICK grid (a stable snapshot), so a reaction
  //    never fires on a half-moved mid-scan state — deterministic and order-
  //    independent.
  //  - The extinguish path converts a watered FIRE to SMOKE and CLAIMS the cell
  //    in the shared moved-guard, so the movement scan skips it this tick. A
  //    fire touching water therefore dies on the SAME tick it is watered,
  //    before it can age or spread — which is exactly the measurable speed-up
  //    the phase Done-when checks for.
  reactions();

  // Flip column scan direction every tick to avoid any lateral bias.
  const leftToRight = (tick & 1) === 0;

  for (let y = WORLD_H - 1; y >= 0; y--) {
    if (leftToRight) {
      for (let x = 0; x < WORLD_W; x++) {
        updateCell(x, y);
      }
    } else {
      for (let x = WORLD_W - 1; x >= 0; x--) {
        updateCell(x, y);
      }
    }
  }

  // Mobile gore budget (task 10-8, GDD §13): keep loose body-debris bounded so
  // it can't accumulate forever and sink the framerate. Runs AFTER the movement
  // scan so it never interferes with fall/settle/no-tunnel this tick.
  sweepGore();

  tick++;
}

/**
 * Last measured count of loose body-debris cells (FLESH + BONE + BLOOD).
 * Refreshed by a full grid scan every GORE_RECOUNT_INTERVAL ticks (the ONLY
 * full-grid scan this adds — see sweepGore for the amortised cost), and
 * decremented as the fade AIR-ifies cells in between recounts.
 */
let goreCount = 0;

/**
 * Rolling cursor into the flat grid for the fade sweep. Advancing it across
 * ticks (instead of restarting at 0) spreads the fade over the whole world and
 * keeps each tick's fade work bounded to GORE_FADE_PER_TICK conversions.
 */
let fadeCursor = 0;

/** Is `m` a loose body-debris material? (the only cells the fade may remove.) */
function isLooseDebris(m: number): boolean {
  return m === FLESH || m === BONE || m === BLOOD;
}

/**
 * Gore budget sweep (task 10-8, GDD §13 "fade/settle gore so debris doesn't
 * accumulate forever"). A deliberately MVP-minimal cap+fade — NOT chunking
 * (Phase 11).
 *
 * Mechanism:
 *  - Every GORE_RECOUNT_INTERVAL ticks, recount the loose FLESH/BONE/BLOOD cells
 *    in one tight pass over the material array (a Uint8Array scan — fast). This
 *    is the only full-grid scan we add; amortised it is ~WORLD_W·WORLD_H /
 *    GORE_RECOUNT_INTERVAL reads/tick (≈10k/tick here), versus the main step()
 *    which already visits every cell each tick — so the overhead is a small
 *    fraction of one tick. We deliberately do NOT recount every tick.
 *  - While the count is at/under MAX_GORE_CELLS the function is a no-op past the
 *    cheap recount, so below the cap gore falls, piles and bleeds untouched.
 *  - When OVER budget, AIR-ify up to GORE_FADE_PER_TICK debris cells found by a
 *    rolling cursor (a slow fade, not a snap). The cursor walks the flat grid;
 *    because being over budget means ≥ MAX_GORE_CELLS debris cells exist, it
 *    finds its quota within a few thousand reads, and the `scanned < total`
 *    guard caps the work so a sparse grid can never stall the tick.
 *
 * CRITICAL (THE GATE invariants): the fade ONLY ever converts loose
 * FLESH/BONE/BLOOD → AIR. Terrain/structure (STONE/DIRT/WOOD/WALL/…) and live
 * body SPRITES (which are not in the grid at all) are never touched.
 */
function sweepGore(): void {
  // Periodic exact recount (amortised; never every tick).
  if (tick % GORE_RECOUNT_INTERVAL === 0) {
    let n = 0;
    for (let i = 0; i < material.length; i++) {
      if (isLooseDebris(material[i])) n++;
    }
    goreCount = n;
  }

  if (goreCount <= MAX_GORE_CELLS) {
    return; // under budget — leave all debris alone
  }

  // Over budget → fade a bounded number of debris cells to AIR via the cursor.
  const total = material.length;
  let faded = 0;
  let scanned = 0;
  while (faded < GORE_FADE_PER_TICK && scanned < total) {
    if (isLooseDebris(material[fadeCursor])) {
      material[fadeCursor] = AIR;
      integrity[fadeCursor] = 0; // clear any reused slot; AIR carries none
      faded++;
    }
    fadeCursor++;
    if (fadeCursor >= total) {
      fadeCursor = 0;
    }
    scanned++;
  }
  goreCount -= faded;
}

/**
 * Dispatch a single cell to its material rule. Cells that already acted this
 * tick (fell into here, or were swapped up) are skipped by the moved-guard.
 */
function updateCell(x: number, y: number): void {
  if (moved[idx(x, y)]) {
    return;
  }
  const m = material[idx(x, y)];
  if (m === SAND) {
    updateSand(x, y);
  } else if (m === DIRT) {
    updateDirt(x, y);
  } else if (m === ASH) {
    updateAsh(x, y);
  } else if (m === WATER) {
    updateWater(x, y);
  } else if (m === FIRE) {
    updateFire(x, y);
  } else if (m === SMOKE) {
    updateGas(x, y);
  } else if (m === FLESH) {
    updateFlesh(x, y);
  } else if (m === BONE) {
    updateBone(x, y);
  } else if (m === BLOOD) {
    updateBlood(x, y);
  }
  // AIR is the empty target; STONE is static — neither has a rule.
}

/**
 * Shared POWDER fall (GDD §7.2 "severed parts are loose body cells that fall &
 * settle"). Identical primitive to sand: fall straight down through anything
 * lighter and non-static (the density swap), else spill into the two diagonals
 * below in random per-cell order so the gore piles at an angle of repose. Used
 * by both released FLESH and BONE — they differ only in density (FLESH 3 sinks,
 * BONE 5 sinks faster/under flesh), and that falls out of trySwap for free.
 */
function powderFall(x: number, y: number): void {
  const below = y + 1;

  // 1) Fall straight down through any lighter, non-static cell (AIR/WATER/BLOOD).
  if (trySwap(x, y, x, below)) {
    return;
  }

  // 2) Otherwise pile via the two diagonals below (random order, no side bias).
  const leftFirst = Math.random() < 0.5;
  const firstDx = leftFirst ? -1 : 1;
  const secondDx = leftFirst ? 1 : -1;

  if (trySwap(x, y, x + firstDx, below)) {
    return;
  }
  trySwap(x, y, x + secondDx, below);
}

/**
 * FLESH rule (GDD §5.2 / §7.2): a released flesh cell is a powder — it falls and
 * piles like sand. Density 3, so it rests on the floor and is sunk-under by the
 * heavier BONE (density 5).
 */
function updateFlesh(x: number, y: number): void {
  powderFall(x, y);
}

/**
 * BONE rule (GDD §5.2 / §7.2): a released bone cell is a heavier powder (density
 * 5). Same fall/pile primitive as flesh; the density difference is what lets
 * bone settle beneath flesh in a gore pile.
 */
function updateBone(x: number, y: number): void {
  powderFall(x, y);
}

/**
 * BLOOD rule (GDD §5.2: "thin fluid, stains, douses NOTHING"; §7.2 bleed).
 * A thin fluid — it falls and seeks its level exactly like water (density 1),
 * delegating to the same generic fluid logic. "Douses nothing" is handled by
 * reactions() keying extinguish on WATER only (untouched here), so a blood
 * smear never puts out a fire.
 */
function updateBlood(x: number, y: number): void {
  // Reuse the water flow primitive: trySwap is density-generic, so BLOOD (1)
  // falls/seeks-level identically without any blood-specific code path.
  updateWater(x, y);
}

/**
 * SAND rule (GDD §5.2): fall straight down (sinking through anything lighter and
 * non-static — AIR or WATER), otherwise spill into the two diagonals below in
 * random per-cell order to pile at the angle of repose. Sand never moves
 * horizontally, so a mound stays stable.
 */
function updateSand(x: number, y: number): void {
  const below = y + 1;

  // 1) Sink straight down through any lighter, non-static cell (AIR or WATER).
  if (trySwap(x, y, x, below)) {
    return;
  }

  // 2) Otherwise pile via the two diagonals below (random order, no side bias).
  const leftFirst = Math.random() < 0.5;
  const firstDx = leftFirst ? -1 : 1;
  const secondDx = leftFirst ? 1 : -1;

  if (trySwap(x, y, x + firstDx, below)) {
    return;
  }
  trySwap(x, y, x + secondDx, below);
}

/**
 * DIRT rule (GDD §5.2: "dirt piles steeper than sand").
 * Identical to sand for the straight-down fall (unconditional — sinks through
 * anything lighter and non-static via the same density swap, so dirt still falls
 * through air and sinks through water). The difference is the diagonal spill: it
 * is only ATTEMPTED with probability DIRT_SPILL_CHANCE this tick. When the spill
 * is skipped the grain simply rests this tick. Fewer diagonal moves over time
 * means grains stack up more before sliding sideways, so the mound holds a
 * steeper angle of repose and a narrower base than a sand pile of equal mass.
 */
function updateDirt(x: number, y: number): void {
  const below = y + 1;

  // 1) Fall straight down through any lighter, non-static cell (AIR or WATER).
  if (trySwap(x, y, x, below)) {
    return;
  }

  // 2) Blocked below → only spill diagonally with DIRT_SPILL_CHANCE (steepness).
  if (Math.random() >= DIRT_SPILL_CHANCE) {
    return;
  }

  // Same random L/R order and displacement primitive as sand.
  const leftFirst = Math.random() < 0.5;
  const firstDx = leftFirst ? -1 : 1;
  const secondDx = leftFirst ? 1 : -1;

  if (trySwap(x, y, x + firstDx, below)) {
    return;
  }
  trySwap(x, y, x + secondDx, below);
}

/**
 * ASH rule (GDD §5.2: "falls lightly, inert").
 * A plain powder: identical fall/spill to sand (full diagonal spill, no fluid
 * sideways flow — it piles and rests, it does not seek level). "Light" is
 * expressed purely by its low density (DENSITY_ASH = 2). "Inert" means it has no
 * reaction/ignition handling at all — it only ever falls and rests.
 *
 * NOTE: density(ASH)=2 > density(WATER)=1, so ash sinks through water and rests
 * on the floor beneath it. That is the physical/accepted MVP behaviour.
 */
function updateAsh(x: number, y: number): void {
  const below = y + 1;

  // 1) Fall straight down through any lighter, non-static cell (AIR or WATER).
  if (trySwap(x, y, x, below)) {
    return;
  }

  // 2) Otherwise pile via the two diagonals below (random order, full spill).
  const leftFirst = Math.random() < 0.5;
  const firstDx = leftFirst ? -1 : 1;
  const secondDx = leftFirst ? 1 : -1;

  if (trySwap(x, y, x + firstDx, below)) {
    return;
  }
  trySwap(x, y, x + secondDx, below);
}

/**
 * WATER rule (GDD §5.2: "flows, seeks level, never piles").
 * Fall if possible, otherwise spread sideways so a column collapses to a flat
 * sheet rather than piling. Down-diagonals are tried before straight sideways so
 * water prefers to keep descending while it spreads. Left/right order is
 * randomised per cell so the sheet has no drift bias.
 *
 * NOTE on leveling vs. diffusion: this is the simple, robust local rule (the
 * GDD/PLAN one). It guarantees the two hard requirements — water never piles and
 * a column collapses to a flat sheet. Its only artifact is that a *truly
 * isolated* water cell on flat ground will slowly random-walk (it has air on
 * both sides, so each side is a valid swap). That reads as harmless shimmer for
 * MVP; true pressure-based leveling (a multi-cell flow scan) is deferred to the
 * flooding work in a later phase. A pressure gate (only flow when water is
 * directly above) was tried and rejected here because it makes water form a
 * stable *mound* — which violates "never piles".
 */
function updateWater(x: number, y: number): void {
  const below = y + 1;

  // 1) Fall straight down through any lighter, non-static cell (AIR).
  if (trySwap(x, y, x, below)) {
    return;
  }

  const leftFirst = Math.random() < 0.5;
  const dx1 = leftFirst ? -1 : 1;
  const dx2 = leftFirst ? 1 : -1;

  // 2) Blocked below → spread to a lower diagonal first (keeps water descending).
  if (trySwap(x, y, x + dx1, below) || trySwap(x, y, x + dx2, below)) {
    return;
  }

  // 3) Still blocked → flow straight sideways to seek its level (never piles).
  if (trySwap(x, y, x + dx1, y)) {
    return;
  }
  trySwap(x, y, x + dx2, y);
}

/**
 * Ignite a cell (GDD §5.2 / §7.3): set it to FIRE and seed its lifetime.
 *
 * THE single ignition path. FIRE has no structural integrity, so it REUSES its
 * `integrity` slot as a per-cell countdown seeded to FIRE_LIFETIME (see
 * updateFire for the aging/expiry side). Routing every ignition through here
 * keeps one place that knows the FIRE/lifetime invariant: fire spread (below),
 * and the player Ignite tool (next task) both call this so they can never get
 * out of sync. Bounds-safe via the grid set/setIntegrity helpers.
 *
 * NOTE: ignite does NOT touch the moved-guard — callers that need the freshly
 * lit cell to skip the current tick's scan (e.g. fire spread, to avoid a
 * same-tick ignition chain) flag `moved` themselves right after calling.
 */
export function ignite(x: number, y: number): void {
  set(x, y, FIRE);
  setIntegrity(x, y, FIRE_LIFETIME);
}

/**
 * FIRE rule (GDD §5.2 "spreads to flammable neighbours, rises; consumes fuel,
 * makes smoke" + §7.3 fire spread). A short-lived state machine — it must never
 * become an eternal flame.
 *
 * LIFETIME STORAGE: FIRE has no structural integrity, so we REUSE its slot in
 * the `integrity` array as a per-cell countdown. When a cell becomes FIRE its
 * slot is seeded to FIRE_LIFETIME (here on ignite, and by the player ignite
 * tool). Each tick we decrement it; at 0 the fire expires. The slot is cleared
 * to 0 when the cell stops being FIRE (ASH/SMOKE have no integrity), so the
 * reuse never leaks a stale value into a later structure placed in this cell.
 *
 * Per tick:
 *   1) Spread: each adjacent flammable cell (4 orthogonal + 4 diagonal) is
 *      ignited with chance FIRE_SPREAD_CHANCE — converted to FIRE, its lifetime
 *      seeded, and flagged moved so it ages from next tick (no same-tick chain).
 *   2) Age: decrement the countdown. On expiry → leave ASH, or with chance
 *      SMOKE_EMIT_CHANCE puff SMOKE instead (burned fuel = ash + some smoke).
 *
 * Note: the fire cell itself does not move (density 0), so it is never re-entered
 * by the bottom-up scan; aged-but-living fire needs no moved flag of its own.
 * Fire over AIR with no fuel still ages out — the countdown is unconditional.
 */
function updateFire(x: number, y: number): void {
  // 1) Spread to flammable neighbours (orthogonal + diagonal).
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= WORLD_W || ny < 0 || ny >= WORLD_H) {
        continue;
      }
      const n = idx(nx, ny);
      if (moved[n] || !isFlammable(material[n])) {
        continue;
      }
      if (Math.random() < FIRE_SPREAD_CHANCE) {
        ignite(nx, ny); // single ignition path (FIRE + seeded lifetime)
        moved[n] = 1; // freshly lit: age from next tick, no same-tick re-spread
      }
    }
  }

  // 2) Age the countdown; expire to ASH (or a SMOKE puff) when it runs out.
  const s = idx(x, y);
  const life = integrity[s];
  if (life <= 1) {
    if (Math.random() < SMOKE_EMIT_CHANCE) {
      material[s] = SMOKE;
    } else {
      material[s] = ASH;
    }
    integrity[s] = 0; // clear reused slot — ASH/SMOKE carry no integrity
    moved[s] = 1; // claim the cell so the new ASH/SMOKE isn't re-processed now
    return;
  }
  integrity[s] = life - 1;
}

/**
 * SMOKE/STEAM rule (GDD §5.2: "gas, rises, dissipates"). SMOKE doubles as steam.
 *
 * Gas is the mirror image of sand: it travels UP, not down. That makes the
 * moved-guard load-bearing — gas rises into rows the BOTTOM-UP scan has NOT yet
 * processed this tick, so without flagging both cells on every move a single gas
 * cell would be re-scanned higher up and skid several rows in one tick. We use a
 * gas-specific move (gasMove) that only enters AIR and flags BOTH cells, never
 * the generic trySwap (whose "strictly lighter target" test can't move SMOKE
 * into AIR — both are density 0).
 *
 * Order each tick:
 *   1) Dissipate with chance SMOKE_DISSIPATE → become AIR and stop (flag moved
 *      so nothing else touches this cell this tick).
 *   2) Rise straight up into AIR.
 *   3) Blocked → try the two up-diagonals in random order.
 *   4) Fully blocked above (under a ceiling) → drift sideways into AIR so a
 *      plume spreads out under stone instead of stalling.
 *
 * Gas has density 0 (≈ air), so the generic density-fall never picks it up and
 * heavier grains fall straight through it — that behaviour is untouched here.
 */
function updateGas(x: number, y: number): void {
  // 1) Dissipate: a fraction of the plume vanishes each tick (not conserved).
  if (Math.random() < SMOKE_DISSIPATE) {
    const s = idx(x, y);
    material[s] = AIR;
    moved[s] = 1; // Claim the cell so nothing re-processes the freed AIR.
    return;
  }

  const above = y - 1;

  // 2) Rise straight up into AIR.
  if (gasMove(x, y, x, above)) {
    return;
  }

  // 3) Blocked → up-diagonals in random per-cell order (no lateral bias).
  const leftFirst = Math.random() < 0.5;
  const dx1 = leftFirst ? -1 : 1;
  const dx2 = leftFirst ? 1 : -1;
  if (gasMove(x, y, x + dx1, above) || gasMove(x, y, x + dx2, above)) {
    return;
  }

  // 4) Under a ceiling → drift sideways into AIR so the plume spreads out.
  if (gasMove(x, y, x + dx1, y)) {
    return;
  }
  gasMove(x, y, x + dx2, y);
}

/**
 * Gas move (GDD §5.2): move the gas at (sx,sy) into (tx,ty) iff the target is
 * in-bounds, has NOT acted this tick, and is AIR. Unlike trySwap this does NOT
 * compare densities — SMOKE and AIR are both density 0, so a density test would
 * never let gas advance. Both cells are flagged moved so neither is re-processed
 * — this is what stops a rising gas cell (moving into a not-yet-scanned row)
 * from being picked up again and advancing multiple rows in one tick.
 * Returns true if the move happened.
 */
function gasMove(sx: number, sy: number, tx: number, ty: number): boolean {
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) {
    return false;
  }
  const t = idx(tx, ty);
  if (moved[t] || material[t] !== AIR) {
    return false;
  }
  const s = idx(sx, sy);
  material[t] = material[s];
  material[s] = AIR;
  moved[t] = 1;
  moved[s] = 1;
  return true;
}

/**
 * Density swap (GDD §5.2): move the grain at (sx,sy) into (tx,ty), swapping the
 * two cells, iff the target is in-bounds, has NOT acted this tick, and is a
 * LIGHTER, NON-STATIC material. Stone (static/255) is never displaced, so it is
 * what stops sand/water tunnelling through the floor. Both cells are flagged
 * moved so neither is re-processed this tick.
 *
 * The caller guarantees (sx,sy) is in-bounds and unmoved; we guard the target.
 * Returns true if the swap happened.
 */
function trySwap(sx: number, sy: number, tx: number, ty: number): boolean {
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) {
    return false;
  }
  const t = idx(tx, ty);
  if (moved[t]) {
    return false;
  }
  const target = material[t];
  // A faller may only displace AIR or a FLUID (water/blood) — NOT another powder
  // or solid. This lets powders sink through air and water while RESTING on each
  // other (piling) instead of stratifying by density like liquids. (Playtest:
  // sand spawned under dirt should NOT float to the top — two dry powders of
  // similar weight stay layered/mixed, they don't separate.) Static is never
  // displaceable.
  if (isStatic(target)) {
    return false;
  }
  if (target !== AIR && !isFluid(target)) {
    return false;
  }
  const s = idx(sx, sy);
  if (density(target) >= density(material[s])) {
    return false;
  }
  // Swap the two cells (handles both "fall into AIR" and "sink through WATER").
  material[t] = material[s];
  material[s] = target;
  moved[t] = 1;
  moved[s] = 1;
  return true;
}
