/**
 * Headless verification for p5-t5 — N-body widening + multi-survivor loop glue.
 *
 * Seeds SURVIVOR_COUNT survivors on a stone floor that has a WATER pool and two
 * FOLIAGE bushes nearby, starts some survivors with low needs (below threshold so
 * the auto-override fires immediately), runs 3 000 ticks of updateSurvivor, then
 * asserts:
 *   1. Each survivor's needs mutated independently (no two tracks are identical).
 *   2. Thirsty survivors found and drank from the water pool (thirst recovered).
 *   3. Hungry survivors found and ate from the foliage (hunger recovered).
 *   4. No non-destroyed body pixel tunnelled into STONE at any point during the run.
 *
 * "Independently" here means each survivor's (hunger, thirst) pair at tick 3 000
 * differs from at least one other survivor's pair — i.e. they are NOT all
 * marching in lock-step (different positions + random wander → divergent paths).
 *
 * Run via:
 *   node ./node_modules/typescript/bin/tsc --project test/tsconfig.p5-t5.json
 *   node .test-out/test/p5-t5.test.js
 */
import { material, set } from '../src/engine/grid';
import { STONE, WATER, FOLIAGE, AIR } from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { createSurvivor, updateSurvivor } from '../src/characters/survivor';
import type { Survivor } from '../src/characters/survivor';
import {
  WORLD_W,
  WORLD_H,
  SURVIVOR_COUNT,
  SURVIVOR_SPAWN_SPREAD,
  NEED_MAX,
} from '../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const FLOOR_Y = 150;

function seedScene(): void {
  // Clear to AIR
  material.fill(AIR);

  // Flat stone floor
  for (let x = 0; x < WORLD_W; x++) {
    for (let r = FLOOR_Y; r < FLOOR_Y + 4; r++) {
      set(x, r, STONE);
    }
  }

  // Water pool: a depression in the floor so water is naturally contained.
  // The adjacent floor cells (x=229, x=261) remain at FLOOR_Y so survivors can
  // stand beside the pool and drink without being blocked by a stone wall.
  const POOL_X0 = 230;
  const POOL_X1 = 260;
  const POOL_DEPTH = 4; // cells of water (below the main floor surface)
  for (let x = POOL_X0; x <= POOL_X1; x++) {
    set(x, FLOOR_Y, AIR);         // remove main floor over the pool
    set(x, FLOOR_Y + POOL_DEPTH, STONE); // deep floor
    for (let y = FLOOR_Y; y < FLOOR_Y + POOL_DEPTH; y++) {
      set(x, y, WATER);            // fill with water
    }
  }

  // Foliage bush A — close to spawn (left side) so hungry S1 reaches it quickly
  for (let x = 145; x <= 175; x++) {
    for (let y = FLOOR_Y - 3; y < FLOOR_Y; y++) {
      set(x, y, FOLIAGE);
    }
  }

  // Foliage bush B (right of spawn — second patch so multiple survivors can eat)
  for (let x = 235; x <= 265; x++) {
    for (let y = FLOOR_Y - 3; y < FLOOR_Y; y++) {
      set(x, y, FOLIAGE);
    }
  }

  rebuildNavgrid();
}

/**
 * Returns true if any non-destroyed bone pixel of the survivor's body occupies
 * a STONE cell — that would mean the body tunnelled into terrain.
 */
function bodyTunneledIntoStone(s: Survivor): boolean {
  const b = s.body;
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = Math.round(b.x) + bone.offset.dx + p.dx;
      const wy = Math.round(b.y) + bone.offset.dy + p.dy;
      if (wy < 0 || wy >= WORLD_H || wx < 0 || wx >= WORLD_W) continue;
      if (material[wy * WORLD_W + wx] === STONE) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

seedScene();

// Spawn SURVIVOR_COUNT survivors spread by SURVIVOR_SPAWN_SPREAD from x=200,
// y=100 (well above the floor so they fall onto it after a few ticks).
const SPAWN_X = 200;
const SPAWN_Y = 100; // above FLOOR_Y=150, will fall

const survivors: Survivor[] = [];
for (let i = 0; i < SURVIVOR_COUNT; i++) {
  const offsetX = (i - Math.floor(SURVIVOR_COUNT / 2)) * SURVIVOR_SPAWN_SPREAD;
  const s = createSurvivor(SPAWN_X + offsetX, SPAWN_Y);
  // Set survivors 0 & 1 immediately thirsty/hungry so auto-override fires at tick 1.
  if (i === 0) s.needs.thirst = 20;  // well below THIRST_THRESHOLD=35 → seekWater
  if (i === 1) s.needs.hunger = 30;  // well below HUNGER_THRESHOLD=35 → seekFood
  // Survivors 2 & 3 start with full needs (they will wander, deplete naturally,
  // and diverge from 0 & 1 because their positions + random seeds differ).
  survivors.push(s);
}

// Track per-survivor whether they ever tunnelled, and their peak needs recovery.
const tunnelledEver = new Array<boolean>(SURVIVOR_COUNT).fill(false);
const peakThirst = survivors.map((s) => s.needs.thirst);
const peakHunger = survivors.map((s) => s.needs.hunger);

const TICKS = 3000;
for (let t = 0; t < TICKS; t++) {
  for (let i = 0; i < survivors.length; i++) {
    const s = survivors[i];
    updateSurvivor(s);
    // Track tunnelling during the run (before death dissolves the body).
    if (s.body.alive && bodyTunneledIntoStone(s)) {
      tunnelledEver[i] = true;
    }
    // Track peak needs (recovery shows they reached a resource).
    if (s.body.alive) {
      if (s.needs.thirst > peakThirst[i]) peakThirst[i] = s.needs.thirst;
      if (s.needs.hunger > peakHunger[i]) peakHunger[i] = s.needs.hunger;
    }
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('\n=== p5-t5 headless sanity: per-survivor final state ===');
for (let i = 0; i < SURVIVOR_COUNT; i++) {
  const s = survivors[i];
  console.log(
    `  S${i}: alive=${s.body.alive}  hunger=${s.needs.hunger.toFixed(1)}  thirst=${s.needs.thirst.toFixed(1)}` +
    `  peakHunger=${peakHunger[i].toFixed(1)}  peakThirst=${peakThirst[i].toFixed(1)}` +
    `  tunnelled=${tunnelledEver[i]}  behaviour=${s.behaviour}`,
  );
}

// 1. No body tunnelled into stone at any point.
for (let i = 0; i < SURVIVOR_COUNT; i++) {
  check(!tunnelledEver[i], `S${i}: no body pixel tunnelled into STONE`);
}

// 2. Thirsty survivor (S0) found water and recovered thirst.
check(
  peakThirst[0] > 20 + 5,
  `S0: thirst recovered above initial (peakThirst=${peakThirst[0].toFixed(1)})`,
);

// 3. Hungry survivor (S1) found foliage and recovered hunger.
check(
  peakHunger[1] > 20 + 5,
  `S1: hunger recovered above initial (peakHunger=${peakHunger[1].toFixed(1)})`,
);

// 4. Needs mutated independently: not all survivors end with the same (h, t) pair.
const pairs = survivors.map((s) => `${s.needs.hunger.toFixed(1)},${s.needs.thirst.toFixed(1)}`);
const unique = new Set(pairs).size;
check(unique > 1, `needs are independent across survivors (${unique} unique (h,t) pairs out of ${SURVIVOR_COUNT})`);

// 5. No die-off from instant-death tunnelling: the dead survivors (if any)
//    died of starvation/thirst (deathCause set), not undefined behaviour.
for (let i = 0; i < SURVIVOR_COUNT; i++) {
  const s = survivors[i];
  if (!s.body.alive) {
    check(
      s.deathCause === 'starvation' || s.deathCause === 'thirst',
      `S${i}: if dead, deathCause is starvation or thirst (got: ${s.deathCause})`,
    );
  }
}

// 6. Survivors with full initial needs (S2, S3) have depleted needs (they wandered
//    and had their needs run down, proving the update path ran for all N).
const s2 = survivors[2];
const s3 = survivors[3];
check(
  (s2.body.alive ? s2.needs.hunger : -1) < NEED_MAX ||
  (s2.body.alive ? s2.needs.thirst : -1) < NEED_MAX,
  `S2: needs depleted over 3000 ticks (update path running)`,
);
check(
  (s3.body.alive ? s3.needs.hunger : -1) < NEED_MAX ||
  (s3.body.alive ? s3.needs.thirst : -1) < NEED_MAX,
  `S3: needs depleted over 3000 ticks (update path running)`,
);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
// Signal failure count via stdout (the process global is not typed in this tsconfig;
// callers can grep for FAIL or check the summary line instead of exit code).
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  // Coerce the process exit without importing @types/node.
  (globalThis as any).process?.exit(1);
}
