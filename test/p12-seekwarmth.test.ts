/**
 * Headless verification for Task W3 — shelter wired into warmth + the seekWarmth
 * auto-override (GDD §6.1 "they retreat to a shelter when too cold", §8, §10).
 * Imports the REAL modules (no mocks); seeds terrain into grid.material, builds
 * the navgrid, then steps updateSurvivor. Run via tsc (commonjs) → node.
 *
 * Geometry note (why the camp model): a 6-wide body COLLIDES with any WOOD/WALL
 * inside its footprint, so a fully-enclosed shelter cannot be ENTERED from open
 * ground by walking (the body would clip a wall). The realistic model (and what
 * the GDD describes — shelter as a colony "retreat point") is that survivors
 * already live INSIDE the walled camp and walk to the roofed/sheltered nook when
 * cold. These tests therefore build a walled enclosure and place the survivor
 * inside it (not under the roof / not flanked by walls) so it must walk to the
 * sheltered cell.
 *
 * Tests:
 *   1. Sheltered stops freezing: trapped inside a tight WOOD/WALL hut → warmth
 *      never depletes over a long cold run; never freezes.
 *   2. Cold survivor retreats to shelter: spawned in a camp on a non-sheltered
 *      cell, warmth < WARMTH_THRESHOLD → behaviour seekWarmth, walks until
 *      isSheltered, warmth climbs back above threshold.
 *   3. No shelter → wander fallback, still freezes: open cold, no shelter / fire
 *      → falls back to wander (moves, no crash) and freezes → corpse.
 *   4. Priority: thirsty AND cold with reachable water → seeks WATER first
 *      (thirst > warmth), then seekWarmth once no longer thirsty.
 */
import {
  createSurvivor,
  updateSurvivor,
  isSheltered,
  type Survivor,
} from '../src/characters/survivor';
import { material, set } from '../src/engine/grid';
import { STONE, WATER, WOOD, WALL, AIR } from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { WORLD_W, NEED_MAX, WARMTH_THRESHOLD, THIRST_THRESHOLD } from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
function floor(x0: number, x1: number, top = 150): void {
  for (let x = x0; x <= x1; x++) for (let r = top; r < top + 8; r++) set(x, r, STONE);
}
/** Vertical wall in column x, rows [y0,y1] inclusive, of material `mat`. */
function vwall(x: number, y0: number, y1: number, mat: number): void {
  for (let y = y0; y <= y1; y++) set(x, y, mat);
}
/** Horizontal roof at row y, cols [x0,x1], of material `mat`. */
function hroof(x0: number, x1: number, y: number, mat: number): void {
  for (let x = x0; x <= x1; x++) set(x, y, mat);
}

// ===========================================================================
// 1. SHELTERED STOPS FREEZING. Tight hut: WALL columns at 196 & 203 (interior
//    exactly the 6-wide body → trapped at x=200), WOOD roof at row 137. With
//    SHELTER_SIDE_SCAN=7 the body at 200 sees both walls + roof → sheltered.
//    Cold world, but sheltered → warmth must NOT deplete over a long run.
// ===========================================================================
clearGrid();
floor(150, 260);
vwall(196, 138, 149, WALL);
vwall(203, 138, 149, WALL);
hroof(196, 203, 137, WOOD);
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  // Let it settle one tick, then confirm the start IS sheltered.
  s.needs.hunger = NEED_MAX;
  s.needs.thirst = NEED_MAX;
  updateSurvivor(s, []);
  const shelteredAtStart = isSheltered(s.body);
  const w0 = s.needs.warmth;
  let minWarmth = w0;
  let died = false;
  for (let t = 0; t < 20000; t++) {
    s.needs.hunger = NEED_MAX; // isolate warmth as the only possible cause
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
    if (!s.body.alive) {
      died = true;
      break;
    }
    minWarmth = Math.min(minWarmth, s.needs.warmth);
  }
  console.log(
    `R1 sheltered=${shelteredAtStart} | warmth start ${w0} → min over 20000 ticks ${minWarmth.toFixed(2)} | alive=${s.body.alive}`,
  );
  check(shelteredAtStart, 'R1 survivor IS sheltered inside the WOOD/WALL hut');
  check(!died, 'R1 survivor never froze over 20000 cold ticks (shelter blocks cold)');
  check(minWarmth >= w0 - 1e-6, 'R1 warmth never dipped below its start (restores, not depletes)');
}

// ===========================================================================
// 2. COLD SURVIVOR RETREATS TO SHELTER. Camp: WALL columns at 194 & 206 (12
//    wide), WOOD roof over the whole span. Standable interior anchors 198..203;
//    with SIDE_SCAN=7 cells 199,200,201 are sheltered, 202/203 are NOT. Spawn at
//    203 (not sheltered) and cold → it must walk left into the sheltered nook.
// ===========================================================================
clearGrid();
floor(150, 260);
vwall(194, 138, 149, WALL);
vwall(206, 138, 149, WALL);
// Roof a few cells ABOVE the head (head row 138). It stays within SHELTER_ROOF_SCAN
// (rows 132..137) so isSheltered detects it, but the cell DIRECTLY above the head
// (row 137) is left clear so locomotion's burial-pin probe does not freeze the
// body under its own roof (a roof touching the head would pin it in place).
hroof(194, 206, 134, WOOD);
rebuildNavgrid();
{
  const s = createSurvivor(203, 149);
  s.needs.warmth = 30; // below WARMTH_THRESHOLD (50) → auto-override
  const before = s.needs.warmth;
  const shelteredAtStart = isSheltered(s.body);
  let sawSeekWarmth = false;
  let reachedShelter = false;
  let arrivalWarmth = -1;
  let peakAfter = before;
  for (let t = 0; t < 20000; t++) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
    if (!s.body.alive) break;
    if (s.behaviour === 'seekWarmth') sawSeekWarmth = true;
    if (isSheltered(s.body)) {
      if (!reachedShelter) arrivalWarmth = s.needs.warmth;
      reachedShelter = true;
    }
    if (reachedShelter) peakAfter = Math.max(peakAfter, s.needs.warmth);
    if (reachedShelter && s.needs.warmth > WARMTH_THRESHOLD) break;
  }
  console.log(
    `R2 sheltered@start=${shelteredAtStart} | warmth before ${before} → arrival ${arrivalWarmth.toFixed(2)} → after ${peakAfter.toFixed(2)} | reached shelter=${reachedShelter} | sawSeekWarmth=${sawSeekWarmth} | alive=${s.body.alive}`,
  );
  check(!shelteredAtStart, 'R2 survivor NOT sheltered at spawn (must move to shelter)');
  check(sawSeekWarmth, 'R2 auto-override to seekWarmth fired below threshold');
  check(reachedShelter, 'R2 survivor pathed until isSheltered(body) became true');
  check(s.body.alive, 'R2 survivor did NOT freeze on the way');
  check(peakAfter > before, 'R2 warmth recovered after reaching shelter');
  check(peakAfter > WARMTH_THRESHOLD, 'R2 warmth restored back above WARMTH_THRESHOLD');
}

// ===========================================================================
// 3. NO SHELTER → WANDER FALLBACK, STILL FREEZES. Open cold floor, no walls / no
//    fire. seekWarmth finds no reachable shelter → falls back to wander (must
//    move, must not crash) and warmth → 0 → frozen CORPSE (W1 degradation).
// ===========================================================================
clearGrid();
floor(0, WORLD_W - 1);
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  s.needs.warmth = 30; // cold, but no heat/shelter anywhere
  const startX = Math.round(s.body.x);
  let sawSeekWarmth = false;
  let moved = false;
  let died = false;
  for (let t = 0; t < 20000; t++) {
    s.needs.hunger = NEED_MAX; // isolate warmth as the cause of death
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
    if (s.behaviour === 'seekWarmth') sawSeekWarmth = true;
    if (Math.round(s.body.x) !== startX) moved = true;
    if (!s.body.alive) {
      died = true;
      break;
    }
  }
  console.log(
    `R3 sawSeekWarmth=${sawSeekWarmth} | moved=${moved} | died=${died} | cause=${s.deathCause} | corpse=${s.body.corpse}`,
  );
  check(sawSeekWarmth, 'R3 cold survivor entered seekWarmth (trying to find shelter)');
  check(moved, 'R3 fell back to wander and MOVED (not stuck / no crash)');
  check(died && s.deathCause === 'frozen', 'R3 still froze with no heat anywhere (graceful degradation)');
  check(s.body.corpse === true, 'R3 frozen death is a QUIET corpse (rig lies down, W1 preserved)');
}

// ===========================================================================
// 4. PRIORITY: thirst > warmth. Reachable water, survivor both thirsty AND cold
//    → seeks WATER first; only switches to seekWarmth once no longer thirsty.
// ===========================================================================
clearGrid();
floor(100, 600);
for (let x = 280; x <= 285; x++) for (let y = 146; y <= 149; y++) set(x, y, WATER);
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  s.needs.thirst = 30; // below THIRST_THRESHOLD (50)
  s.needs.warmth = 30; // below WARMTH_THRESHOLD (50)
  let firstSeek: string | null = null;
  let warmthWhileThirsty = false;
  let laterSeekWarmth = false;
  for (let t = 0; t < 8000 && s.body.alive; t++) {
    s.needs.hunger = NEED_MAX;
    updateSurvivor(s, []);
    if (firstSeek === null && (s.behaviour === 'seekWater' || s.behaviour === 'seekWarmth')) {
      firstSeek = s.behaviour;
    }
    if (s.needs.thirst < THIRST_THRESHOLD && s.behaviour === 'seekWarmth') {
      warmthWhileThirsty = true; // must NEVER happen — warmth is lower priority
    }
    if (s.needs.thirst >= THIRST_THRESHOLD && s.behaviour === 'seekWarmth') {
      laterSeekWarmth = true; // after drinking, cold takes over
    }
  }
  console.log(
    `R4 firstSeek=${firstSeek} | warmthWhileThirsty=${warmthWhileThirsty} | laterSeekWarmth=${laterSeekWarmth} | thirst=${s.needs.thirst.toFixed(1)}`,
  );
  check(firstSeek === 'seekWater', 'R4 thirsty+cold → seeks WATER first (thirst > warmth)');
  check(!warmthWhileThirsty, 'R4 NEVER seekWarmth while still thirsty (priority strict)');
  check(laterSeekWarmth, 'R4 switched to seekWarmth once no longer thirsty (then warmth)');

}

// 4b. Direct priority check on a FRESH survivor in open cold: thirst FULL, only
//     cold → selectBehaviour must pick seekWarmth (warmth is the active need).
clearGrid();
floor(100, 400);
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  s.needs.thirst = NEED_MAX;
  s.needs.hunger = NEED_MAX;
  s.needs.warmth = 30;
  updateSurvivor(s, []);
  check(s.behaviour === 'seekWarmth', 'R4b only-cold (thirst+hunger full) selects seekWarmth');
}

// ===========================================================================
console.log('');
if (failures === 0) {
  console.log('ALL PASS');
  console.log(
    'SUMMARY: shelter wired into warmth (sheltered → restores, never freezes); cold survivor auto-overrides to seekWarmth and walks to the nearest REACHABLE sheltered cell (SHELTER ONLY, never fire); no reachable shelter → wander fallback + graceful freeze; thirst > warmth priority holds.',
  );
} else {
  throw new Error(`FAILURES: ${failures}`);
}
