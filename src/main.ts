/**
 * main.ts — Gravegrain Phase 0 bootstrap and fixed-timestep game loop
 * GDD §12: wide world, horizontal scroll, pointer-first input.
 * Fixed-timestep loop at SIM_HZ, decoupled from requestAnimationFrame render.
 */

import {
  SIM_HZ,
  CELL_SIZE,
  WORLD_W,
  WORLD_H,
  TEST_FLOOR_TOP,
  TEST_FLOOR_THICKNESS,
  TEST_WATER_W,
  TEST_WATER_H,
  TEST_SAND_W,
  TEST_SAND_H,
  TEST_SAND_GAP,
} from './config';
import { initInput } from './input';
import { initRenderer, getRenderer } from './render/renderer';
import { clampCamera } from './camera';
import * as grid from './engine/grid';
import * as simulation from './engine/simulation';
import { SAND, STONE, WATER } from './engine/materials';

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
// Phase 1 test scene (p1-t4): a full-width STONE floor with a body of WATER
// resting on it, and a SAND blob suspended just above the water surface.
// On run, the water should seek its level (collapse to a flat sheet, never
// pile), and the sand should fall in and SINK through the water to the bottom
// while the displaced water rises above it (GDD §5.2 density swap).
// ============================================================================

function seedTestScene(): void {
  // Stone floor: full world width, TEST_FLOOR_THICKNESS rows thick.
  for (let y = TEST_FLOOR_TOP; y < TEST_FLOOR_TOP + TEST_FLOOR_THICKNESS; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      grid.set(x, y, STONE);
    }
  }

  // Water body: centred, resting directly on top of the floor.
  const waterBottom = TEST_FLOOR_TOP; // row just above the first stone row
  const waterTop = waterBottom - TEST_WATER_H;
  const waterLeft = Math.floor((WORLD_W - TEST_WATER_W) / 2);
  for (let y = waterTop; y < waterBottom; y++) {
    for (let x = waterLeft; x < waterLeft + TEST_WATER_W; x++) {
      grid.set(x, y, WATER);
    }
  }

  // Sand blob: centred, suspended TEST_SAND_GAP rows above the water surface.
  const sandBottom = waterTop - TEST_SAND_GAP;
  const sandTop = sandBottom - TEST_SAND_H;
  const sandLeft = Math.floor((WORLD_W - TEST_SAND_W) / 2);
  for (let y = sandTop; y < sandBottom; y++) {
    for (let x = sandLeft; x < sandLeft + TEST_SAND_W; x++) {
      grid.set(x, y, SAND);
    }
  }
}

seedTestScene();

// ============================================================================
// Fixed-timestep game loop
// ============================================================================

const frameTimeMs = 1000 / SIM_HZ;
let accumulator = 0;
let isPaused = false;
let lastFrameTime = performance.now();

/**
 * Simulation tick: currently a no-op (no falling-sand yet in Phase 0).
 * Will be populated in Phase 1.
 */
function simulationTick(): void {
  // Phase 1: advance the falling-sand cellular update one tick (GDD §5.2).
  simulation.step();
}

/**
 * Handle keyboard input: P = pause, . or ] = step one frame.
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
}

window.addEventListener('keydown', onKeyDown);

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

  // Render the current state.
  renderer.render();

  // Request next frame.
  requestAnimationFrame(renderLoop);
}

// Start the loop
requestAnimationFrame(renderLoop);

console.log('Gravegrain Phase 1 initialized');
console.log(`World: ${WORLD_W}×${WORLD_H} cells, ${WORLD_W * CELL_SIZE}×${WORLD_H * CELL_SIZE}px`);
console.log(`Simulation: ${SIM_HZ} Hz`);
console.log('Controls: use toolbar to select tool (Pan/Sand/Stone/Water/Erase), drag to use, P to pause, . or ] to step');
