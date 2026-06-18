/**
 * input.ts — Pointer-first drag-to-pan input handler
 * GDD §12.3–12.4: one unified path for mouse + touch via Pointer Events API.
 * Uses Pointer Events (pointerdown/pointermove/pointerup) for mobile-first compatibility.
 */

import { camera, panCamera, clampCamera } from './camera';
import { getRenderer } from './render/renderer';

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
 * Handle pointer down: start tracking drag.
 */
function onPointerDown(event: PointerEvent): void {
  inputState.isPointerDown = true;
  inputState.pointerStartX = event.clientX;
  inputState.pointerStartY = event.clientY;
  inputState.cameraStartX = camera.x;
}

/**
 * Handle pointer move: pan camera during drag.
 */
function onPointerMove(event: PointerEvent): void {
  if (!inputState.isPointerDown) return;

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

/**
 * Handle pointer up: stop tracking drag.
 */
function onPointerUp(_event: PointerEvent): void {
  inputState.isPointerDown = false;
}

/**
 * Initialize pointer event listeners on the canvas.
 * Also sets touch-action: none to prevent browser default touch scroll/zoom (GDD §12.3).
 */
export function initInput(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);

  // Prevent browser default touch actions (scrolling, zooming, etc.)
  canvas.style.touchAction = 'none';
}
