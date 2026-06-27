/**
 * engine/chunks.ts - Chunked / dirty-rect activity tracking (Phase 11, task 11-2).
 *
 * GDD 13 / App. B (Noita): the wide world + mobile budget are only viable if
 * the cellular update SKIPS regions that cannot change. We partition the grid
 * into CHUNK_SIZExCHUNK_SIZE chunks and, each tick, process ONLY the chunks that
 * had activity last tick (or were edited). A settled sand pile, a flat pool, an
 * empty sky - their chunks go inactive and are skipped entirely.
 *
 * BYTE-IDENTITY (the non-negotiable bar). The chunked scan must produce output
 * identical to a full grid scan. Two properties make that possible:
 *
 *  1. Deterministic positional RNG (task 11-1): every cell's random decision is
 *     simRand(x, y, tick, ...) - independent of how many other cells ran. So the
 *     SUBSET of cells we visit draws the same randoms as a full scan.
 *
 *  2. The DIRTY-RECT INVARIANT: "if a cell changes this tick, its chunk is
 *     active this tick." We guarantee it by waking a chunk (for NEXT tick) on
 *     EVERY cell change, AND - because a falling-sand change only propagates one
 *     cell per tick - also waking the neighbour chunk across a shared border when
 *     the changed cell sits on that border. A cell can only be made to move by a
 *     change within 1 cell of it (the cells it reads); that neighbour's change
 *     last tick therefore woke this cell's chunk. An interior change stays inside
 *     its own chunk (1-cell reach < CHUNK_SIZE), so only border changes spill to
 *     a neighbour chunk - exactly the Noita dirty-rect expansion. Given the
 *     invariant, a SKIPPED (inactive) chunk is provably a no-op this tick, so
 *     skipping it changes nothing.
 *
 * The movement scan in simulation.ts iterates active chunks in EXACT global
 * order (world-rows bottom-up, columns in the per-tick scan-flip direction) so
 * the relative order of every visited cell matches the full scan - the final
 * piece needed for byte-identity (two cells that interact are within 1 cell, so
 * same-row / adjacent-row order must be preserved).
 *
 * Data-oriented: two flat Uint8Array bitsets (this/next tick), no per-chunk
 * objects (GDD 13, AGENTS 4).
 */

import { WORLD_W, WORLD_H, CHUNK_SIZE } from '../config';

/** Chunk-grid dimensions. The bottom row is partial when WORLD_H % CHUNK_SIZE. */
export const CHUNK_COLS = Math.ceil(WORLD_W / CHUNK_SIZE);
export const CHUNK_ROWS = Math.ceil(WORLD_H / CHUNK_SIZE);
const CHUNK_COUNT = CHUNK_COLS * CHUNK_ROWS;

/**
 * Per-chunk "process this tick" / "process next tick" flags (0/1).
 * `beginTick()` swaps next->this and clears next. We deliberately INITIALISE
 * `activeNextTick` to all-active so the FIRST tick processes the whole world
 * (a full scan), letting worldgen / hand-seeded scenes settle before any chunk
 * is skipped (brief: "Initialize ALL chunks active for tick 0").
 */
let activeThisTick = new Uint8Array(CHUNK_COUNT);
let activeNextTick = new Uint8Array(CHUNK_COUNT);
activeNextTick.fill(1);

/**
 * Master switch (default ON in production). When OFF, simulation.ts runs the
 * original full grid scan and ignores the active sets - this is the REFERENCE
 * path the equivalence harness diffs the chunked path against.
 */
let chunkingEnabled = true;

export function setChunkingEnabled(b: boolean): void {
  chunkingEnabled = b;
}
export function isChunkingEnabled(): boolean {
  return chunkingEnabled;
}

/** Map a world coord to its chunk column / row. */
export function chunkColOf(x: number): number {
  return (x / CHUNK_SIZE) | 0;
}
export function chunkRowOf(y: number): number {
  return (y / CHUNK_SIZE) | 0;
}

/**
 * Wake the chunk containing (x, y) for NEXT tick - plus the neighbour chunk(s)
 * across any shared border the cell sits on (see the INVARIANT note above).
 * Called on EVERY cell-state change: moves/swaps (both endpoints), ignite, fire
 * aging/expiry, gas dissipate, reactions, gore fade, and all grid writes
 * (player edits, worldgen, breaching, body release). Bounds-safe.
 */
export function markCellActive(x: number, y: number): void {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
  const cc = (x / CHUNK_SIZE) | 0;
  const cr = (y / CHUNK_SIZE) | 0;
  const lx = x - cc * CHUNK_SIZE;
  const ly = y - cr * CHUNK_SIZE;
  // A change only reaches a neighbour CHUNK if it is on this chunk's border.
  // The world edge (x===WORLD_W-1 / y===WORLD_H-1) is also a "border" but its
  // out-of-range neighbour is simply skipped below.
  const dcMin = lx === 0 ? -1 : 0;
  const dcMax = lx === CHUNK_SIZE - 1 || x === WORLD_W - 1 ? 1 : 0;
  const drMin = ly === 0 ? -1 : 0;
  const drMax = ly === CHUNK_SIZE - 1 || y === WORLD_H - 1 ? 1 : 0;
  for (let dr = drMin; dr <= drMax; dr++) {
    const r = cr + dr;
    if (r < 0 || r >= CHUNK_ROWS) continue;
    const base = r * CHUNK_COLS;
    for (let dc = dcMin; dc <= dcMax; dc++) {
      const c = cc + dc;
      if (c < 0 || c >= CHUNK_COLS) continue;
      activeNextTick[base + c] = 1;
    }
  }
}

/** Flat-index variant for callers that already hold idx = y*WORLD_W + x. */
export function markIndexActive(i: number): void {
  const y = (i / WORLD_W) | 0;
  markCellActive(i - y * WORLD_W, y);
}

/**
 * Roll the activity window forward: chunks woken last tick become THIS tick's
 * work set; clear NEXT so this tick's changes can repopulate it. Called once at
 * the very start of step() (only when chunking is enabled).
 */
export function beginTick(): void {
  const tmp = activeThisTick;
  activeThisTick = activeNextTick;
  activeNextTick = tmp;
  activeNextTick.fill(0);
}

/** Is chunk (cc, cr) scheduled for processing THIS tick? */
export function isActiveThisTick(cc: number, cr: number): boolean {
  return activeThisTick[cr * CHUNK_COLS + cc] === 1;
}

/** Does chunk-row `cr` contain ANY active chunk? (cheap whole-row skip.) */
export function chunkRowHasActive(cr: number): boolean {
  const base = cr * CHUNK_COLS;
  for (let cc = 0; cc < CHUNK_COLS; cc++) {
    if (activeThisTick[base + cc] === 1) return true;
  }
  return false;
}

/** Number of chunks that WILL be processed this tick (perf instrumentation). */
export function activeThisTickCount(): number {
  let n = 0;
  for (let i = 0; i < CHUNK_COUNT; i++) n += activeThisTick[i];
  return n;
}

/** Total number of chunks in the world (for "settled vs all" perf reporting). */
export function chunkCount(): number {
  return CHUNK_COUNT;
}

/**
 * Reset all activity state (test helper). After this, the next tick processes
 * the whole world again (as at fresh module load).
 */
export function resetChunks(): void {
  activeThisTick.fill(0);
  activeNextTick.fill(1);
}
