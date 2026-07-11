/**
 * main.ts - Gravegrain Phase 9 bootstrap + full game loop (task 9-7).
 *
 * GDD 5.3: the world is now SEEDED PROCEDURAL - generateWorld() lays a layered
 *   dirt-topped world (soil/grass -> dirt -> stone+ore at depth, water tables,
 *   woodland) and returns the safe spawn zone + stockpile point + zombie edge.
 *   The hand-seeded Phase-3/5/6/7 test scenes are retired.
 * GDD 11: win/lose state machine (survive WIN_WAVES = WIN; colony wiped = LOSE).
 * GDD 12.1/12.2: HUD overlays - needs bars, edge arrows, minimap, death toasts,
 *   end screen, and pause + sim-speed controls.
 *
 * Per-tick order (unchanged from Phase 7, plus state):
 *   simulation.step -> updateZombie -> updateSurvivor(s, zombies) ->
 *   resolveBreaching -> updateWaves(append) -> prune -> updateGameState.
 * The sim FREEZES once the game is won/lost (simulationTick returns early) but
 * rendering continues so the end screen shows.
 */

import {
  SIM_HZ,
  CELL_SIZE,
  WORLD_W,
  WORLD_H,
  SURVIVOR_COUNT,
  STARTING_WOOD,
  STARTING_STONE,
  STARTING_AMMO,
  SURFACE_BASE_Y,
} from './config';
import { initInput, setTargetBody, setSurvivors, setZombies, refreshBuildButtons, getSelectedSurvivor } from './input';
import { initRenderer, getRenderer, setBodies, setZombieBodies, setSurvivorRender, setCorpseBodies } from './render/renderer';
import { tickCorpseDecay, buildCorpseRenderList } from './characters/corpseLifecycle';
import { camera, clampCamera, effectiveCellPx } from './camera';
import { lodWindow, survivorShouldRun, zombieShouldRun } from './game/lod';
import * as simulation from './engine/simulation';
import { createSurvivor, updateSurvivor, assignRole } from './characters/survivor';
import type { Survivor } from './characters/survivor';
import { updateZombie } from './characters/zombie';
import { rebuildZombieFooting } from './characters/zombieFooting';
import type { Zombie } from './characters/zombie';
import { updateInfection } from './characters/infection';
import { resolveBreaching } from './game/breaching';
import { createWaveState, updateWaves } from './game/waves';
import { makeTool, ROLE_TINT } from './game/roles';
import { rebuildNavgrid } from './engine/navgrid';
import { addResource, setStockpilePoint, getStockpile, setAmmo, getAmmo } from './game/resources';
import { resetQueue } from './game/buildqueue';
import { updateGroups, resetGroups } from './game/groups';
import { resetShelters } from './game/shelter';
import { resetHuts, getHutVersion, latestHut } from './game/prefabs';
import { updateArrows, resetArrows } from './game/projectiles';
import { updateSpikeContact } from './game/traps';
import { generateWorld } from './game/worldgen';
import { createGameState, updateGameState } from './game/state';
import {
  drawNeedsBars,
  drawEdgeArrows,
  drawMinimap,
  drawToasts,
  drawEndScreen,
  drawUnderAttackAlert,
  pushToast,
  getSimSpeed,
  directionToWorldX,
  drawHitFlashes,
  drawWeather,
  advanceHitFlashes,
  drawSelectionHighlight,
  drawArrows,
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
  // Render in CSS pixels (chunky cells - GDD 12.4 keep cells chunky / small grid).
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
// primary navigation (GDD 12.1), so we FRAME the camera vertically on the
// surface (where the colony, survivors and zombies are) instead of showing the
// empty sky at y=0. Surface sits ~30% down the viewport, leaving sky above and
// the dig-down terrain below. Updated to the real spawn surface after worldgen.
let framedSurfaceRow = SURFACE_BASE_Y;
function frameCameraVertically(): void {
  const r = getRenderer();
  const visibleRows = r.viewportHeightPx / effectiveCellPx();
  camera.y = framedSurfaceRow - visibleRows * 0.3;
  clampCamera(r.viewportWidthPx, r.viewportHeightPx);
}

// ============================================================================
// Initialize renderer and input FIRST - resizeCanvas() calls getRenderer(),
// so the renderer singleton must exist before the initial sizing pass and
// before the resize listener can fire. (Init-order matters here - the smoke
// test guards this; do NOT reorder.)
// ============================================================================

const renderer = initRenderer(canvas, ctx);
initInput(canvas);

resizeCanvas();
window.addEventListener('resize', resizeCanvas);
// GDD 12.4: re-frame + re-clamp when the device rotates (orientation change
// fires on mobile before/instead of resize in some browsers). Calls the same
// resizeCanvas so the canvas backing store, renderer viewport, and camera clamp
// all stay consistent - ImageData == backing store invariant is preserved.
window.addEventListener('orientationchange', resizeCanvas);

// ============================================================================
// World generation (task 9-7, GDD 5.3)
//
// generateWorld() writes the layered terrain straight into the grid's typed
// arrays (no markTerrainEdit), so we MUST rebuildNavgrid() afterwards before the
// loop starts - survivors path on the coarse navgrid from tick 0 (GDD 13).
//
// The result gives us: a safe spawn column away from the zombie edge, a drop row
// above the local surface, a surface stockpile point, and which edge the horde
// streams in from (waves.ts already honours ZOMBIE_SPAWN_EDGE - world.zombieEdge
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
// looking at their base - not the empty far edge where zombies spawn. Horizontal
// drag pans from here; off-screen edge arrows point to incoming herds.
{
  const r = getRenderer();
  camera.x = world.spawnX - r.viewportWidthPx / effectiveCellPx() / 2;
  clampCamera(r.viewportWidthPx, r.viewportHeightPx);
}

// Colony stockpile sits on the surface inside the spawn zone (GDD 8 deposit loc).
setStockpilePoint(world.stockpilePoint.x, world.stockpilePoint.y);

// CB-6 (GDD 6.2): clear the global Blueprint queue on world (re)init so no
// stale player blueprints leak across a restart/hot-reload. Mirrors the fresh
// wave/state init below; the builder role drains this same live queue that the
// Plan tool fills and the CB-5 overlay renders (getBlueprints() - one global).
resetQueue();

// VS-3 T5 (GDD 6.2): fresh grouping + shelter-project state on world (re)init,
// mirroring resetQueue above - no stale group edges or planned huts leak across
// a restart/hot-reload. (Autonomous coop CAMP-building is retired in round 11 -
// updateCoopBuild is no longer called - but groups still steer warmth-seeking
// and shelter.ts still backs the headless suites, so both get a clean reset.)
resetGroups();
resetShelters();

// Round 11: the camp flag is retired - the player designates camp by BUYING A
// HUT (game/prefabs.ts). Fresh registries for huts and guard arrows, and
// prompt the player once.
resetHuts();
resetArrows();
pushToast('Buy a \u2302 Hut to set up camp - survivors move in for warmth');

// Starting resources so the first tool/wall can be crafted/built on load
// (GDD 6.2 tool-gating, 8 build affordability).
addResource('wood', STARTING_WOOD);
addResource('stone', STARTING_STONE);
setAmmo(STARTING_AMMO); // limited bullets for the Shoot tool (playtest)

// ============================================================================
// Survivors (GDD 6.1) - SURVIVOR_COUNT spawned in a loose cluster around the
// spawn column, dropped a body-height above the surface so they fall onto it.
// ============================================================================

const survivors: Survivor[] = [];

for (let i = 0; i < SURVIVOR_COUNT; i++) {
  // Task W5: the colony LIVES inside the starter camp. The nook interior is
  // narrow (the wide SURVIVOR_SPAWN_SPREAD would land survivors outside the
  // walls), so cluster them tightly around the shelter point - within the
  // standable interior, where the central cells are sheltered and the rest
  // walk one cell to retreat into the warm nook (GDD 8/10).
  const offsetX = i - Math.floor(SURVIVOR_COUNT / 2); // -2..+1 for 4 survivors
  survivors.push(
    createSurvivor(world.shelterPoint.x + offsetX, world.shelterPoint.y),
  );
}

// Register all survivor bodies with per-role tints so they are drawn each frame
// (p11-5, GDD 12 readability). 'none' role -> null tint (authored colours kept).
setSurvivorRender(survivors.map((s) => ({
  body: s.body,
  tint: s.role === 'none' ? null : ROLE_TINT[s.role],
})));

// Wire the Shoot tool to survivors[0] (keeps the Phase-4 hand-test functional).
setTargetBody(survivors[0].body);

// Expose survivors to the Assign tool (GDD 6.2).
setSurvivors(survivors);

// ============================================================================
// Colony defence (GDD 7.2/6.2): arm survivors[0] as a GUARD so it engages the
// horde near the colony. Hand it a weapon directly (no stockpile spend) then
// assign the role - assignRole keeps the matching held tool.
// ============================================================================

survivors[0].tool = makeTool('weapon');
assignRole(survivors[0], 'guard');

// ============================================================================
// Zombies & waves (GDD 7.1). `zombies` is the live array; the renderer and the
// Shoot tool hold the SAME reference so it stays current as we push/splice.
// ============================================================================

const zombies: Zombie[] = [];
const waveState = createWaveState();

setZombies(zombies); // Shoot tool can headshot zombies
setZombieBodies([]); // renderer's green-tinted zombie layer (empty at start)
setCorpseBodies([]); // corpse layer (empty at start - revised death model, task 2)

// ============================================================================
// Game state machine (GDD 11/12.2): win/lose, wave mirror, death log.
// ============================================================================

const gameState = createGameState();

// Cursor into gameState.deathLog of the last death we have already toasted
// (GDD 12.2 death legibility). With <= SURVIVOR_COUNT survivors the log never
// reaches its 8-entry cap, so a simple monotone cursor is sufficient.
let deathToastCursor = 0;

// Cache the stockpile readout element for efficient per-frame update (GDD 8).
const stockpileReadoutEl = document.getElementById('stockpile-readout') as HTMLElement | null;

// ============================================================================
// Optional arrow-key dev nudge for survivors[0] (does NOT conflict with the AI -
// updateSurvivor re-overrides moveDir every tick).
// ============================================================================

let leftArrowHeld = false;
let rightArrowHeld = false;

// Last hut version we re-homed the colony for (round 11 - huts ARE the camp).
// 0 = no hut yet, so the first purchase always triggers the re-home.
let lastHutVersion = 0;

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
 *   1. simulation.step()  - advance the falling-sand CA (GDD 5.2).
 *   2. updateZombie()     - drive zombies first (melee through THE GATE).
 *   3. updateSurvivor()   - drive each survivor's body + needs (GDD 6.1); the
 *                           guard engages the horde (GDD 7.2).
 *   4. resolveBreaching() - zombies gnaw structures they're pressing (GDD 7.4).
 *   5. updateWaves()      - trickle fresh zombies in from the edge (GDD 7.1).
 *   6. prune dead zombies (in place - shared array reference).
 *   7. updateGameState()  - win/lose + death watcher (GDD 11/12.2).
 */
function simulationTick(): void {
  // Freeze the whole sim once the game is decided (GDD 11). Rendering (incl.
  // the end screen) still runs from renderLoop.
  if (gameState.status !== 'playing') return;

  // Phase 1/2: advance the falling-sand cellular update one tick (GDD 5.2).
  simulation.step();
  // Advance hit-flash timers once per sim tick so rings expand at sim rate
  // regardless of the getSimSpeed() multiplier (task 11-7, GDD 12 UX).
  advanceHitFlashes();

  // Body LOD (task 11-3, GDD 13): a body that is BOTH far off-screen AND idle
  // (and grounded, not being attacked) runs its controller only every
  // BODY_LOD_THROTTLE-th tick - invisible and cheap for a distant idler. Bodies
  // on-screen, mid-fall, pursuing/attacking, being attacked, or self-preserving
  // update every tick (no missed combat / fall / needs-death). Compute the
  // visible window + the opposing body lists once for this tick's gate checks.
  const win = lodWindow(
    camera.x,
    camera.y,
    renderer.viewportWidthPx,
    renderer.viewportHeightPx,
    effectiveCellPx(),
  );
  const survivorBodies = survivors.map((s) => s.body);
  const zombieBodiesNow = zombies.map((z) => z.body);

  // Rebuild the ephemeral zombie "body footing" set (post-MVP ladder-climb,
  // playtest v0.5 #A) from the tick-start positions BEFORE any zombie moves, so
  // every zombie's climb check this tick reads the same order-independent
  // snapshot of where ally bodies are piled (GDD 7.1 funnel / 13 perf).
  rebuildZombieFooting(zombies);

  // Drive zombies FIRST so survivor combat + breaching read fresh zombie state.
  // The full zombie list is passed as the herd (GDD 7.1 herd behaviour): idle
  // zombies bias their meander goals toward nearby allies and clump up.
  for (let i = 0; i < zombies.length; i++) {
    const z = zombies[i];
    if (zombieShouldRun(z, i, win, survivorBodies, tickCount)) {
      updateZombie(z, survivors, zombies);
    }
  }

  // Update every survivor (owns its body drive - GDD 6.1). The zombie list is
  // passed so an armed guard engages the horde (GDD 7.2).
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
    if (survivorShouldRun(s, i, win, zombieBodiesNow, tickCount)) {
      updateSurvivor(s, zombies);
    }
  }

  // Infection progression (revised death model, GDD 5.1/7.2): tick each
  // infected survivor's turn clock - act -> prone -> REANIMATE as a zombie that
  // reuses the same body and joins the horde (pushed onto `zombies`). Runs after
  // the survivor updates so a body downed this tick is honoured, and before the
  // prune/state pass so a freshly reanimated zombie is counted/rendered.
  updateInfection(survivors, zombies, tickCount);

  // Round 11: survivors NO LONGER build their own camp (updateCoopBuild is
  // retired from the live loop - "leaving the survivors to create their own
  // camp is not working"). The player buys pre-built HUTS instead: when a hut
  // is purchased (game/prefabs.ts bumps the hut version), RE-HOME every living
  // survivor to its interior so the colony walks over - idle wander orbits
  // `home`, and the hut's roof + lit hearth feed the warmth need directly.
  // updateGroups keeps running: groupIds still steer warmth-seeking and the
  // split/merge debounce.
  if (getHutVersion() !== lastHutVersion) {
    lastHutVersion = getHutVersion();
    const hut = latestHut();
    if (hut) {
      for (const s of survivors) {
        if (!s.body.alive || s.turned) continue;
        s.home.x = hut.x;
        s.home.y = hut.y;
      }
    }
  }

  updateGroups(survivors, tickCount);

  // Round 11 spike traps: each alive zombie in contact with SPIKE cells may
  // lose a leg this tick (game/traps.ts, THE GATE). Survivors are exempt -
  // they pick their way between their own stakes.
  for (const z of zombies) {
    if (z.body.alive) updateSpikeContact(z.body);
  }

  // Round 11 guard arrows: advance every arrow in flight (ballistic sweep,
  // terrain stops, zombie wounds through THE GATE). After the survivor pass so
  // an arrow loosed this tick starts flying next tick.
  updateArrows(zombies);

  // Zombies gnaw through structures they're pressing (GDD 7.4). After
  // updateZombie so moveDir/facing reflect this tick's intent.
  resolveBreaching(zombies);

  // Escalating waves (GDD 7.1): append fresh spawns to the live array. R9:
  // spawns drip intermittently, and some BURROW UP near the colony (the spawn
  // column is the burrow centre) instead of walking in from the edge.
  const aliveBeforeSpawn = zombies.filter((z) => z.body.alive).length;
  const fresh = updateWaves(waveState, aliveBeforeSpawn, world.spawnX);
  for (const f of fresh) zombies.push(f);

  // Prune fully-dead zombies every so often so the array can't grow unbounded.
  // Splice IN PLACE - the renderer and Shoot tool hold this same reference.
  tickCount++;
  if (tickCount % 120 === 0) {
    for (let i = zombies.length - 1; i >= 0; i--) {
      if (!zombies[i].body.alive) zombies.splice(i, 1);
    }
  }

  // Register the (possibly changed) zombie bodies with the renderer.
  setZombieBodies(zombies.map((z) => z.body));

  // Corpse lifecycle (task 2, revised death model, GDD 5.1/13):
  //   1. Decay: decrement corpseTicks; retire (corpse=false) when reaching 0.
  //   2. Cap: if >MAX_CORPSES active corpses, retire oldest (lowest corpseTicks).
  //   3. Hand the active corpse list to the renderer for grey-tinted drawing.
  const allBodies = survivors.map((s) => s.body);
  tickCorpseDecay(allBodies);
  setCorpseBodies(buildCorpseRenderList(allBodies));

  // Re-register survivor bodies with up-to-date role tints each tick so that
  // a role re-assignment (Assign tool) is reflected in the next rendered frame
  // (p11-5, GDD 12 readability - draw-time only, no body/grid mutation).
  // EXCLUDE turned survivors (GDD 7.2): their body now renders via the green
  // zombie layer (setZombieBodies), not as a survivor.
  setSurvivorRender(survivors.filter((s) => !s.turned).map((s) => ({
    body: s.body,
    tint: s.role === 'none' ? null : ROLE_TINT[s.role],
  })));

  // Advance the win/lose state machine + death watcher (GDD 11/12.2).
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
 *   P         - pause / resume
 *   . or ]    - manual step (one tick while paused)
 *   ArrowLeft / ArrowRight - nudge survivors[0] (optional dev tool)
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
 * Toast any NEW death-log entries (GDD 12.2 death legibility). Off-screen
 * deaths get a <-/-> prefix so the player knows which way to look.
 */
function flushDeathToasts(): void {
  const vpW = renderer.viewportWidthPx;
  while (deathToastCursor < gameState.deathLog.length) {
    const e = gameState.deathLog[deathToastCursor];
    const dir = directionToWorldX(e.x, camera, vpW);
    const prefix = dir ? dir + ' ' : '';
    // GDD 12.2: show a natural-language message per death cause.
    // 'bitten - turned' gets a distinct warning; 'frozen' gets its own
    // natural-language message (Task W4); all other causes use the
    // generic 'Survivor died: <cause>' format (starvation, thirst, etc.).
    let msg: string;
    if (e.cause.includes('turned')) {
      msg = prefix + '\u26a0 A survivor was bitten and turned!';
    } else if (e.cause === 'frozen') {
      msg = prefix + 'A survivor froze';
    } else {
      msg = prefix + 'Survivor died: ' + e.cause;
    }
    pushToast(msg);
    deathToastCursor++;
  }
}

/**
 * Main render loop: fixed-timestep accumulator pattern, running getSimSpeed()
 * sim ticks per accumulator step (GDD 12.2 sim-speed). Pause + single-step are
 * preserved.
 */
function renderLoop(): void {
  const now = performance.now();
  const deltaTime = now - lastFrameTime;
  lastFrameTime = now;

  accumulator += deltaTime;
  while (accumulator >= frameTimeMs) {
    if (!isPaused) {
      // Sim-speed multiplier: run N ticks per fixed step (GDD 12.2). Each
      // simulationTick self-freezes once the game is decided, so over-running
      // here is harmless at the end.
      const steps = getSimSpeed();
      for (let i = 0; i < steps; i++) simulationTick();
    }
    accumulator -= frameTimeMs;
  }

  // Cells + bodies + FPS (renderer owns the main ctx).
  renderer.render();

  // UI overlays, drawn on the same ctx in z-order (GDD 12.1/12.2).
  flushDeathToasts();
  const vpW = renderer.viewportWidthPx;
  const vpH = renderer.viewportHeightPx;
  // task 11-7: brief expanding ring at hit locations (GDD 12 UX readability).
  drawHitFlashes(ctx, camera, vpW, vpH);
  // VS-1 T5: precipitation overlay + always-on weather/temperature readout (GDD 10).
  drawWeather(ctx);
  // v0.8 playtest K: selection box that tracks the role-menu's survivor.
  drawSelectionHighlight(ctx, getSelectedSurvivor());
  // Round 11: guard arrows in flight, camera-tracked.
  drawArrows(ctx);
  drawNeedsBars(ctx, survivors);
  drawEdgeArrows(ctx, zombies, camera, vpW, vpH);
  // task 11-4: off-screen breach alert (GDD 12.1 / 7.4).
  drawUnderAttackAlert(ctx, camera, vpW, vpH);
  drawMinimap(ctx, { survivors, zombies, camera, viewportWpx: vpW, viewportHpx: vpH });
  drawToasts(ctx);
  drawEndScreen(ctx, gameState); // only dims when not playing

  // Stockpile HUD readout (GDD 8).
  if (stockpileReadoutEl) {
    const sp = getStockpile();
    stockpileReadoutEl.textContent =
      `Wood ${sp.wood}  Stone ${sp.stone}  Food ${sp.food}  Ore ${sp.ore}  Ammo ${getAmmo()}`;
  }

  // Refresh build-button affordability (GDD 8).
  refreshBuildButtons();

  requestAnimationFrame(renderLoop);
}

// Start the loop
requestAnimationFrame(renderLoop);

console.log('Gravegrain Phase 9 initialized (task 9-7 full loop active)');
console.log(`World: ${WORLD_W}x${WORLD_H} cells, ${WORLD_W * CELL_SIZE}x${WORLD_H * CELL_SIZE}px`);
console.log(
  `Simulation: ${SIM_HZ} Hz | Survivors: ${SURVIVOR_COUNT} | Spawn: x=${world.spawnX} | Zombie edge: ${world.zombieEdge}`,
);
console.log('Controls: P = pause; . or ] = step; ArrowLeft/Right = nudge survivors[0]; tap a survivor in Pan mode to assign a role; Debug button reveals shoot/ignite/plan/campfire/door; speed button cycles 1x/2x/3x');
