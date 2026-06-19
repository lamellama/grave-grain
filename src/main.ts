/**
 * main.ts — Gravegrain Phase 5 bootstrap and fixed-timestep game loop
 * GDD §12: wide world, horizontal scroll, pointer-first input.
 * GDD §6.1: several autonomous survivors with needs + pathfinding.
 *
 * p5-t5: generalise from one body to N survivors. The throwaway pacer/arrow
 * driver is retired; updateSurvivor owns each body's drive. Terrain is seeded
 * with a stone floor, a contained WATER pool and two FOLIAGE bushes so thirsty /
 * hungry survivors can self-preserve immediately. rebuildNavgrid() is called once
 * after terrain seeding so the router has a valid map before the loop starts.
 */

import {
  SIM_HZ,
  CELL_SIZE,
  BODY_H,
  WORLD_W,
  WORLD_H,
  BODY_SPAWN_X,
  BODY_SPAWN_Y,
  P3_GROUND_Y,
  SURVIVOR_COUNT,
  SURVIVOR_SPAWN_SPREAD,
  STARTING_WOOD,
} from './config';
import { initInput, setTargetBody, setSurvivors, setZombies } from './input';
import { initRenderer, getRenderer, setBodies, setZombieBodies } from './render/renderer';
import { clampCamera } from './camera';
import * as grid from './engine/grid';
import * as simulation from './engine/simulation';
import { AIR, STONE, WATER, FOLIAGE, ORE, WOOD } from './engine/materials';
import { createSurvivor, updateSurvivor, assignRole } from './characters/survivor';
import type { Survivor } from './characters/survivor';
import { updateZombie } from './characters/zombie';
import type { Zombie } from './characters/zombie';
import { resolveBreaching } from './game/breaching';
import { createWaveState, updateWaves } from './game/waves';
import { makeTool } from './game/roles';
import { rebuildNavgrid } from './engine/navgrid';
import { addResource, setStockpilePoint, getStockpile } from './game/resources';

// ============================================================================
// Bootstrap: grab canvas and 2D context
// ============================================================================

const canvas = document.getElementById('game') as HTMLCanvasElement;
if (!canvas) {
  throw new Error('Canvas element with id="game" not found');
}

const ctx = canvas.getContext('2d');
if (!ctx) {
  throw new Error('Failed to get 2D rendering context');
}

// ============================================================================
// Canvas sizing: honour devicePixelRatio for crisp rendering
// ============================================================================

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const context = canvas.getContext('2d');
  if (context) {
    context.scale(dpr, dpr);
  }
  // Notify renderer of new size
  const renderer = getRenderer();
  renderer.onResize();
}

// ============================================================================
// Initialize renderer and input FIRST — resizeCanvas() calls getRenderer(),
// so the renderer singleton must exist before the initial sizing pass and
// before the resize listener can fire. (Init-order matters here.)
// ============================================================================

const renderer = initRenderer(canvas, ctx);
initInput(canvas);

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ============================================================================
// Phase-5 test terrain (p5-t5)
//
// A flat stone floor across the world, a contained WATER pool, and two FOLIAGE
// bushes within easy walking distance of the survivor spawn zone.  Survivors
// spawn above the floor and fall onto it; the sim runs immediately so they land
// before the first behaviour tick — no special setup required.
//
// Layout (y increases downward, floor at P3_GROUND_Y):
//
//   Flat stone floor at y = P3_GROUND_Y (full world width).
//
//   Water pool — x 270–330, depth 5 cells, contained by stone walls on both
//   sides.  Survivors path ADJACENT to it (never inside — water isn't
//   permeableToBodies); they drink from the bank.
//
//   Foliage bush A — x 380–400, height 3 cells above the floor.
//   Foliage bush B — x 440–460, height 3 cells above the floor.
//   Foliage is permeableToBodies (GDD §5.2/§9): bodies pass THROUGH the bush
//   (collision-only — you can't stand ON foliage, only on the floor beneath it).
//   It is still a harvest target reached by adjacency/reach, NOT by overlap;
//   survivors eat the adjacent cell (resourceWithinReach in survivor.ts).
//
// All resources are within RESOURCE_SCAN_RADIUS (200 cells) of spawn (x≈200).
// ============================================================================

function seedPhase5Scene(): void {
  // --- Flat stone floor (full world width) ---
  for (let x = 0; x < WORLD_W; x++) {
    grid.set(x, P3_GROUND_Y, STONE);
  }

  // --- Water pool: a floor depression so water is naturally contained. ---
  // The pool sits BELOW the main floor level; the adjacent floor cells on each
  // side remain at P3_GROUND_Y so survivors can stand beside the pool and drink
  // without being blocked by a stone wall (driveSeek paths to res.x ± 1 which
  // must be walkable — this layout guarantees that).
  const POOL_X0 = 270;
  const POOL_X1 = 330;
  const POOL_DEPTH = 5; // cells of water below the main floor surface
  for (let x = POOL_X0; x <= POOL_X1; x++) {
    grid.set(x, P3_GROUND_Y, AIR);              // remove main floor row over the pool
    grid.set(x, P3_GROUND_Y + POOL_DEPTH, STONE); // deep pool floor
    for (let y = P3_GROUND_Y; y < P3_GROUND_Y + POOL_DEPTH; y++) {
      grid.set(x, y, WATER);                   // fill with water
    }
  }

  // --- Foliage bush A (x 380–400, 3 cells tall) ---
  for (let x = 380; x <= 400; x++) {
    for (let y = P3_GROUND_Y - 3; y < P3_GROUND_Y; y++) {
      grid.set(x, y, FOLIAGE);
    }
  }

  // --- Foliage bush B (x 440–460, 3 cells tall) ---
  // A second bush so multiple hungry survivors can eat without competing for
  // the exact same cell (EAT action removes the consumed FOLIAGE cell).
  for (let x = 440; x <= 460; x++) {
    for (let y = P3_GROUND_Y - 3; y < P3_GROUND_Y; y++) {
      grid.set(x, y, FOLIAGE);
    }
  }
}

seedPhase5Scene();

// ============================================================================
// Phase-6 scene additions (p6-t5, GDD §6.2/§9)
//
// Three additions on top of the Phase-5 terrain:
//
//  1. DENSE FOLIAGE FOREST (x 230–268) — a band of trees between the survivor
//     spawn zone (x~200) and the water pool (x 270). Foliage is permeable, so
//     bodies walk THROUGH it; the Lumberjack chops it for wood (GDD §9).
//
//  2. STONE/ORE OUTCROP (x 335–360) — a stone pillar above the floor just right
//     of the pool (x 270–330). The left face (x=335) is adjacent to AIR so it
//     is EXPOSED and findTarget('miner') can see it. ORE cells sit on that same
//     exposed left face (isExposedRock checks orthogonal AIR neighbours, GDD §6.2).
//
//  3. STOCKPILE POINT — placed at the spawn-zone floor so hauling survivors
//     deposit there (GDD §8 deposit loc). Starting wood is added so the first
//     tool can be crafted immediately (GDD §6.2 tool-gating).
// ============================================================================

function seedPhase6Scene(): void {
  // 1. Dense foliage forest: x 230–268, 6 cells tall above the floor.
  //    Right of spawn (200), left of the pool (270). Survivors walk through it.
  for (let x = 230; x <= 268; x++) {
    for (let y = P3_GROUND_Y - 6; y < P3_GROUND_Y; y++) {
      grid.set(x, y, FOLIAGE);
    }
  }

  // 2. Stone/ore outcrop: x 335–360, 8 cells tall above the floor.
  //    Sits just right of the pool. All left-edge cells (x=335) are adjacent to
  //    AIR at x=334, so isExposedRock returns true for them — miner can target.
  for (let x = 335; x <= 360; x++) {
    for (let y = P3_GROUND_Y - 8; y < P3_GROUND_Y; y++) {
      grid.set(x, y, STONE);
    }
  }
  // ORE on the left face of the outcrop (x=335, AIR at x=334 → exposed).
  for (let y = P3_GROUND_Y - 6; y <= P3_GROUND_Y - 3; y++) {
    grid.set(335, y, ORE);
  }

  // 3. Stockpile point: on the floor just left of the spawn zone (GDD §8).
  //    BODY_SPAWN_X = 200; place the deposit one step left so survivors don't
  //    stack on the exact spawn pixel.
  setStockpilePoint(BODY_SPAWN_X - 10, P3_GROUND_Y - 1);

  // Starting resources: enough wood to craft one axe immediately (GDD §6.2).
  addResource('wood', STARTING_WOOD);
}

seedPhase6Scene();

// ============================================================================
// Phase-7 scene additions (p7-t7, GDD §7.1/§7.4)
//
// A WOOD fence at a chokepoint between the zombie spawn edge (left, x≈1) and the
// survivor colony (x≈176–224). Placed with grid.placeMaterial so the cells are
// seeded to WOOD_INTEGRITY — zombies must gnaw through it (breaching, §7.4)
// rather than walking past. A few cells tall so bodies can't step over it
// (STEP_UP_MAX = 1). rebuildNavgrid() runs after this (below) so the router sees
// the wall from tick 0.
// ============================================================================

const P7_FENCE_X = 120;          // chokepoint column, left of the colony
const P7_FENCE_HEIGHT = 4;       // cells of WOOD above the floor (un-steppable)

function seedPhase7Scene(): void {
  for (let y = P3_GROUND_Y - P7_FENCE_HEIGHT; y < P3_GROUND_Y; y++) {
    grid.placeMaterial(P7_FENCE_X, y, WOOD); // seeds integrity to WOOD_INTEGRITY
  }
}

seedPhase7Scene();

// ============================================================================
// Build the coarse navgrid AFTER terrain is seeded, BEFORE the loop starts
// (GDD §13: survivors path on it from tick 0).
// ============================================================================

rebuildNavgrid();

// ============================================================================
// Phase-5 survivors (p5-t5)
//
// SURVIVOR_COUNT survivors are spawned in a loose cluster above the spawn zone;
// they fall onto the floor and immediately begin wandering, seeking water when
// thirsty, and seeking food when hungry.
//
// Spread: each survivor's spawn x is offset by SURVIVOR_SPAWN_SPREAD * i so
// they land spread across a reasonable section of floor instead of stacking.
// ============================================================================

const survivors: Survivor[] = [];

for (let i = 0; i < SURVIVOR_COUNT; i++) {
  // Spread survivors symmetrically around BODY_SPAWN_X.
  const offsetX = (i - Math.floor(SURVIVOR_COUNT / 2)) * SURVIVOR_SPAWN_SPREAD;
  const spawnX = BODY_SPAWN_X + offsetX;
  // Spawn above the floor so they fall onto it naturally (BODY_SPAWN_Y < P3_GROUND_Y).
  const spawnY = BODY_SPAWN_Y;
  survivors.push(createSurvivor(spawnX, spawnY));
}

// Register all survivor bodies with the renderer so they are drawn each frame.
setBodies(survivors.map((s) => s.body));

// Wire the Shoot tool to survivors[0] (keeps the Phase-4 hand-test functional).
setTargetBody(survivors[0].body);

// Expose survivors to the Assign tool (p6-t5, GDD §6.2).
setSurvivors(survivors);

// ============================================================================
// Phase-7 colony defence (p7-t7, GDD §7.2/§6.2): arm survivors[0] as a GUARD so
// it engages the horde (LEG the front rank, HEADSHOT crawlers) near the colony.
// We hand it a weapon directly (no stockpile spend) then assign the role —
// assignRole keeps a matching held tool. survivors[0] spawns near the colony /
// stockpile point, which is the guard's default hold position.
// ============================================================================

survivors[0].tool = makeTool('weapon');
assignRole(survivors[0], 'guard');

// ============================================================================
// Phase-7 zombies & waves (p7-t7, GDD §7.1). `zombies` is the live array; the
// renderer and the Shoot tool hold the SAME reference so it stays current as we
// push spawns / splice the dead in place (never reassigned).
// ============================================================================

const zombies: Zombie[] = [];
const waveState = createWaveState();

setZombies(zombies);          // Shoot tool can headshot zombies (p7-t7)
setZombieBodies([]);          // renderer's green-tinted zombie layer (empty at start)

// Cache the stockpile readout element for efficient per-frame update (p6-t5, GDD §8).
const stockpileReadoutEl = document.getElementById('stockpile-readout') as HTMLElement | null;

// ============================================================================
// Optional arrow-key dev nudge for survivors[0] (does NOT conflict with
// survivor autonomy — updateSurvivor overrides moveDir every tick anyway; this
// just lets a developer tap left/right to see how the locomotion responds and
// then the AI resumes immediately next tick).
// ============================================================================

let leftArrowHeld = false;
let rightArrowHeld = false;

// ============================================================================
// Fixed-timestep game loop
// ============================================================================

const frameTimeMs = 1000 / SIM_HZ;
let accumulator = 0;
let isPaused = false;
let lastFrameTime = performance.now();

/**
 * One simulation tick:
 *   1. Advance the falling-sand CA one step (GDD §5.2).
 *   2. updateSurvivor() for each survivor — drives body + needs (GDD §6.1).
 *      Arrow-key hold on survivors[0] is applied BEFORE updateSurvivor so the
 *      AI can immediately re-override on the next tick if needed.
 * All steps happen in lockstep so every body reads fresh CA state.
 */
let tickCount = 0;

function simulationTick(): void {
  // Phase 1/2: advance the falling-sand cellular update one tick (GDD §5.2).
  simulation.step();

  // p7-t7: drive zombies FIRST (sets moveDir + lands melee strikes through THE
  // GATE), so survivor combat and breaching this tick read fresh zombie state.
  for (const z of zombies) {
    updateZombie(z, survivors);
  }

  // p5-t5 / p7-t4: update every survivor (owns its body drive — GDD §6.1). The
  // zombie list is passed so an armed guard engages the horde (GDD §7.2).
  for (let i = 0; i < survivors.length; i++) {
    const s = survivors[i];
    // Optional arrow-key dev nudge on survivors[0] (does not break the AI:
    // updateSurvivor resets moveDir via its behaviour each tick).
    if (i === 0) {
      if (leftArrowHeld && !rightArrowHeld) {
        s.body.moveDir = -1;
      } else if (rightArrowHeld && !leftArrowHeld) {
        s.body.moveDir = 1;
      }
    }
    updateSurvivor(s, zombies);
  }

  // p7-t7: zombies gnaw through structures they're pressing (GDD §7.4). Runs
  // AFTER updateZombie so moveDir/facing reflect this tick's intent.
  resolveBreaching(zombies);

  // p7-t7: escalating waves (GDD §7.1). updateWaves trickles new zombies in from
  // the spawn edge; append them to the live array.
  const aliveCount = zombies.filter((z) => z.body.alive).length;
  const fresh = updateWaves(waveState, aliveCount);
  for (const f of fresh) zombies.push(f);

  // p7-t7: prune fully-dead zombies (all bones shed into the sim already) every
  // so often so the array can't grow unbounded. Splice IN PLACE — the renderer
  // and Shoot tool hold this same array reference. Their cells stay in the sim.
  tickCount++;
  if (tickCount % 120 === 0) {
    for (let i = zombies.length - 1; i >= 0; i--) {
      if (!zombies[i].body.alive) zombies.splice(i, 1);
    }
  }

  // Register the (possibly changed) zombie bodies with the renderer (render-only
  // green tint; bodies themselves are never mutated by the renderer).
  setZombieBodies(zombies.map((z) => z.body));
}

/**
 * Handle keyboard input:
 *   P         — pause / resume
 *   . or ]    — manual step (one tick while paused)
 *   ArrowLeft / ArrowRight — nudge survivors[0] (optional dev tool)
 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'p' || event.key === 'P') {
    isPaused = !isPaused;
    console.log(isPaused ? 'Paused' : 'Resumed');
  }
  if (event.key === '.' || event.key === ']') {
    if (isPaused) {
      simulationTick();
      renderer.render();
      console.log('Step');
    }
  }

  if (event.key === 'ArrowLeft') {
    leftArrowHeld = true;
    event.preventDefault();
  }
  if (event.key === 'ArrowRight') {
    rightArrowHeld = true;
    event.preventDefault();
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft') {
    leftArrowHeld = false;
  }
  if (event.key === 'ArrowRight') {
    rightArrowHeld = false;
  }
}

window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);

/**
 * Main render loop: fixed-timestep accumulator pattern.
 */
function renderLoop(): void {
  const now = performance.now();
  const deltaTime = now - lastFrameTime;
  lastFrameTime = now;

  accumulator += deltaTime;
  while (accumulator >= frameTimeMs) {
    if (!isPaused) {
      simulationTick();
    }
    accumulator -= frameTimeMs;
  }

  renderer.render();

  // Update stockpile HUD readout every frame (p6-t5, GDD §8).
  if (stockpileReadoutEl) {
    const sp = getStockpile();
    stockpileReadoutEl.textContent =
      `Wood ${sp.wood}  Stone ${sp.stone}  Food ${sp.food}  Ore ${sp.ore}`;
  }

  requestAnimationFrame(renderLoop);
}

// Start the loop
requestAnimationFrame(renderLoop);

console.log('Gravegrain Phase 5 initialized (p5-t5 N-survivor loop active)');
console.log(`World: ${WORLD_W}×${WORLD_H} cells, ${WORLD_W * CELL_SIZE}×${WORLD_H * CELL_SIZE}px`);
console.log(`Simulation: ${SIM_HZ} Hz | Survivors: ${SURVIVOR_COUNT}`);
console.log('Controls: P = pause; . or ] = step; ArrowLeft/Right = nudge survivors[0]; toolbar = paint/pan/ignite/shoot');
