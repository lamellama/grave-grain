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
  GORE_SETTLE_TICKS,
  GORE_AGE_FADE_PER_TICK,
  SIM_RNG_SEED,
  GROW_TICKS,
  GROW_JITTER,
  GROW_WATER_SPEEDUP,
  FOLIAGE_GROW_MAX_HEIGHT,
  FOLIAGE_INTEGRITY,
  WEATHER_SKY_ROW,
  RAIN_SPAWN_CHANCE,
  SNOW_SPAWN_CHANCE,
} from '../config';
import { material, integrity, idx, set, setIntegrity } from './grid';
import { reactions } from './reactions';
import { updateWeather, getWeather } from './weather';
import {
  markCellActive,
  markIndexActive,
  beginTick,
  isActiveThisTick,
  chunkRowHasActive,
  isChunkingEnabled,
  CHUNK_COLS,
  CHUNK_ROWS,
} from './chunks';
import { CHUNK_SIZE } from '../config';

// Re-export the chunking controls so tests/consumers have a single sim entry
// point (the equivalence harness flips chunking off→on through these).
export {
  setChunkingEnabled,
  isChunkingEnabled,
  activeThisTickCount,
  chunkCount,
  resetChunks,
} from './chunks';
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
  FOLIAGE,
  SAPLING,
  SNOW,
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
 * Deterministic per-(x, y, tick) RNG (task 11-1, GDD §13 / App. B).
 *
 * Replaces every per-cell `Math.random()` in the cellular update. Returns a
 * float in [0, 1) by avalanche-mixing the cell coords, the current `tick`, the
 * config seed, and a `salt` that distinguishes independent rolls at the SAME
 * cell/tick (e.g. "spill chance" vs "which diagonal first"). Because the result
 * depends ONLY on (x, y, tick, SIM_RNG_SEED, salt) — never on call order or how
 * many other cells were processed — the sim becomes a pure function of initial
 * state + tick. That is the precondition for the chunked scan (11-2): a scan
 * that SKIPS settled chunks draws the exact same randoms as a full scan, so the
 * two stay byte-identical.
 *
 * Mix: a small Math.imul integer hash (xmxmx-style avalanche) folding each input
 * in turn, then dividing the unsigned 32-bit result by 2^32. The distribution is
 * uniform in [0, 1), so every threshold test keeps its original semantics — only
 * the SOURCE of the randomness changes from global to per-cell-deterministic.
 */
export function simRand(x: number, y: number, salt: number): number {
  let h = SIM_RNG_SEED >>> 0;
  h = Math.imul(h ^ (x >>> 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (y >>> 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (tick >>> 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h ^ (salt >>> 0), 0x165667b1);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Distinct salt constants per random DECISION site (task 11-1). Two independent
 * rolls at the same cell/tick must use DIFFERENT salts so they aren't perfectly
 * correlated (e.g. dirt rolls its spill chance AND its left/right order). The
 * salt is mixed into the hash, so even adjacent values give independent streams;
 * the spacing below is only to keep the constants distinct and self-documenting.
 */
const SALT_DIAG = 1; // powder L/R diagonal order (sand/dirt/ash/flesh/bone)
const SALT_SPILL = 2; // dirt: whether to attempt the diagonal spill at all
const SALT_WATER = 3; // water/blood: L/R flow order
const SALT_GAS_DISS = 4; // smoke/steam: dissipate-to-air roll
const SALT_GAS_DIAG = 5; // smoke/steam: up-diagonal / drift L/R order
const SALT_SMOKE_EMIT = 6; // fire expiry: puff SMOKE vs leave ASH
const SALT_GROW = 7; // sapling: per-cell growth-countdown seeding jitter (GDD §9)
// Fire spread rolls ONCE PER NEIGHBOUR, so the per-neighbour index (0..8) is
// added to this base — each of the 8 neighbour rolls gets its own salt and so
// its own independent stream (no correlation between neighbours at one cell).
const SALT_FIRE_SPREAD = 100;
// Weather sky-spawn roll (GDD §10, Beyond T3): per sky-cell precipitation spawn
// in applyWeather(). 200 is well clear of every other salt above (1–7, 100–108)
// AND of reactions.ts's SALT_SNOW_MELT (300), so no two rolls at the same
// (x, y, tick) ever share a stream.
const SALT_WEATHER_SPAWN = 200;

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

  // Roll the dirty-rect window forward (Phase 11): chunks woken last tick become
  // THIS tick's work set. Done BEFORE reactions so it too can skip settled
  // chunks. When chunking is OFF (the equivalence reference path) we leave the
  // active sets untouched and fall through to the original full grid scan.
  // Weather (GDD §10, Beyond T3) runs at the TOP of the tick, BEFORE beginTick.
  //  - updateWeather advances the global rain/snow/clear state machine once per
  //    tick. It is pure (tick, seed) and touches no chunks, so it produces the
  //    SAME state on the chunked and full-scan paths.
  //  - applyWeather then does a deterministic, NON-chunk-gated sweep of the sky
  //    row, spawning WATER (rain) / SNOW (snow) into AIR cells. It marks every
  //    spawned cell active. We run it BEFORE beginTick on purpose: markCellActive
  //    sets the NEXT-tick set, and beginTick swaps that into THIS tick's work
  //    set — so a spawned cell's chunk is processed THIS tick, exactly as the
  //    full scan visits row 0 this tick. (Spawning after beginTick would defer
  //    the fall by one tick on the chunked path only → divergence.)
  updateWeather(tick);
  applyWeather();

  if (isChunkingEnabled()) {
    beginTick();
  }

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

  if (isChunkingEnabled()) {
    chunkedScan();
  } else {
    fullScan();
  }

  // Mobile gore budget (task 10-8, GDD §13): keep loose body-debris bounded so
  // it can't accumulate forever and sink the framerate. Runs AFTER the movement
  // scan so it never interferes with fall/settle/no-tunnel this tick.
  sweepGore();

  tick++;
}

/**
 * Deterministic sky-spawn pass (GDD §10, Beyond T3): precipitation enters the
 * world from the top row. Runs EVERY tick, UNCONDITIONALLY over the full sky row
 * (never chunk-gated) so the chunked and full-scan paths spawn byte-identically.
 *
 * For each x at WEATHER_SKY_ROW that is AIR, roll the per-cell deterministic
 * simRand (NOT Math.random) with SALT_WEATHER_SPAWN: under rain, below
 * RAIN_SPAWN_CHANCE → WATER; under snow, below SNOW_SPAWN_CHANCE → SNOW; under
 * clear, nothing. The spawned cell is left UNCLAIMED in the moved-guard and its
 * chunk woken, so the normal fluid/powder movement scan lets it fall this tick
 * (no special-case fall here — brief requirement).
 *
 * DETERMINISM/EQUIVALENCE: the only randomness is simRand(x, y, tick, salt), a
 * pure function of position+tick+seed. We touch only AIR cells and write only
 * that cell, so the pass is order-independent and identical regardless of
 * chunking.
 */
function applyWeather(): void {
  const w = getWeather();
  if (w === 'clear') return; // clear sky spawns nothing
  const spawn = w === 'rain' ? WATER : SNOW;
  const chance = w === 'rain' ? RAIN_SPAWN_CHANCE : SNOW_SPAWN_CHANCE;
  const y = WEATHER_SKY_ROW;
  const base = y * WORLD_W;
  for (let x = 0; x < WORLD_W; x++) {
    const i = base + x;
    if (material[i] !== AIR) continue; // only seed empty sky
    if (simRand(x, y, SALT_WEATHER_SPAWN) < chance) {
      material[i] = spawn;
      integrity[i] = 0; // WATER/SNOW carry no integrity (clear any stale slot)
      markCellActive(x, y); // wake the chunk so the chunked scan sees the spawn
    }
  }
}

/**
 * Original FULL grid scan (the byte-identical REFERENCE, used when chunking is
 * OFF). Bottom row → top row, columns flipped per tick to kill lateral bias
 * (GDD App. B). Every cell is visited every tick.
 */
function fullScan(): void {
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
}

/**
 * CHUNKED movement scan (Phase 11) — visits ONLY active chunks but in the EXACT
 * same global order as fullScan, so its output is byte-identical.
 *
 * Order is the crux. Two cells that can interact are within 1 cell of each
 * other, so byte-identity requires preserving their relative visit order. We
 * therefore iterate strictly by world-row, bottom-up (chunk-rows cover disjoint
 * world-row ranges, so descending chunk-rows then descending world-rows within
 * each IS global bottom-up), and within each world-row we visit the active
 * chunk-columns in the per-tick scan-flip direction, walking each chunk's cells
 * in that same direction. The cells we visit are thus exactly the full scan's
 * order with the (provably no-op) inactive-chunk cells removed.
 *
 * A whole chunk-row with no active chunk is skipped in one test (skips 32 world
 * rows). The dirty-rect invariant (chunks.ts) guarantees every cell that changes
 * this tick lives in an active chunk, so skipping the rest is a true no-op.
 */
function chunkedScan(): void {
  const leftToRight = (tick & 1) === 0;
  for (let cr = CHUNK_ROWS - 1; cr >= 0; cr--) {
    if (!chunkRowHasActive(cr)) continue; // skip this chunk-row's 32 world rows
    const yTop = cr * CHUNK_SIZE;
    const yBot = Math.min(yTop + CHUNK_SIZE, WORLD_H) - 1;
    for (let y = yBot; y >= yTop; y--) {
      if (leftToRight) {
        for (let cc = 0; cc < CHUNK_COLS; cc++) {
          if (!isActiveThisTick(cc, cr)) continue;
          const x0 = cc * CHUNK_SIZE;
          const x1 = Math.min(x0 + CHUNK_SIZE, WORLD_W);
          for (let x = x0; x < x1; x++) updateCell(x, y);
        }
      } else {
        for (let cc = CHUNK_COLS - 1; cc >= 0; cc--) {
          if (!isActiveThisTick(cc, cr)) continue;
          const x0 = cc * CHUNK_SIZE;
          const x1 = Math.min(x0 + CHUNK_SIZE, WORLD_W);
          for (let x = x1 - 1; x >= x0; x--) updateCell(x, y);
        }
      }
    }
  }
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

/**
 * Separate rolling cursor for the under-cap AGE trickle (task 11-3). Kept apart
 * from `fadeCursor` so the two fades never fight over a position; in practice
 * they never run on the same tick (the over-cap fade resets the settle clock).
 */
let ageFadeCursor = 0;

/**
 * Global "settle clock" for the age/settle trickle (task 11-3, GDD §13).
 * APPROXIMATION of per-cell age (which we cannot store — FIRE already reuses the
 * integrity slot): this counts how many consecutive ticks the loose-debris field
 * has been QUIESCENT — i.e. under MAX_GORE_CELLS AND unchanged since the last
 * recount (no fresh gore from combat, no scene reset). It advances while the
 * field sits still and RESETS to 0 the instant the field is over budget or its
 * recount disagrees with our predicted running count (fresh gore arrived / the
 * scene was edited). Once it reaches GORE_SETTLE_TICKS the field is "old" and the
 * trickle gently AIR-ifies a few debris cells per tick so the battlefield
 * self-cleans for readability — even while under the cap.
 */
let goreSettleAge = 0;

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
    // External-change detection (task 11-3): our running `goreCount` is already
    // decremented by every cell WE fade, so a recount that DISAGREES with it
    // means the field changed outside the fade — fresh gore from combat, or a
    // scene reset/edit. Either way the field is no longer "settled", so restart
    // the age clock. This is what keeps a freshly-churned battlefield from being
    // instantly aged out (and keeps the trickle out of the just-reset gore
    // scenes the cap test relies on).
    if (n !== goreCount) goreSettleAge = 0;
    goreCount = n;
  }

  // -------------------------------------------------------------------------
  // Over-cap FAST fade (Phase 10 — unchanged). Being over budget is the
  // opposite of "settled", so hold the age clock at 0 while we drain.
  // -------------------------------------------------------------------------
  if (goreCount > MAX_GORE_CELLS) {
    goreSettleAge = 0;
    const total = material.length;
    let faded = 0;
    let scanned = 0;
    while (faded < GORE_FADE_PER_TICK && scanned < total) {
      if (isLooseDebris(material[fadeCursor])) {
        material[fadeCursor] = AIR;
        integrity[fadeCursor] = 0; // clear any reused slot; AIR carries none
        markIndexActive(fadeCursor); // gore→AIR is a change → wake the chunk (P11)
        faded++;
      }
      fadeCursor++;
      if (fadeCursor >= total) {
        fadeCursor = 0;
      }
      scanned++;
    }
    goreCount -= faded;
    return;
  }

  // -------------------------------------------------------------------------
  // Under-cap AGE/SETTLE trickle (task 11-3, GDD §13). Below the cap the field
  // is "settled"; once it has sat quiescent for GORE_SETTLE_TICKS, gently
  // trickle-fade old debris so the battlefield self-cleans for readability — a
  // slow GORE_AGE_FADE_PER_TICK, never a snap. Same GATE invariants as the
  // over-cap fade: ONLY loose FLESH/BONE/BLOOD → AIR; terrain/structure and live
  // sprites are never touched.
  // -------------------------------------------------------------------------
  if (goreCount <= 0) {
    goreSettleAge = 0; // nothing to age — keep the clock cold
    return;
  }
  goreSettleAge++;
  if (goreSettleAge < GORE_SETTLE_TICKS) {
    return; // not old enough yet — leave the settled debris be
  }

  const total = material.length;
  let faded = 0;
  let scanned = 0;
  while (faded < GORE_AGE_FADE_PER_TICK && scanned < total) {
    if (isLooseDebris(material[ageFadeCursor])) {
      material[ageFadeCursor] = AIR;
      integrity[ageFadeCursor] = 0; // clear any reused slot; AIR carries none
      markIndexActive(ageFadeCursor); // gore→AIR is a change → wake the chunk (P11)
      faded++;
    }
    ageFadeCursor++;
    if (ageFadeCursor >= total) {
      ageFadeCursor = 0;
    }
    scanned++;
  }
  // Subtract our own fades so the next recount still agrees (no false reset).
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
  } else if (m === SAPLING) {
    updateSapling(x, y);
  } else if (m === SNOW) {
    updateSnow(x, y);
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
  const leftFirst = simRand(x, y, SALT_DIAG) < 0.5;
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
 * Is any of the four orthogonal neighbours of (x, y) WATER? (GDD §9 "water
 * accelerates growth".) A bounds-safe grid query — no randomness, so it is
 * chunk-equivalence-safe.
 */
function waterAdjacent(x: number, y: number): boolean {
  return (
    (x > 0 && material[idx(x - 1, y)] === WATER) ||
    (x < WORLD_W - 1 && material[idx(x + 1, y)] === WATER) ||
    (y > 0 && material[idx(x, y - 1)] === WATER) ||
    (y < WORLD_H - 1 && material[idx(x, y + 1)] === WATER)
  );
}

/**
 * SAPLING rule (post-MVP backlog, playtest v0.6 #G; GDD §9 ecology). A planted
 * seed that does NOT fall — it stays pinned and MATURES into FOLIAGE over time,
 * sprouting a new sapling above so a plant grows UPWARD into a bush.
 *
 * GROWTH TIMER via the integrity slot: exactly the FIRE-lifetime trick. A
 * sapling has no structural integrity, so it REUSES its `integrity` slot as a
 * per-cell countdown. integrity == 0 means "unseeded" (e.g. just placed by the
 * Plant tool, whose placeMaterial leaves a hasIntegrity:false cell at 0): on the
 * first visit we seed the countdown to GROW_TICKS plus a small simRand jitter so
 * neighbouring saplings don't mature in lockstep. Each tick we decrement it
 * (faster beside WATER — GDD §9), and rewrite the slot, which WAKES the chunk —
 * so the chunked/dirty-rect scan keeps visiting this cell every tick and stays
 * byte-identical to a full scan (the chunk-equivalence guarantee).
 *
 * DETERMINISM: the ONLY randomness is the seeding jitter, drawn from
 * simRand(x, y, SALT_GROW) (NOT Math.random) — a pure function of
 * (x, y, tick, seed). The decrement, the water-speedup and the maturation are
 * deterministic grid queries. So a chunked run draws the exact same jitter as a
 * full scan and the two remain byte-identical.
 *
 * Per tick:
 *   1) Seed the countdown if unseeded (integrity == 0).
 *   2) Decrement by 1, or GROW_WATER_SPEEDUP beside water.
 *   3) On expiry: if the cell below is soil (DIRT) or already-grown FOLIAGE,
 *      mature into FOLIAGE and (if there is AIR above and the foliage column is
 *      under FOLIAGE_GROW_MAX_HEIGHT) sprout a fresh sapling above. If there is
 *      NO soil below (a floating sapling) it WITHERS to AIR instead of growing —
 *      so a sapling planted in mid-air can never build an infinite tower.
 */
function updateSapling(x: number, y: number): void {
  const s = idx(x, y);
  let g = integrity[s];

  // 1) Seed an unseeded countdown (GROW_TICKS + deterministic simRand jitter).
  if (g === 0) {
    g = GROW_TICKS + Math.floor(simRand(x, y, SALT_GROW) * GROW_JITTER);
  }

  // 2) Decrement — water accelerates growth (GDD §9).
  const dec = waterAdjacent(x, y) ? GROW_WATER_SPEEDUP : 1;

  // 3) Expiry → mature or wither.
  if (g <= dec) {
    growSapling(x, y);
    return;
  }

  integrity[s] = g - dec;
  // Per-tick countdown change → keep the chunk live so the chunked scan keeps
  // visiting this sapling (Phase 11 dirty-rect, same as FIRE's ageing).
  markCellActive(x, y);
}

/**
 * Mature a sapling at (x, y) (GDD §9). The countdown has expired: if the cell is
 * standing on soil it becomes FOLIAGE and may sprout a new sapling above;
 * otherwise (no soil below) it withers to AIR. Called only from updateSapling.
 */
function growSapling(x: number, y: number): void {
  const s = idx(x, y);

  // Validity: a sapling grows only on suitable soil — DIRT directly below, or
  // already-grown FOLIAGE (so the plant stacks upward). Out-of-bounds below
  // (bottom row) counts as no soil. (GDD §9 "grow over time on suitable soil".)
  const belowM = y < WORLD_H - 1 ? material[idx(x, y + 1)] : AIR;
  const onSoil = belowM === DIRT || belowM === FOLIAGE;

  if (!onSoil) {
    // No soil → wither (bounded; a floating sapling never towers — Done-when #3).
    material[s] = AIR;
    integrity[s] = 0; // AIR carries no integrity / growth timer
    moved[s] = 1; // claim the cell so the freed AIR isn't re-processed this tick
    markCellActive(x, y); // SAPLING→AIR is a change → wake the chunk (P11)
    return;
  }

  // Mature this cell into FOLIAGE (seed FOLIAGE's baseIntegrity so it is
  // choppable/breachable exactly like worldgen-grown foliage).
  material[s] = FOLIAGE;
  integrity[s] = FOLIAGE_INTEGRITY;
  markCellActive(x, y);

  // Sprout a new sapling directly above, if there is room and the plant is still
  // under its max height (GDD §9 grows upward; capped so it never towers).
  const above = y - 1;
  if (above < 0) return;
  const a = idx(x, above);
  if (material[a] !== AIR) return;

  // Count the contiguous FOLIAGE column below this newly-matured cell to measure
  // the plant's height (this cell now counts as 1). Stop at the cap.
  let height = 1;
  for (let yy = y + 1; yy < WORLD_H && material[idx(x, yy)] === FOLIAGE; yy++) {
    height++;
  }
  if (height >= FOLIAGE_GROW_MAX_HEIGHT) return; // capped — top stage, no sprout

  // Place the new sapling above. Leave its integrity at 0 (auto-seeded on its
  // first visit) and CLAIM it in the moved-guard so it does NOT age this tick.
  // This is the cross-chunk-safe pattern FIRE uses on spread: the full scan
  // (which would otherwise visit the cell again higher in this same pass) skips
  // it, matching the chunked scan, so the two stay byte-identical. markCellActive
  // wakes its chunk for NEXT tick, when it begins its own countdown.
  material[a] = SAPLING;
  integrity[a] = 0;
  moved[a] = 1;
  markCellActive(x, above);
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
  const leftFirst = simRand(x, y, SALT_DIAG) < 0.5;
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
  if (simRand(x, y, SALT_SPILL) >= DIRT_SPILL_CHANCE) {
    return;
  }

  // Same random L/R order and displacement primitive as sand.
  const leftFirst = simRand(x, y, SALT_DIAG) < 0.5;
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
  const leftFirst = simRand(x, y, SALT_DIAG) < 0.5;
  const firstDx = leftFirst ? -1 : 1;
  const secondDx = leftFirst ? 1 : -1;

  if (trySwap(x, y, x + firstDx, below)) {
    return;
  }
  trySwap(x, y, x + secondDx, below);
}

/**
 * SNOW rule (GDD §10, Beyond T3): snow is a LIGHT POWDER (density 2) that falls
 * from the sky and accumulates into stable piles. Its movement contract is a
 * byte-for-byte copy of ASH's powder fall (same density, same no-tunnel / moved
 * discipline via trySwap): fall straight down through anything lighter and
 * non-static, else spill into the two diagonals below in deterministic per-cell
 * random order (SALT_DIAG) so it settles at an angle of repose. Like ash it
 * never flows sideways, so an accumulated snow drift holds its shape. Melt near
 * heat (→ WATER) is an adjacency reaction handled in reactions.ts, not here.
 */
function updateSnow(x: number, y: number): void {
  const below = y + 1;

  // 1) Fall straight down through any lighter, non-static cell (AIR or WATER).
  if (trySwap(x, y, x, below)) {
    return;
  }

  // 2) Otherwise pile via the two diagonals below (random order, full spill).
  const leftFirst = simRand(x, y, SALT_DIAG) < 0.5;
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

  const leftFirst = simRand(x, y, SALT_WATER) < 0.5;
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
      // One roll PER NEIGHBOUR: fold the neighbour index (0..8) into the salt so
      // each of the up-to-8 neighbour rolls is an independent stream (task 11-1).
      const ni = (dy + 1) * 3 + (dx + 1);
      if (simRand(x, y, SALT_FIRE_SPREAD + ni) < FIRE_SPREAD_CHANCE) {
        ignite(nx, ny); // single ignition path (FIRE + seeded lifetime)
        moved[n] = 1; // freshly lit: age from next tick, no same-tick re-spread
      }
    }
  }

  // 2) Age the countdown; expire to ASH (or a SMOKE puff) when it runs out.
  const s = idx(x, y);
  const life = integrity[s];
  if (life <= 1) {
    if (simRand(x, y, SALT_SMOKE_EMIT) < SMOKE_EMIT_CHANCE) {
      material[s] = SMOKE;
    } else {
      material[s] = ASH;
    }
    integrity[s] = 0; // clear reused slot — ASH/SMOKE carry no integrity
    moved[s] = 1; // claim the cell so the new ASH/SMOKE isn't re-processed now
    markCellActive(x, y); // FIRE→ASH/SMOKE is a change → keep the chunk live.
    return;
  }
  integrity[s] = life - 1;
  // FIRE ages every tick even when nothing around it changes (its reused
  // integrity slot counts down). That is a per-tick state change, so the fire
  // must keep its OWN chunk active until it expires — otherwise the chunked scan
  // would stop visiting it and it would never burn out (Phase 11). Writing the
  // integrity directly (not via setIntegrity) means we wake the chunk here.
  markCellActive(x, y);
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
  if (simRand(x, y, SALT_GAS_DISS) < SMOKE_DISSIPATE) {
    const s = idx(x, y);
    material[s] = AIR;
    moved[s] = 1; // Claim the cell so nothing re-processes the freed AIR.
    markCellActive(x, y); // SMOKE→AIR is a change → keep the chunk live (P11).
    return;
  }

  const above = y - 1;

  // 2) Rise straight up into AIR.
  if (gasMove(x, y, x, above)) {
    return;
  }

  // 3) Blocked → up-diagonals in random per-cell order (no lateral bias).
  const leftFirst = simRand(x, y, SALT_GAS_DIAG) < 0.5;
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
  // Both endpoints changed → wake their chunks (+ border neighbours) for next
  // tick so the chunked scan keeps following the gas (Phase 11 dirty-rect).
  markCellActive(sx, sy);
  markCellActive(tx, ty);
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
  // Both endpoints changed → wake their chunks (+ border neighbours) for next
  // tick so a grain crossing a chunk boundary keeps its destination chunk live
  // (Phase 11 dirty-rect invariant).
  markCellActive(sx, sy);
  markCellActive(tx, ty);
  return true;
}
