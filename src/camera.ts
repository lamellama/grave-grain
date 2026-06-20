/**
 * camera.ts — Horizontal (and optional vertical) scroll camera
 * GDD §12.1: the world is wider than the screen, scrolls horizontally.
 * Camera position in world coordinates; clamped to [0, max].
 */

import { CELL_SIZE, WORLD_W, WORLD_H } from './config';

/**
 * Camera state: position in world cells.
 */
export const camera = {
  x: 0, // scroll offset in cells
  y: 0, // vertical offset (left at 0 for now per GDD §12.1)
};

/**
 * Get the world bounds in pixels.
 */
function worldBoundsPixels(): { width: number; height: number } {
  return {
    width: WORLD_W * CELL_SIZE,
    height: WORLD_H * CELL_SIZE,
  };
}

/**
 * Clamp the camera position to valid bounds.
 * x: [0, max(0, worldWidth - viewportWidth)]
 * y: [0, max(0, worldHeight - viewportHeight)] (though y stays pinned to 0 for MVP)
 */
export function clampCamera(viewportWidthPx: number, viewportHeightPx: number): void {
  const world = worldBoundsPixels();
  const maxX = Math.max(0, world.width - viewportWidthPx);
  const maxY = Math.max(0, world.height - viewportHeightPx);

  camera.x = Math.max(0, Math.min(camera.x, maxX / CELL_SIZE));
  // Vertical: the world (WORLD_H) is taller than the viewport, so we clamp y to
  // a valid range and let main frame the camera on the surface. Horizontal drag
  // is still the primary navigation (GDD §12.1); y is set by framing, not panned.
  camera.y = Math.max(0, Math.min(camera.y, maxY / CELL_SIZE));
}

/**
 * Convert screen (pixel) coordinates to world (cell) coordinates.
 * screenX, screenY are in pixels from the canvas top-left.
 * Returns world cell position.
 */
export function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
  const cellX = camera.x + screenX / CELL_SIZE;
  const cellY = camera.y + screenY / CELL_SIZE;
  return { x: cellX, y: cellY };
}

/**
 * Convert world (cell) coordinates to screen (pixel) coordinates.
 * worldX, worldY are in cells.
 * Returns screen pixel position (may be off-screen).
 */
export function worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
  const screenX = (worldX - camera.x) * CELL_SIZE;
  const screenY = (worldY - camera.y) * CELL_SIZE;
  return { x: screenX, y: screenY };
}

/**
 * Pan the camera by a delta in pixels.
 * Positive = scroll right (camera.x increases, moving the world left on screen).
 * Clamping is done by the caller after accumulation.
 */
export function panCamera(deltaPixels: number): void {
  camera.x += deltaPixels / CELL_SIZE;
}

/**
 * Jump the camera so that `worldXCell` is centred horizontally in the viewport.
 * y stays pinned to 0. Clamps to valid bounds.
 * GDD §12.1: off-screen awareness — minimap tap jumps camera.
 */
export function jumpCameraTo(
  worldXCell: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
): void {
  camera.x = worldXCell - (viewportWidthPx / CELL_SIZE) / 2;
  clampCamera(viewportWidthPx, viewportHeightPx);
}
