/**
 * render/renderer.ts — Visible-window rendering for the cell layer
 * GDD §13: render only the visible column range, not the whole world.
 * Honour devicePixelRatio; keep cells chunky.
 */

import { WORLD_W, WORLD_H, BREACH_DARKEN_MAX, CHIP_FLASH_TICKS } from '../config';
import { camera, clampCamera, effectiveCellPx } from '../camera';
import * as grid from '../engine/grid';
import { MATERIALS } from '../engine/materials';
import { type Body } from '../characters/body';
import { recentChips, getBreachTick } from '../game/breaching';

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
 * Pure helper: darken an RGB triple in proportion to integrity lost (task 11-4).
 * GDD §7.4 / §12 UX readability — a structure cell visually "cracks" as it's
 * chipped, darkening by up to BREACH_DARKEN_MAX when integrity is near zero.
 *
 * factor = 1 - BREACH_DARKEN_MAX * (1 - ratio),  ratio = integrity / baseIntegrity
 *   ratio 1 (full)  → factor 1.0  → unchanged colour
 *   ratio 0 (near)  → factor ≈ 1 - BREACH_DARKEN_MAX  → maximally dark
 *
 * Returns the original rgb unchanged when baseIntegrity is 0 (non-integrity
 * material) so it is safe to call for any cell.
 *
 * Exported so `test/p11-breach-vis.test.ts` can test it in isolation without
 * spinning up the renderer. Keep it PURE (no side-effects, no globals read).
 */
export function breachDarken(
  rgb: [number, number, number],
  integrity: number,
  baseIntegrity: number,
): [number, number, number] {
  if (baseIntegrity <= 0) return rgb; // non-integrity material — unchanged
  const ratio = Math.max(0, Math.min(1, integrity / baseIntegrity));
  const factor = 1 - BREACH_DARKEN_MAX * (1 - ratio);
  return [
    Math.round(rgb[0] * factor),
    Math.round(rgb[1] * factor),
    Math.round(rgb[2] * factor),
  ];
}

/**
 * Zombie green-tint (p7-t7, render-only). Blends a body pixel's authored colour
 * toward a sickly green so zombies read as distinct from survivors WITHOUT
 * touching the underlying body matter — a shed zombie limb still falls as normal
 * FLESH/BONE/BLOOD cells (the CA illusion, GDD §14 gate point 5). Cached per
 * source colour (bodies use a tiny fixed palette) so the hot render loop never
 * re-parses the same hex.
 */
const ZOMBIE_TINT: [number, number, number] = [0x3a, 0x7a, 0x2a]; // sickly green
const ZOMBIE_TINT_MIX = 0.55; // fraction pulled toward green
const zombieTintCache = new Map<string, string>();
function tintZombie(color: string): string {
  const cached = zombieTintCache.get(color);
  if (cached) return cached;
  const [r, g, b] = hexToRgb(color);
  const m = ZOMBIE_TINT_MIX;
  const tr = Math.round(r * (1 - m) + ZOMBIE_TINT[0] * m);
  const tg = Math.round(g * (1 - m) + ZOMBIE_TINT[1] * m);
  const tb = Math.round(b * (1 - m) + ZOMBIE_TINT[2] * m);
  const out = `rgb(${tr},${tg},${tb})`;
  zombieTintCache.set(color, out);
  return out;
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

  // GDD §5.1 / §14 Milestone 0: all live hybrid bodies to overlay on the cell layer.
  // Widened from a single body to N bodies (p5-t5) so several survivors draw correctly.
  private bodies: Body[] = [];

  // p7-t7: render-only zombie bodies, drawn with a green tint over the cell layer.
  private zombieBodies: Body[] = [];

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
    // Integer CSS-px viewport so the ImageData size exactly matches the canvas
    // backing store (main sizes it to floor(rect.w/h) — no devicePixelRatio).
    this.viewportWidthPx = Math.max(1, Math.floor(rect.width));
    this.viewportHeightPx = Math.max(1, Math.floor(rect.height));
    clampCamera(this.viewportWidthPx, this.viewportHeightPx);
  }

  /**
   * Replace the rendered bodies list (p5-t5 N-body widening).
   * Pass an array of all live Survivor bodies; they are drawn in order.
   */
  setBodies(bodies: Body[]): void {
    this.bodies = [...bodies];
  }

  /**
   * Replace the render-only zombie body list (p7-t7). Tint is applied at draw
   * time only — these Body objects are NOT mutated, so their released cells stay
   * normal body matter (GDD §7.1 / §14 gate point 5).
   */
  setZombieBodies(bodies: Body[]): void {
    this.zombieBodies = [...bodies];
  }

  /** Add one body to the draw list without clearing the rest. */
  addBody(body: Body): void {
    this.bodies.push(body);
  }

  /** Remove all bodies from the draw list. */
  clearBodies(): void {
    this.bodies = [];
  }

  /**
   * Single-body shim — keeps existing callers (pre-p5-t5) compiling.
   * Replaces the whole list with just this body (or clears if null).
   * GDD §5.1: the body is authored at cell resolution so it sits flush with the grid.
   */
  setBody(body: Body | null): void {
    this.bodies = body ? [body] : [];
  }

  /**
   * Render one frame of the cell layer.
   * Only renders the visible column range (GDD §13).
   */
  render(): void {
    // Effective cell size in screen px (GDD §12.3 zoom). One world cell occupies
    // effCell screen px; at ZOOM_MIN this is CELL_SIZE*0.5 = 3px so cells stay
    // chunky (never sub-pixel). This is NOT a ctx transform / DPR multiply —
    // the ImageData stays viewport-sized and putImageData(0,0) fills the canvas.
    const effCell = effectiveCellPx();

    // Calculate visible column/row range in cells (window optimisation, GDD §13).
    // Only the cells whose screen rect overlaps the viewport are iterated — fewer
    // when zoomed in, more (but still bounded by the world) when zoomed out.
    const visibleStartX = Math.floor(camera.x);
    const visibleStartY = Math.floor(camera.y);
    const visibleEndX = Math.ceil(camera.x + this.viewportWidthPx / effCell);
    const visibleEndY = Math.ceil(camera.y + this.viewportHeightPx / effCell);

    // Clamp to world bounds to avoid OOB reads.
    const startX = Math.max(0, visibleStartX);
    const startY = Math.max(0, visibleStartY);
    const endX = Math.min(WORLD_W, visibleEndX);
    const endY = Math.min(WORLD_H, visibleEndY);

    // Create an ImageData sized to the viewport (in screen pixels).
    // Each cell fills an integer block derived from effCell; we'll fill it solid.
    const imageData = this.ctx.createImageData(this.viewportWidthPx, this.viewportHeightPx);
    const data = imageData.data; // RGBA tuples
    const vw = this.viewportWidthPx;
    const vh = this.viewportHeightPx;

    // Fill the ImageData with the visible grid cells. Block extents are taken as
    // the difference of floored screen edges (this cell's edge → next cell's
    // edge), so blocks are integer-pixel CRISP and TILE the viewport with no
    // gaps/overlaps at any (possibly fractional) zoom.
    for (let cellY = startY; cellY < endY; cellY++) {
      const sy0 = Math.floor((cellY - camera.y) * effCell);
      const sy1 = Math.floor((cellY + 1 - camera.y) * effCell);
      const py0 = Math.max(0, sy0);
      const py1 = Math.min(vh, sy1);
      if (py1 <= py0) continue;

      for (let cellX = startX; cellX < endX; cellX++) {
        // Get the material at this cell.
        const material = grid.get(cellX, cellY);
        let [r, g, b] = RGB_PALETTE[material] || RGB_PALETTE[0];

        // task 11-4 — Integrity darkening + chip-flash (GDD §7.4 / §12).
        // Only hasIntegrity cells (WOOD, FOLIAGE, WALL) pay the cost; AIR, sand,
        // stone, fluid cells skip both lookups. ImageData == backing-store +
        // zoom invariants are untouched: we only change the r/g/b locals before
        // they are written into `data[]` below.
        const mat = MATERIALS[material];
        if (mat !== undefined && mat.hasIntegrity && mat.baseIntegrity > 0) {
          const integ = grid.getIntegrity(cellX, cellY);
          // Darken proportionally to integrity lost.
          if (integ < mat.baseIntegrity) {
            const darkened = breachDarken([r, g, b], integ, mat.baseIntegrity);
            r = darkened[0]; g = darkened[1]; b = darkened[2];
          }
          // Chip-flash: briefly brighten a freshly-chipped cell.
          const cellKey = grid.idx(cellX, cellY);
          const chipTick = recentChips.get(cellKey);
          if (chipTick !== undefined) {
            const age = getBreachTick() - chipTick;
            if (age < CHIP_FLASH_TICKS) {
              const flash = Math.round(80 * (1 - age / CHIP_FLASH_TICKS));
              r = Math.min(255, r + flash);
              g = Math.min(255, g + flash);
              b = Math.min(255, b + flash);
            }
          }
        }

        const sx0 = Math.floor((cellX - camera.x) * effCell);
        const sx1 = Math.floor((cellX + 1 - camera.x) * effCell);
        const px0 = Math.max(0, sx0);
        const px1 = Math.min(vw, sx1);
        if (px1 <= px0) continue;

        // Fill the cell's integer block region.
        for (let pixelY = py0; pixelY < py1; pixelY++) {
          let idx = (pixelY * vw + px0) * 4;
          for (let pixelX = px0; pixelX < px1; pixelX++) {
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255; // alpha
            idx += 4;
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
    // Survivors draw with their authored colours; zombies (p7-t7) are tinted green.
    this.drawBodyList(this.bodies, null);
    this.drawBodyList(this.zombieBodies, tintZombie);

    // Draw FPS counter.
    this.drawFps();

    // Update FPS counter.
    this.updateFps();
  }

  /**
   * Draw all registered hybrid bodies' bone pixels over the cell layer.
   * Widened from a single body to N bodies (p5-t5). Each non-dead body's
   * non-destroyed bones are drawn in order; dead bodies are skipped.
   * GDD §5.1: body pixels are at cell resolution → worldToScreen gives the
   * identical top-left as the ImageData loop above (same formula), so the bodies
   * sit exactly on the grid and stay locked to the world while panning.
   */
  private drawBodyList(bodies: Body[], tint: ((color: string) => string) | null): void {
    const vw = this.viewportWidthPx;
    const vh = this.viewportHeightPx;
    const ctx = this.ctx;
    // Same effective cell size the cell layer uses (GDD §12.3 zoom) so body
    // pixels stay locked flush to the CA grid at any zoom.
    const effCell = effectiveCellPx();

    for (const body of bodies) {
      if (!body.alive) continue;

      const bx = Math.round(body.x);
      const by = Math.round(body.y);

      for (const bone of body.rig) {
        if (bone.destroyed) continue;
        for (const pixel of bone.pixels) {
          // World cell this pixel occupies (GDD §5.1 pixel formula).
          const wx = bx + bone.offset.dx + pixel.dx;
          const wy = by + bone.offset.dy + pixel.dy;

          // Screen rect — identical floor-of-edge math to the ImageData cell
          // loop above (this cell's edge → next cell's edge) so the body pixel
          // exactly tiles its world cell at any zoom.
          const sx0 = Math.floor((wx - camera.x) * effCell);
          const sy0 = Math.floor((wy - camera.y) * effCell);
          const sx1 = Math.floor((wx + 1 - camera.x) * effCell);
          const sy1 = Math.floor((wy + 1 - camera.y) * effCell);

          // Skip if the rect is fully outside the viewport.
          if (sx1 <= 0 || sx0 >= vw) continue;
          if (sy1 <= 0 || sy0 >= vh) continue;

          ctx.fillStyle = tint ? tint(pixel.color) : pixel.color;
          ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
        }
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
 * Replace the rendered bodies list (p5-t5 N-body widening).
 * Module-level convenience wrapper — call after initRenderer().
 */
export function setBodies(bodies: Body[]): void {
  getRenderer().setBodies(bodies);
}

/**
 * Replace the render-only zombie body list (p7-t7). Module-level wrapper; call
 * after initRenderer(). Bodies are drawn green-tinted but never mutated.
 */
export function setZombieBodies(bodies: Body[]): void {
  getRenderer().setZombieBodies(bodies);
}

/** Add one body to the renderer's draw list. Module-level wrapper. */
export function addBody(body: Body): void {
  getRenderer().addBody(body);
}

/** Clear all bodies from the renderer's draw list. Module-level wrapper. */
export function clearBodies(): void {
  getRenderer().clearBodies();
}

/**
 * Single-body shim — keeps existing callers (pre-p5-t5) compiling.
 * Module-level convenience wrapper — mirrors the getRenderer() export pattern.
 * Call after initRenderer() has been called.
 * GDD §5.1 / §14 Milestone 0.
 */
export function setBody(body: Body | null): void {
  getRenderer().setBody(body);
}
