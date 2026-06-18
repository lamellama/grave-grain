/**
 * main.ts — Gravegrain Phase 3 bootstrap and fixed-timestep game loop
 * GDD §12: wide world, horizontal scroll, pointer-first input.
 * Fixed-timestep loop at SIM_HZ, decoupled from requestAnimationFrame render.
 *
 * p3-t5: wires the hybrid Body into the loop and provides a throwaway arrow-key
 * driver + default pacer so the Phase-3 locomotion (p3-t2/t3) is exercisable in
 * the dev server. No locomotion logic lives here — this file is pure glue.
 */

import {
  SIM_HZ,
  CELL_SIZE,
  WORLD_W,
  WORLD_H,
  BODY_SPAWN_X,
  BODY_SPAWN_Y,
  P3_GROUND_Y,
  P3_STEP_X,
  P3_STEP_W,
  P3_PIT_X,
  P3_PIT_W,
  P3_PIT_DEPTH,
  P3_PACE_LEFT,
  P3_PACE_RIGHT,
  P3_STALL_TICKS,
} from './config';
import { initInput, setTargetBody } from './input';
import { initRenderer, getRenderer, setBody } from './render/renderer';
import { clampCamera } from './camera';
import * as grid from './engine/grid';
import * as simulation from './engine/simulation';
import { STONE } from './engine/materials';
import { createBody } from './characters/body';
import { updateBody } from './characters/locomotion';

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

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ============================================================================
// Initialize renderer and input
// ============================================================================

const renderer = initRenderer(canvas, ctx);
initInput(canvas);

// ============================================================================
// Phase-3 hybrid body (p3-t5 wiring)
// GDD §5.1 / §14 Milestone 0: spawn the lone survivor and register it with the
// renderer so it is drawn over the cell layer each frame.
// ============================================================================

const body = createBody(BODY_SPAWN_X, BODY_SPAWN_Y);
setBody(body); // renderer draws it every frame from here on
setTargetBody(body); // Shoot tool damages this body (GDD §14 hand-test, p4-t7)

// ============================================================================
// Phase-3 test terrain (p3-t5)
// Uneven stone ground with a 1-cell step and a dug pit near BODY_SPAWN_X so
// locomotion is immediately visible. Throwaway; replaced by real level seeding.
//
// Layout (y increases downward, body feet rest at P3_GROUND_Y-1 on flat ground):
//
//   flat floor  .... [STEP 20 cells] ........ [PIT 12 cells] ....
//   y=P3_GROUND_Y  STONE (full width)
//   y=P3_GROUND_Y-1  STONE for the 1-cell-high step block
//   pit: gap in floor + deeper stone floor at y=P3_GROUND_Y+P3_PIT_DEPTH
//
// The body spawns at (BODY_SPAWN_X, BODY_SPAWN_Y) and falls onto the flat
// ground west of the step. Arrow keys / the pacer then drive it right so it
// climbs the step and (eventually) falls into the pit.
// ============================================================================

function seedTestScene(): void {
  // --- Main stone floor (full world width) ---
  for (let x = 0; x < WORLD_W; x++) {
    // Skip the pit columns at the main floor level (they get a deeper floor).
    if (x >= P3_PIT_X && x < P3_PIT_X + P3_PIT_W) continue;
    grid.set(x, P3_GROUND_Y, STONE);
  }

  // --- 1-cell step: raise the ground by one cell over P3_STEP_W columns ---
  // Also lay the underlying floor row so there is no void below the step.
  for (let x = P3_STEP_X; x < P3_STEP_X + P3_STEP_W; x++) {
    grid.set(x, P3_GROUND_Y - 1, STONE); // the raised surface
    // P3_GROUND_Y row already set above, so no gap beneath the step.
  }

  // --- Pit: remove the floor in the gap, add a deeper pit floor ---
  // P3_PIT_DEPTH cells below P3_GROUND_Y gives a floor the body can't step out
  // of (deeper than STEP_UP_MAX=1), so the pacer stall-flip is observable.
  for (let x = P3_PIT_X; x < P3_PIT_X + P3_PIT_W; x++) {
    grid.set(x, P3_GROUND_Y + P3_PIT_DEPTH, STONE); // pit floor
  }
}

seedTestScene();

// ============================================================================
// p3-t5 temporary driver state
// Arrow-key hold flags drive body.moveDir directly when held.
// When neither arrow is held the pacer script takes over.
// ============================================================================

let leftArrowHeld = false;
let rightArrowHeld = false;

// Pacer state: current intended direction and stall counter.
// Starts walking right so the body immediately climbs the step.
let pacerDir: -1 | 1 = 1;
let pacerLastX = BODY_SPAWN_X;
let pacerStallCount = 0;

/**
 * Advance the pacer one tick.
 * Flips direction when the body stalls (wall or pit) or reaches the x-bounds.
 * Only called when no arrow key is held.
 */
function stepPacer(): void {
  const bx = Math.round(body.x);

  // Bounds flip
  if (bx <= P3_PACE_LEFT && pacerDir === -1) {
    pacerDir = 1;
    pacerStallCount = 0;
  } else if (bx >= P3_PACE_RIGHT && pacerDir === 1) {
    pacerDir = -1;
    pacerStallCount = 0;
  }

  // Stall detection: if x hasn't changed since last tick, increment counter.
  if (bx === pacerLastX) {
    pacerStallCount++;
    if (pacerStallCount >= P3_STALL_TICKS) {
      pacerDir = pacerDir === 1 ? -1 : 1;
      pacerStallCount = 0;
    }
  } else {
    pacerStallCount = 0;
  }

  pacerLastX = bx;
  body.moveDir = pacerDir;
}

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
 *   2. Drive body.moveDir: arrow keys override; pacer fills in otherwise.
 *   3. Advance body locomotion one tick (GDD §5.1, §14 Milestone 0).
 * All three happen in lockstep so the body always reads fresh CA state.
 */
function simulationTick(): void {
  // Phase 1/2: advance the falling-sand cellular update one tick (GDD §5.2).
  simulation.step();

  // p3-t5: drive moveDir, then update the body.
  // Arrow keys take priority; pacer takes over when none are held.
  if (leftArrowHeld && !rightArrowHeld) {
    body.moveDir = -1;
    // Keep facing consistent even when arrow is held.
    body.facing = -1;
    // Reset pacer stall so it resumes smoothly when the key is released.
    pacerLastX = Math.round(body.x);
    pacerStallCount = 0;
  } else if (rightArrowHeld && !leftArrowHeld) {
    body.moveDir = 1;
    body.facing = 1;
    pacerLastX = Math.round(body.x);
    pacerStallCount = 0;
  } else {
    // No arrow (or both held): hand control back to the pacer.
    stepPacer();
  }

  // Advance the body (locomotion.ts — GDD §5.1 fall + walk).
  updateBody(body);
}

/**
 * Handle keyboard input:
 *   P         — pause / resume
 *   . or ]    — manual step (one tick while paused)
 *   ArrowLeft / ArrowRight — override pacer, drive body.moveDir
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

  // p3-t5 arrow key driver
  if (event.key === 'ArrowLeft') {
    leftArrowHeld = true;
    event.preventDefault(); // avoid page scroll
  }
  if (event.key === 'ArrowRight') {
    rightArrowHeld = true;
    event.preventDefault();
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft') {
    leftArrowHeld = false;
    // On release: stop immediately and hand back to pacer.
    if (!rightArrowHeld) body.moveDir = 0;
    pacerLastX = Math.round(body.x);
    pacerStallCount = 0;
  }
  if (event.key === 'ArrowRight') {
    rightArrowHeld = false;
    if (!leftArrowHeld) body.moveDir = 0;
    pacerLastX = Math.round(body.x);
    pacerStallCount = 0;
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

  // Accumulate time and run fixed-timestep ticks.
  accumulator += deltaTime;
  while (accumulator >= frameTimeMs) {
    if (!isPaused) {
      simulationTick();
    }
    accumulator -= frameTimeMs;
  }

  // Render the current state (cell layer + body overlay + FPS).
  renderer.render();

  // Request next frame.
  requestAnimationFrame(renderLoop);
}

// Start the loop
requestAnimationFrame(renderLoop);

console.log('Gravegrain Phase 3 initialized (p3-t5 body driver active)');
console.log(`World: ${WORLD_W}×${WORLD_H} cells, ${WORLD_W * CELL_SIZE}×${WORLD_H * CELL_SIZE}px`);
console.log(`Simulation: ${SIM_HZ} Hz`);
console.log('Controls: ArrowLeft/ArrowRight = drive body; P = pause; . or ] = step; toolbar = paint/pan/ignite');
console.log(`Body spawned at (${BODY_SPAWN_X}, ${BODY_SPAWN_Y}) — falls onto ground at y=${P3_GROUND_Y}`);
