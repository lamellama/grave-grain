declare const process: any;
/**
 * de-dualedge.test.ts — Beyond item 6: dual-edge spawns (GDD §7.1 "one or
 * both map edges", §12.2 zombie-edge count knob).
 *
 * Done-when:
 *   1. Every spawn of waves BEFORE ZOMBIE_DUAL_EDGE_FROM_WAVE comes from the
 *      single configured ZOMBIE_SPAWN_EDGE column (the pre-item behaviour,
 *      unchanged - early waves teach the single-front game).
 *   2. From wave ZOMBIE_DUAL_EDGE_FROM_WAVE on, spawns hit BOTH edge columns
 *      (the 50/50 flank roll).
 *   3. Wave counting, escalating sizes, and the win signal are untouched.
 */

import { createWaveState, updateWaves, allWavesCleared } from '../src/game/waves';
import { material, idx } from '../src/engine/grid';
import { STONE, AIR } from '../src/engine/materials';
import {
  WORLD_W,
  WAVE_INTERVAL,
  WAVE_SIZE_START,
  WAVE_SIZE_GROWTH,
  WIN_WAVES,
  ZOMBIE_SPAWN_EDGE,
  ZOMBIE_DUAL_EDGE_FROM_WAVE,
} from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

// Deterministic Math.random (LCG) - same pattern as r9-zombies.
function seedRandom(seed: number): void {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Flat stone world so columnSurfaceY finds a surface at BOTH edges.
material.fill(AIR);
for (let x = 0; x < WORLD_W; x++)
  for (let y = 150; y < 170; y++) material[idx(x, y)] = STONE;

const INSET = 4; // ZOMBIE_SPAWN_INSET (module-private; pinned here)
const PRIMARY_X = ZOMBIE_SPAWN_EDGE === 'left' ? INSET : WORLD_W - 1 - INSET;
const OTHER_X = ZOMBIE_SPAWN_EDGE === 'left' ? WORLD_W - 1 - INSET : INSET;

check(
  ZOMBIE_DUAL_EDGE_FROM_WAVE > 1 && ZOMBIE_DUAL_EDGE_FROM_WAVE <= WIN_WAVES,
  `dual-edge wave gate inside the campaign (1 < ${ZOMBIE_DUAL_EDGE_FROM_WAVE} <= ${WIN_WAVES})`,
);

// Run the full campaign, recording every spawn with the wave that sent it.
seedRandom(0xd0a1);
const state = createWaveState();
const spawns: Array<{ wave: number; x: number }> = [];
for (
  let t = 0;
  t < WAVE_INTERVAL * (WIN_WAVES + 8) &&
  !(state.waveNumber >= WIN_WAVES && state.pendingThisWave === 0);
  t++
) {
  // aliveZombieCount 0: every spawn "dies" instantly, so the cap never defers.
  for (const z of updateWaves(state, 0)) {
    spawns.push({ wave: state.waveNumber, x: Math.round(z.body.x) });
  }
}

// 3. Escalation untouched: every wave sent its full roster.
for (let w = 1; w <= WIN_WAVES; w++) {
  const size = WAVE_SIZE_START + WAVE_SIZE_GROWTH * (w - 1);
  const got = spawns.filter(s => s.wave === w).length;
  check(got === size, `3: wave ${w} sent its full roster (${got}/${size})`);
}

// 1. Pre-gate waves: single configured edge only.
const early = spawns.filter(s => s.wave < ZOMBIE_DUAL_EDGE_FROM_WAVE);
check(early.length > 0, '1: early waves produced spawns');
check(
  early.every(s => s.x === PRIMARY_X),
  `1: every pre-gate spawn at the configured edge x=${PRIMARY_X}`,
);

// 2. Gate onward: both edges seen.
const late = spawns.filter(s => s.wave >= ZOMBIE_DUAL_EDGE_FROM_WAVE);
const lateXs = new Set(late.map(s => s.x));
console.log(
  `   late spawns: ${late.length} across edges [${[...lateXs].join(', ')}]`,
);
check(
  lateXs.has(PRIMARY_X) && lateXs.has(OTHER_X),
  `2: waves ${ZOMBIE_DUAL_EDGE_FROM_WAVE}+ hit BOTH edges (${PRIMARY_X} and ${OTHER_X})`,
);
check(
  late.every(s => s.x === PRIMARY_X || s.x === OTHER_X),
  '2: late spawns only ever at the two edge columns',
);

// 3b. Win signal: all waves launched + roster spawned + none alive -> cleared.
check(
  allWavesCleared(state, 0),
  '3: allWavesCleared once every wave launched and roster empty',
);

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: early waves keep the single configured front; from wave ' +
    ZOMBIE_DUAL_EDGE_FROM_WAVE +
    ' spawns flank from both edges; wave sizes and the win signal unchanged. ALL PASS',
);
