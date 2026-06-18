/**
 * input.ts — Pointer-first drag-to-pan and paint input handler
 * GDD §12.3–12.4: one unified path for mouse + touch via Pointer Events API.
 * GDD §12.3: pan-vs-act tension resolved via tool-mode system:
 * - Pan mode: drag scrolls camera
 * - Paint mode: drag paints materials (sand, stone, water, erase)
 * Currently selected tool defines what a drag does.
 */

import { camera, panCamera, clampCamera, screenToWorld } from './camera';
import { getRenderer } from './render/renderer';
import * as grid from './engine/grid';
import { AIR, SAND, STONE, WATER, isFlammable } from './engine/materials';
import { ignite } from './engine/simulation';
import { BRUSH_RADIUS } from './config';

/**
 * Tool mode state: 'Pan' (drag scrolls camera), 'Paint' (drag paints), or
 * 'Ignite' (drag ignites flammable cells — GDD §8 ignite verb).
 * GDD §12.3: the currently selected tool defines what a drag does.
 */
type ToolMode = 'Pan' | 'Paint' | 'Ignite';

const toolState = {
  mode: 'Pan' as ToolMode,
  paintMaterialId: SAND, // which material to paint when in Paint mode
};

/**
 * Input state for drag tracking.
 */
const inputState = {
  isPointerDown: false,
  pointerStartX: 0,
  pointerStartY: 0,
  cameraStartX: 0,
};

/**
 * Iterate all cells in a BRUSH_RADIUS disc centred on (centerX, centerY),
 * calling the callback for each in-bounds cell (dx, dy offsets, absolute x, y).
 * Shared by paintDisc and igniteDisc.
 */
function forEachDiscCell(
  centerX: number,
  centerY: number,
  callback: (x: number, y: number) => void
): void {
  const radiusSq = BRUSH_RADIUS * BRUSH_RADIUS;
  for (let dy = -BRUSH_RADIUS; dy <= BRUSH_RADIUS; dy++) {
    for (let dx = -BRUSH_RADIUS; dx <= BRUSH_RADIUS; dx++) {
      if (dx * dx + dy * dy <= radiusSq) {
        callback(centerX + dx, centerY + dy);
      }
    }
  }
}

/**
 * Paint a filled disc of material at the given world coordinates.
 * Floored to integers; paints all cells within BRUSH_RADIUS (GDD §8 direct placement).
 */
function paintDisc(centerWorldX: number, centerWorldY: number, materialId: number): void {
  const centerX = Math.floor(centerWorldX);
  const centerY = Math.floor(centerWorldY);
  forEachDiscCell(centerX, centerY, (x, y) => grid.placeMaterial(x, y, materialId));
}

/**
 * Attempt to ignite a single cell at (x, y).
 * Only acts if the cell's material is flammable (WOOD/FOLIAGE); ignores all
 * other materials (AIR, STONE, SAND, WATER, DIRT, etc.) — GDD §8 ignite verb.
 * Calls simulation.ignite() which sets FIRE and seeds the lifetime countdown.
 * Pure grid+materials query — exported for headless unit-testing.
 */
export function tryIgnite(x: number, y: number): void {
  if (!grid.inBounds(x, y)) return;
  const mat = grid.get(x, y);
  if (isFlammable(mat)) {
    ignite(x, y);
  }
}

/**
 * Apply tryIgnite to every cell in a BRUSH_RADIUS disc centred on the given
 * world coordinates (GDD §8 ignite verb, direct placement).
 */
function igniteDisc(centerWorldX: number, centerWorldY: number): void {
  const centerX = Math.floor(centerWorldX);
  const centerY = Math.floor(centerWorldY);
  forEachDiscCell(centerX, centerY, tryIgnite);
}

/**
 * Get the canvas bounding rect and convert client coordinates to canvas-relative pixels.
 * GDD §12.4: account for pointer coordinate conversion for touch/mobile.
 */
function getCanvasRelativeCoords(
  event: PointerEvent,
  canvas: HTMLCanvasElement
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

/**
 * Handle pointer down: start tracking drag. In Paint mode, immediately paint at the position.
 */
function onPointerDown(event: PointerEvent): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) return;

  inputState.isPointerDown = true;
  inputState.pointerStartX = event.clientX;
  inputState.pointerStartY = event.clientY;
  inputState.cameraStartX = camera.x;

  if (toolState.mode === 'Paint') {
    // Paint at current position (GDD §8 direct placement)
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    paintDisc(worldCoords.x, worldCoords.y, toolState.paintMaterialId);
  } else if (toolState.mode === 'Ignite') {
    // Ignite at current position — only flammable cells (GDD §8 ignite verb)
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    igniteDisc(worldCoords.x, worldCoords.y);
  }
}

/**
 * Handle pointer move: either pan or paint depending on current tool mode.
 */
function onPointerMove(event: PointerEvent): void {
  if (!inputState.isPointerDown) return;

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) return;

  if (toolState.mode === 'Paint') {
    // Paint mode: drag paints continuously (GDD §8 direct placement, continuous painting while dragging)
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    paintDisc(worldCoords.x, worldCoords.y, toolState.paintMaterialId);
  } else if (toolState.mode === 'Ignite') {
    // Ignite mode: drag ignites flammable cells continuously (GDD §8 ignite verb)
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    igniteDisc(worldCoords.x, worldCoords.y);
  } else {
    // Pan mode: drag scrolls camera (existing behaviour)
    // Incremental delta since the last move event. Reset the anchor each move
    // so panning tracks the pointer 1:1 instead of accumulating from the start.
    const deltaX = event.clientX - inputState.pointerStartX;
    inputState.pointerStartX = event.clientX;
    inputState.pointerStartY = event.clientY;
    // Pan: negative delta (drag left) = pan right (increase camera.x).
    panCamera(-deltaX);

    const renderer = getRenderer();
    clampCamera(renderer.viewportWidthPx, renderer.viewportHeightPx);
  }
}

/**
 * Handle pointer up: stop tracking drag.
 */
function onPointerUp(_event: PointerEvent): void {
  inputState.isPointerDown = false;
}

/**
 * Set the tool mode. Mode 'Pan' disables painting; mode 'Paint' with a materialId enables painting.
 * Updates the toolbar UI to show which tool is active (GDD §12.3: persistent, thumb-reachable toolbar).
 */
export function setToolMode(mode: 'Pan'): void;
export function setToolMode(mode: 'Paint', materialId: number): void;
export function setToolMode(mode: 'Ignite'): void;
export function setToolMode(mode: ToolMode, materialId?: number): void {
  toolState.mode = mode;
  if (mode === 'Paint' && materialId !== undefined) {
    toolState.paintMaterialId = materialId;
  }
  updateToolbarUI();
}

/**
 * Update toolbar button visual state to show which tool is active.
 */
function updateToolbarUI(): void {
  const buttons = document.querySelectorAll('[data-tool]');
  buttons.forEach((btn) => {
    const btnMode = btn.getAttribute('data-tool');
    const btnMaterialId = btn.getAttribute('data-material');

    let isActive = false;
    if (btnMode === 'pan') {
      isActive = toolState.mode === 'Pan';
    } else if (btnMode === 'paint' && btnMaterialId !== null) {
      const materialId = parseInt(btnMaterialId, 10);
      isActive = toolState.mode === 'Paint' && toolState.paintMaterialId === materialId;
    } else if (btnMode === 'ignite') {
      isActive = toolState.mode === 'Ignite';
    }

    btn.classList.toggle('active', isActive);
  });
}

/**
 * Initialize pointer event listeners on the canvas and wire up the toolbar.
 * Also sets touch-action: none to prevent browser default touch scroll/zoom (GDD §12.3).
 */
export function initInput(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);

  // Prevent browser default touch actions (scrolling, zooming, etc.)
  canvas.style.touchAction = 'none';

  // Wire up toolbar buttons to set tool mode (GDD §12.3: toolbar switches modes)
  const toolbarButtons = document.querySelectorAll('[data-tool]');
  toolbarButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const button = e.currentTarget as HTMLElement;
      const mode = button.getAttribute('data-tool');
      const materialId = button.getAttribute('data-material');

      if (mode === 'pan') {
        setToolMode('Pan');
      } else if (mode === 'paint' && materialId !== null) {
        setToolMode('Paint', parseInt(materialId, 10));
      } else if (mode === 'ignite') {
        setToolMode('Ignite');
      }
    });
  });

  // Set initial toolbar state
  updateToolbarUI();
}
