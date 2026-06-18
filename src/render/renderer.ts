/**
 * render/renderer.ts — Visible-window rendering for the cell layer
 * GDD §13: render only the visible column range, not the whole world.
 * Honour devicePixelRatio; keep cells chunky.
 */

import { CELL_SIZE, WORLD_W, WORLD_H } from '../config';
import { camera, clampCamera, worldToScreen } from '../camera';
import * as grid from '../engine/grid';

/**
 * Colour palette for Phase 0 (debug / minimal).
 * 0 (AIR) = dark background
 * 1 (debug fill) = white
 * More materials will be added in Phase 1.
 */
const COLOURS: Record<number, string> = {
  0: '#1a1a1a', // AIR / empty
  1: '#ffffff', // debug fill / light
};

/**
 * Renderer state: canvas, context, and internal buffers.
 */
class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;

  viewportWidthPx = 0;
  viewportHeightPx = 0;
  dpr = 1;

  // FPS tracking
  frameCount = 0;
  lastFpsTime = 0;
  currentFps = 0;

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
    this.onResize();
  }

  /**
   * Handle window resize: update viewport size and clamp camera.
   */
  onResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.viewportWidthPx = rect.width;
    this.viewportHeightPx = rect.height;
    clampCamera(this.viewportWidthPx, this.viewportHeightPx);
  }

  /**
   * Render one frame of the cell layer.
   * Only renders the visible column range (GDD §13).
   */
  render(): void {
    // Calculate visible column range in cells.
    const visibleStartX = Math.floor(camera.x);
    const visibleStartY = Math.floor(camera.y);
    const visibleEndX = Math.ceil(camera.x + this.viewportWidthPx / CELL_SIZE);
    const visibleEndY = Math.ceil(camera.y + this.viewportHeightPx / CELL_SIZE);

    // Clamp to world bounds to avoid OOB reads.
    const startX = Math.max(0, visibleStartX);
    const startY = Math.max(0, visibleStartY);
    const endX = Math.min(WORLD_W, visibleEndX);
    const endY = Math.min(WORLD_H, visibleEndY);

    // Create an ImageData sized to the viewport (in screen pixels).
    // Each cell is CELL_SIZE pixels; we'll fill it with a solid colour.
    const imageData = this.ctx.createImageData(this.viewportWidthPx, this.viewportHeightPx);
    const data = imageData.data; // RGBA tuples

    // Fill the ImageData with the visible grid cells.
    for (let cellY = startY; cellY < endY; cellY++) {
      for (let cellX = startX; cellX < endX; cellX++) {
        // Get the material at this cell.
        const material = grid.get(cellX, cellY);
        const colour = COLOURS[material] || COLOURS[0];

        // Convert hex to RGB (simple version — assumes #RRGGBB).
        const r = parseInt(colour.slice(1, 3), 16);
        const g = parseInt(colour.slice(3, 5), 16);
        const b = parseInt(colour.slice(5, 7), 16);

        // Calculate the screen-pixel region for this cell.
        const screenX = (cellX - camera.x) * CELL_SIZE;
        const screenY = (cellY - camera.y) * CELL_SIZE;

        // Fill the cell's CELL_SIZE × CELL_SIZE region.
        for (let py = 0; py < CELL_SIZE; py++) {
          const pixelY = Math.floor(screenY) + py;
          if (pixelY < 0 || pixelY >= this.viewportHeightPx) continue;

          for (let px = 0; px < CELL_SIZE; px++) {
            const pixelX = Math.floor(screenX) + px;
            if (pixelX < 0 || pixelX >= this.viewportWidthPx) continue;

            const idx = (pixelY * this.viewportWidthPx + pixelX) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255; // alpha
          }
        }
      }
    }

    // Draw the ImageData to the canvas.
    this.ctx.putImageData(imageData, 0, 0);

    // Draw FPS counter.
    this.drawFps();

    // Update FPS counter.
    this.updateFps();
  }

  /**
   * Update FPS counter once per 500ms.
   */
  private updateFps(): void {
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 500) {
      this.currentFps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
  }

  /**
   * Draw FPS text on screen.
   */
  private drawFps(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.save();
    this.ctx.font = 'bold 16px monospace';
    this.ctx.fillStyle = '#00ff00';
    this.ctx.textAlign = 'left';
    this.ctx.fillText(`FPS: ${this.currentFps}`, 10, 25);
    this.ctx.restore();
  }
}

// Singleton renderer instance
let renderer: Renderer | null = null;

/**
 * Initialize the renderer.
 */
export function initRenderer(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Renderer {
  renderer = new Renderer(canvas, ctx);
  return renderer;
}

/**
 * Get the active renderer.
 */
export function getRenderer(): Renderer {
  if (!renderer) {
    throw new Error('Renderer not initialized');
  }
  return renderer;
}
