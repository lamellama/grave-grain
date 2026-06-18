/**
 * render/renderer.ts — Visible-window rendering for the cell layer
 * GDD §13: render only the visible column range, not the whole world.
 * Honour devicePixelRatio; keep cells chunky.
 */

import { CELL_SIZE, WORLD_W, WORLD_H } from '../config';
import { camera, clampCamera, worldToScreen } from '../camera';
import * as grid from '../engine/grid';
import { MATERIALS } from '../engine/materials';
import { type Body } from '../characters/body';

/**
 * Pre-parsed material colours: RGB[material_id] = [r, g, b] tuple.
 * Built at init from MATERIALS table hex colours.
 * Avoids per-cell parseInt overhead in hot render loop.
 */
let RGB_PALETTE: Array<[number, number, number]> = [];

/**
 * Parse hex colour string (#RRGGBB) to RGB tuple.
 * Assumes valid 7-char hex input.
 */
function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

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

  // GDD §5.1 / §14 Milestone 0: the active hybrid body to overlay on the cell layer.
  private body: Body | null = null;

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
    this.initializePalette();
    this.onResize();
  }

  /**
   * Build RGB_PALETTE from MATERIALS table at init.
   * Pre-parse all material hex colours once, avoiding per-cell overhead.
   */
  private initializePalette(): void {
    RGB_PALETTE = MATERIALS.map((material) => hexToRgb(material.color));
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
   * Register (or clear) the Body that will be drawn over the cell layer.
   * Called from main.ts once a body is created (p3-t5 wiring).
   * GDD §5.1: the body is authored at cell resolution so it sits flush with the grid.
   */
  setBody(body: Body | null): void {
    this.body = body;
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
        const [r, g, b] = RGB_PALETTE[material] || RGB_PALETTE[0];

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

    // GDD §5.1 / §14 Milestone 0: draw the hybrid body over the cell layer.
    // Each body pixel fills exactly one CELL_SIZE×CELL_SIZE rect at the same
    // screen position the cell layer would use for that world cell — guaranteeing
    // pixel-perfect alignment with the CA grid (same formula: (wx - camera.x)*CELL_SIZE).
    this.drawBody();

    // Draw FPS counter.
    this.drawFps();

    // Update FPS counter.
    this.updateFps();
  }

  /**
   * Draw the hybrid body's bone pixels over the cell layer.
   * GDD §5.1: body pixels are at cell resolution → worldToScreen gives the
   * identical top-left as the ImageData loop above (same formula), so the body
   * sits exactly on the grid and stays locked to the world while panning.
   * Skips destroyed bones and off-screen pixels.
   */
  private drawBody(): void {
    const body = this.body;
    if (!body || !body.alive) return;

    const vw = this.viewportWidthPx;
    const vh = this.viewportHeightPx;
    const ctx = this.ctx;
    const bx = Math.round(body.x);
    const by = Math.round(body.y);

    for (const bone of body.rig) {
      if (bone.destroyed) continue;
      for (const pixel of bone.pixels) {
        // World cell this pixel occupies (GDD §5.1 pixel formula).
        const wx = bx + bone.offset.dx + pixel.dx;
        const wy = by + bone.offset.dy + pixel.dy;

        // Screen top-left — identical math to the ImageData cell loop above.
        const { x: sx, y: sy } = worldToScreen(wx, wy);
        const sx0 = Math.floor(sx);
        const sy0 = Math.floor(sy);

        // Skip if the rect is fully outside the viewport.
        if (sx0 + CELL_SIZE <= 0 || sx0 >= vw) continue;
        if (sy0 + CELL_SIZE <= 0 || sy0 >= vh) continue;

        ctx.fillStyle = pixel.color;
        ctx.fillRect(sx0, sy0, CELL_SIZE, CELL_SIZE);
      }
    }
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

/**
 * Register (or clear) the body drawn by the renderer.
 * Module-level convenience wrapper — mirrors the getRenderer() export pattern.
 * Call after initRenderer() has been called.
 * GDD §5.1 / §14 Milestone 0.
 */
export function setBody(body: Body | null): void {
  getRenderer().setBody(body);
}
