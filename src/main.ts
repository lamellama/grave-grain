/**
 * main.ts — Gravegrain Phase 9 bootstrap + full game loop (task 9-7).
 *
 * GDD §5.3: the world is now SEEDED PROCEDURAL — generateWorld() lays a layered
 *   dirt-topped world (soil/grass → dirt → stone+ore at depth, water tables,
 *   woodland) and returns the safe spawn zone + stockpile point + zombie edge.
 *   The hand-seeded Phase-3/5/6/7 test scenes are retired.
 * GDD §11: win/lose state machine (survive WIN_WAVES = WIN; colony wiped = LOSE).
 * GDD §12.1/§12.2: HUD overlays — needs bars, edge arrows, minimap, death toasts,
 *   end screen, and pause + sim-speed controls.
 *
 * Per-tick order (unchanged from Phase 7, plus state):
 *   simulation.step → updateZombie → updateSurvivor(s, zombies) →
 *   resolveBreaching → updateWaves(append) → prune → updateGameState.
 * The sim FREEZES once the game is won/lost (simulationTick returns early) but
 * rendering continues so the end screen shows.
 */

import {
  SIM_HZ,
  CELL_SIZE,
  WORLD_W,
  WORLD_H,
  SURVIVOR_COUNT,
  SURVIVOR_SPAWN_SPREAD,
  STARTING_WOOD,
  STARTING_STONE,
  SURFACE_BASE_Y,
} from './config';
import { initInput, setTargetBody, setSurvivors, setZombies, refreshBuildButtons } from './input';
import { initRenderer, getRenderer, setBodies, setZombieBodies } from './render/renderer';
import { camera, clampCamera } from './camera';
import * as simulation from './engine/simulation';
import { createSurvivor, updateSurvivor, assignRole } from './characters/survivor';
import type { Survivor } from './characters/survivor';
import { updateZombie } from './characters/zombie';
import type { Zombie } from './characters/zombie';
import { resolveBreaching } from './game/breaching';
import { createWaveState, updateWaves } from './game/waves';
import { makeTool } from './game/roles';
import { rebuildNavgrid } from './engine/navgrid';
import { addResource, setStockpilePoint, getStockpile } from './game/resources';
import { generateWorld } from './game/worldgen';
import { createGameState, updateGameState } from './game/state';
import {
  drawNeedsBars,
  drawEdgeArrows,
  drawMinimap,
  drawToasts,
  drawEndScreen,
  pushToast,
  getSimSpeed,
  directionToWorldX,
} from './game/ui';

// ============================================================================
// Bootstrap: grab canvas and 2D context
// ============================================================================

const canvas = document.getElementById('game') as HTMLCanvasElement;
if (!canvas) {
  throw new Error('Canvas element with id="game" not found');
}

const ctx2d = canvas.getContext('2d');
if (!ctx2d) {
  throw new Error('Failed to get 2D rendering context');
}
// Non-null binding so the render-loop closure keeps the narrowed type.
const ctx: CanvasRenderingContext2D = ctx2d;

// ============================================================================
// Canvas sizing: honour devicePixelRatio for crisp rendering
// ============================================================================

function resizeCanvas(): void {
  // Render in CSS pixels (chunky cells — GDD §12.4 keep cells chunky / small grid).
  // The renderer builds its ImageData in CSS px and putImageData ignores the ctx
  // transform, so the canvas backing store MUST be CSS-px sized (not device-px)
  // or the world draws into a 1/dpr corner of the canvas. We deliberately do NOT
  // multiply by devicePixelRatio or ctx.scale(dpr): keeps ImageData == backing
  // store so putImageData fills the whole canvas. (Slight upscale on hi-DPI is
  // fine for the pixel-art look; crisp-retina is a possible later refinement.)
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  // Notify renderer of new size
  const renderer = getRenderer();
  renderer.onResize();
  // Re-frame vertically so the surface stays in view on resize.
  frameCameraVertically();
}

// The world (WORLD_H) is taller than the viewport and horizontal drag is the
// primary navigation (GDD §12.1), so we FRAME the camera vertically on the
// surface (where the colony, survivors and zombies are) instead of showing the
// empty sky at y=0. Surface sits ~30% down the viewport, leaving sky above and
// the dig-down terrain below. Updated to the real spawn surface after worldgen.
let framedSurfaceRow = SURFACE_BASE_Y;
function frameCameraVertically(): void {
  const r = getRenderer();
  const visibleRows = r.viewportHeightPx / CELL_SIZE;
  camera.y = framedSurfaceRow - visibleRows * 0.3;
  clampCamera(r.viewportWidthPx, r.viewportHeightPx);
}

// ============================================================================
// Initialize renderer and input FIRST — resizeCanvas() calls getRenderer(),
// so the renderer singleton must exist before the initial sizing pass and
// before the resize listener can fire. (Init-order matters here — the smoke
// test guards this; do NOT reorder.)
// ============================================================================

const renderer = initRenderer(canvas, ctx);
initInput(canvas);

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ============================================================================
// World generation (task 9-7, GDD §5.3)
//
// generateWorld() writes the layered terrain straight into the grid's typed
// arrays (no markTerrainEdit), so we MUST rebuildNavgrid() afterwards before the
// loop starts — survivors path on the coarse navgrid from tick 0 (GDD §13).
//
// The result gives us: a safe spawn column away from the zombie edge, a drop row
// above the local surface, a surface stockpile point, and which edge the horde
// streams in from (waves.ts already honours ZOMBIE_SPAWN_EDGE — world.zombieEdge
// mirrors it). Surface is DIRT/grass with ore veins at depth (no flat stone
// floor), fixing the "looks like stone" / "no ore once mined" playtest notes.
// ============================================================================

const world = generateWorld();
rebuildNavgrid();
// Frame the camera on the generated surface so the action is on-screen (not the
// empty sky above it). Horizontal drag still pans; y stays framed here.
framedSurfaceRow = world.spawnY;
frameCameraVertically();
// Center horizontally on the COLONY (spawnX) at startup so the player starts
// looking at their base — not the empty far edge where zombies spawn. Horizontal
// drag pans from here; off-screen edge arrows point to incoming herds.
{
  const r = getRenderer();
  camera.x = world.spawnX - r.viewportWidthPx / CELL_SIZE / 2;
  clampCamera(r.viewportWidthPx, r.viewportHeightPx);
}

// Colony stockpile sits on the surface inside the spawn zone (GDD §8 deposit loc).
setStockpilePoint(world.stockpilePoint.x, world.stockpilePoint.y);

// Starting resources so the first tool/wall can be crafted/built on load
// (GDD §6.2 tool-gating, §8 build affordability).
addResource('wood', STARTING_WOOD);
addResource('stone', STARTING_STONE);

// ============================================================================
// Survivors (GDD §6.1) — SURVIVOR_COUNT spawned in a loose cluster around the
// spawn column, dropped a body-height above the surface so they fall onto it.
// ============================================================================

const survivors: Survivor[] = [];

for (let i = 0; i < SURVIVOR_COUNT; i++) {
  // Spread survivors symmetrically around the spawn column so they don't stack.
  const offsetX = (i - Math.floor(SURVIVOR_COUNT / 2)) * SURVIVOR_SPAWN_SPREAD;
  const spawnX = world.spawnX + offsetX;
  survivors.push(createSurvivor(spawnX, world.spawnY));
}

// Register all survivor bodies with the renderer so they are drawn each frame.
setBodies(survivors.map((s) => s.body));

// Wire the Shoot tool to survivors[0] (keeps the Phase-4 hand-test functional).
setTargetBody(survivors[0].body);

// Expose survivors to the Assign tool (GDD §6.2).
setSurvivors(survivors);

// ============================================================================
// Colony defence (GDD §7.2/§6.2): arm survivors[0] as a GUARD so it engages the
// horde near the colony. Hand it a weapon directly (no stockpile spend) then
// assign the role — assignRole keeps the matching held tool.
// ============================================================================

survivors[0].tool = makeTool('weapon');
assignRole(survivors[0], 'guard');

// ============================================================================
// Zombies & waves (GDD §7.1). `zombies` is the live array; the renderer and the
// Shoot tool hold the SAME reference so it stays current as we push/splice.
// ============================================================================

const zombies: Zombie[] = [];
const waveState = createWaveState();

setZombies(zombies); // Shoot tool can headshot zombies
setZombieBodies([]); // renderer's green-tinted zombie layer (empty at start)

// ============================================================================
// Game state machine (GDD §11/§12.2): win/lose, wave mirror, death log.
// ============================================================================

const gameState = createGameState();

// Cursor into gameState.deathLog of the last death we have already toasted
// (GDD §12.2 death legibility). With ≤ SURVIVOR_COUNT survivors the log never
// reaches its 8-entry cap, so a simple monotone cursor is sufficient.
let deathToastCursor = 0;

// Cache the stockpile readout element for efficient per-frame update (GDD §8).
const stockpileReadoutEl = document.getElementById('stockpile-readout') as HTMLElement | null;

// ============================================================================
// Optional arrow-key dev nudge for survivors[0] (does NOT conflict with the AI —
// updateSurvivor re-overrides moveDir every tick).
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
let tickCount = 0;

/**
 * One simulation tick. Returns EARLY (frozen) once the game is no longer
 * 'playing' so the won/lost end screen is static while rendering continues.
 *
 *   1. simulation.step()  — advance the falling-sand CA (GDD §5.2).
 *   2. updateZombie()     — drive zombies first (melee through THE GATE).
 *   3. updateSurvivor()   — drive each survivor's body + needs (GDD §6.1); the
 *                           guard engages the horde (GDD §7.2).
 *   4. resolveBreaching() — zombies gnaw structures they're pressing (GDD §7.4).
 *   5. updateWaves()      — trickle fresh zombies in from the edge (GDD §7.1).
 *   6. prune dead zombies (in place — shared array reference).
 *   7. updateGameState()  — win/lose + death watcher (GDD §11/§12.2).
 */
function simulationTick(): void {
  // Freeze the whole sim once the game is decided (GDD §11). Rendering (incl.
  // the end screen) still runs from renderLoop.
  if (gameState.status !== 'playing') return;

  // Phase 1/2: advance the falling-sand cellular update one tick (GDD §5.2).
  simulation.step();

  // Drive zombies FIRST so survivor combat + breaching read fresh zombie state.
  for (const z of zombies) {
    updateZombie(z, survivors);
  }

  // Update every survivor (owns its body drive — GDD §6.1). The zombie list is
  // passed so an armed guard engages the horde (GDD §7.2).
  for (let i = 0; i < survivors.length; i++) {
    const s = survivors[i];
    // Optional arrow-key dev nudge on survivors[0] (AI re-overrides next tick).
    if (i === 0) {
      if (leftArrowHeld && !rightArrowHeld) {
        s.body.moveDir = -1;
      } else if (rightArrowHeld && !leftArrowHeld) {
        s.body.moveDir = 1;
      }
    }
    updateSurvivor(s, zombies);
  }

  // Zombies gnaw through structures they're pressing (GDD §7.4). After
  // updateZombie so moveDir/facing reflect this tick's intent.
  resolveBreaching(zombies);

  // Escalating waves (GDD §7.1): append fresh spawns to the live array.
  const aliveBeforeSpawn = zombies.filter((z) => z.body.alive).length;
  const fresh = updateWaves(waveState, aliveBeforeSpawn);
  for (const f of fresh) zombies.push(f);

  // Prune fully-dead zombies every so often so the array can't grow unbounded.
  // Splice IN PLACE — the renderer and Shoot tool hold this same reference.
  tickCount++;
  if (tickCount % 120 === 0) {
    for (let i = zombies.length - 1; i >= 0; i--) {
      if (!zombies[i].body.alive) zombies.splice(i, 1);
    }
  }

  // Register the (possibly changed) zombie bodies with the renderer.
  setZombieBodies(zombies.map((z) => z.body));

  // Advance the win/lose state machine + death watcher (GDD §11/§12.2).
  const aliveZombieCount = zombies.filter((z) => z.body.alive).length;
  updateGameState(gameState, {
    survivors,
    waveState,
    aliveZombieCount,
    tick: tickCount,
  });
}

/**
 * Keyboard input:
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
 * Toast any NEW death-log entries (GDD §12.2 death legibility). Off-screen
 * deaths get a ←/→ prefix so the player knows which way to look.
 */
function flushDeathToasts(): void {
  const vpW = renderer.viewportWidthPx;
  while (deathToastCursor < gameState.deathLog.length) {
    const e = gameState.deathLog[deathToastCursor];
    const dir = directionToWorldX(e.x, camera, vpW);
    const prefix = dir ? dir + ' ' : '';
    pushToast(prefix + 'Survivor died: ' + e.cause);
    deathToastCursor++;
  }
}

/**
 * Main render loop: fixed-timestep accumulator pattern, running getSimSpeed()
 * sim ticks per accumulator step (GDD §12.2 sim-speed). Pause + single-step are
 * preserved.
 */
function renderLoop(): void {
  const now = performance.now();
  const deltaTime = now - lastFrameTime;
  lastFrameTime = now;

  accumulator += deltaTime;
  while (accumulator >= frameTimeMs) {
    if (!isPaused) {
      // Sim-speed multiplier: run N ticks per fixed step (GDD §12.2). Each
      // simulationTick self-freezes once the game is decided, so over-running
      // here is harmless at the end.
      const steps = getSimSpeed();
      for (let i = 0; i < steps; i++) simulationTick();
    }
    accumulator -= frameTimeMs;
  }

  // Cells + bodies + FPS (renderer owns the main ctx).
  renderer.render();

  // UI overlays, drawn on the same ctx in z-order (GDD §12.1/§12.2).
  flushDeathToasts();
  const vpW = renderer.viewportWidthPx;
  const vpH = renderer.viewportHeightPx;
  drawNeedsBars(ctx, survivors);
  drawEdgeArrows(ctx, zombies, camera, vpW, vpH);
  drawMinimap(ctx, { survivors, zombies, camera, viewportWpx: vpW, viewportHpx: vpH });
  drawToasts(ctx);
  drawEndScreen(ctx, gameState); // only dims when not playing

  // Stockpile HUD readout (GDD §8).
  if (stockpileReadoutEl) {
    const sp = getStockpile();
    stockpileReadoutEl.textContent =
      `Wood ${sp.wood}  Stone ${sp.stone}  Food ${sp.food}  Ore ${sp.ore}`;
  }

  // Refresh build-button affordability (GDD §8).
  refreshBuildButtons();

  requestAnimationFrame(renderLoop);
}

// Start the loop
requestAnimationFrame(renderLoop);

console.log('Gravegrain Phase 9 initialized (task 9-7 full loop active)');
console.log(`World: ${WORLD_W}×${WORLD_H} cells, ${WORLD_W * CELL_SIZE}×${WORLD_H * CELL_SIZE}px`);
console.log(
  `Simulation: ${SIM_HZ} Hz | Survivors: ${SURVIVOR_COUNT} | Spawn: x=${world.spawnX} | Zombie edge: ${world.zombieEdge}`,
);
console.log('Controls: P = pause; . or ] = step; ArrowLeft/Right = nudge survivors[0]; toolbar = paint/pan/ignite/shoot/assign/build; speed button cycles 1×/2×/3×');
