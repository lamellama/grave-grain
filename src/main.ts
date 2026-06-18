/**
 * main.ts — Gravegrain Phase 0 bootstrap and fixed-timestep game loop
 * GDD §12: wide world, horizontal scroll, pointer-first input.
 * Fixed-timestep loop at SIM_HZ, decoupled from requestAnimationFrame render.
 */

import { SIM_HZ, CELL_SIZE, WORLD_W, WORLD_H } from './config';
import { initInput } from './input';
import { initRenderer, getRenderer } from './render/renderer';
import { clampCamera } from './camera';
import * as grid from './engine/grid';

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
// Debug fill: seed the grid with a pattern across the full WORLD_W
// This makes horizontal scrolling visually obvious.
// Pattern: vertical colour bands (alternating 0 and 1 every 40 columns).
// ============================================================================

function seedDebugPattern(): void {
  const bandWidth = 40;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const band = Math.floor(x / bandWidth);
      const material = band % 2; // Alternates between 0 (dark) and 1 (white)
      grid.set(x, y, material);
    }
  }
}

seedDebugPattern();

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
  // Phase 0: no simulation yet.
  // Phase 1+ will add falling-sand updates here.
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

console.log('Gravegrain Phase 0 initialized');
console.log(`World: ${WORLD_W}×${WORLD_H} cells, ${WORLD_W * CELL_SIZE}×${WORLD_H * CELL_SIZE}px`);
console.log(`Simulation: ${SIM_HZ} Hz`);
console.log('Controls: drag to pan, P to pause, . or ] to step');
