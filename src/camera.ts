/**
 * camera.ts — Horizontal (and optional vertical) scroll camera
 * GDD §12.1: the world is wider than the screen, scrolls horizontally.
 * GDD §12.3/§12.4: a zoom factor lets the player swing between an overview and
 * precise placement while keeping cells chunky.
 * Camera position in world coordinates; clamped to [0, max].
 */

import {
  CELL_SIZE,
  WORLD_W,
  WORLD_H,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
} from './config';

/**
 * Camera state: position in world cells + a zoom factor.
 * zoom scales the effective cell size (CELL_SIZE * zoom px per world cell).
 */
export const camera = {
  x: 0, // scroll offset in cells
  y: 0, // vertical offset (left at 0 for now per GDD §12.1)
  zoom: ZOOM_DEFAULT, // GDD §12.3 — effective cell size = CELL_SIZE * zoom
};

/**
 * Effective cell size in screen pixels (GDD §12.3 zoom). Every screen↔world
 * transform and the renderer's block-fill use this instead of the raw
 * CELL_SIZE so a world cell maps to the same screen rect everywhere at any
 * zoom. Exported so the renderer shares the exact same number.
 */
export function effectiveCellPx(): number {
  return CELL_SIZE * camera.zoom;
}

/**
 * Get the world bounds in pixels (at the current zoom).
 */
function worldBoundsPixels(): { width: number; height: number } {
  const eff = effectiveCellPx();
  return {
    width: WORLD_W * eff,
    height: WORLD_H * eff,
  };
}

/**
 * Clamp the camera position to valid bounds.
 * x: [0, max(0, worldWidth - viewportWidth)]
 * y: [0, max(0, worldHeight - viewportHeight)] (though y stays pinned to 0 for MVP)
 */
export function clampCamera(viewportWidthPx: number, viewportHeightPx: number): void {
  const eff = effectiveCellPx();
  const world = worldBoundsPixels();
  const maxX = Math.max(0, world.width - viewportWidthPx);
  const maxY = Math.max(0, world.height - viewportHeightPx);

  camera.x = Math.max(0, Math.min(camera.x, maxX / eff));
  // Vertical: the world (WORLD_H) is taller than the viewport, so we clamp y to
  // a valid range and let main frame the camera on the surface. Horizontal drag
  // is still the primary navigation (GDD §12.1); y is set by framing, not panned.
  camera.y = Math.max(0, Math.min(camera.y, maxY / eff));
}

/**
 * Convert screen (pixel) coordinates to world (cell) coordinates.
 * screenX, screenY are in pixels from the canvas top-left.
 * Returns world cell position.
 */
export function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
  const eff = effectiveCellPx();
  const cellX = camera.x + screenX / eff;
  const cellY = camera.y + screenY / eff;
  return { x: cellX, y: cellY };
}

/**
 * Convert world (cell) coordinates to screen (pixel) coordinates.
 * worldX, worldY are in cells.
 * Returns screen pixel position (may be off-screen).
 */
export function worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
  const eff = effectiveCellPx();
  const screenX = (worldX - camera.x) * eff;
  const screenY = (worldY - camera.y) * eff;
  return { x: screenX, y: screenY };
}

/**
 * Pan the camera by a delta in pixels.
 * Positive = scroll right (camera.x increases, moving the world left on screen).
 * Clamping is done by the caller after accumulation.
 */
export function panCamera(deltaPixels: number): void {
  camera.x += deltaPixels / effectiveCellPx();
}

/**
 * Set the zoom factor, zooming ABOUT a screen anchor (GDD §12.3 precise
 * placement). The world cell currently under (anchorScreenX, anchorScreenY)
 * stays under that same screen point after the zoom change, so a pinch/scroll
 * feels anchored rather than re-centring the view. Clamps z to
 * [ZOOM_MIN, ZOOM_MAX] then re-clamps the camera to world bounds.
 */
export function setZoom(
  z: number,
  anchorScreenX: number,
  anchorScreenY: number,
  vpWpx: number,
  vpHpx: number,
): void {
  // World point under the anchor BEFORE changing zoom.
  const before = screenToWorld(anchorScreenX, anchorScreenY);

  camera.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

  // Place the camera so that same world point maps back to the anchor under the
  // new effective cell size: camera = worldPoint - anchorPx / eff.
  const eff = effectiveCellPx();
  camera.x = before.x - anchorScreenX / eff;
  camera.y = before.y - anchorScreenY / eff;

  clampCamera(vpWpx, vpHpx);
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
  camera.x = worldXCell - (viewportWidthPx / effectiveCellPx()) / 2;
  clampCamera(viewportWidthPx, viewportHeightPx);
}
