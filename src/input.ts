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
import { BRUSH_RADIUS, ASSIGN_PICK_RADIUS } from './config';
import type { Body } from './characters/body';
import { pickBone } from './characters/pick';
import { applyDamage } from './characters/damage';
import type { Survivor } from './characters/survivor';
import { assignRole } from './characters/survivor';
import type { RoleName } from './game/roles';
import { canAssign } from './game/roles';

// Re-export the pure picking query so callers can reach it via the input module
// while it stays defined in a DOM-free helper (GDD §14 hand-test, p4-t7).
export { pickBone } from './characters/pick';

/**
 * Tool mode state: 'Pan' (drag scrolls camera), 'Paint' (drag paints),
 * 'Ignite' (drag ignites flammable cells — GDD §8 ignite verb), or
 * 'Assign' (tap a survivor to open role menu — GDD §6.2, p6-t5).
 * GDD §12.3: the currently selected tool defines what a drag does.
 */
type ToolMode = 'Pan' | 'Paint' | 'Ignite' | 'Shoot' | 'Assign';

const toolState = {
  mode: 'Pan' as ToolMode,
  paintMaterialId: SAND, // which material to paint when in Paint mode
};

/**
 * The live body the Shoot tool targets (p4-t7). Module-level reference mirroring
 * the renderer's setBody; null when no body is registered. Only used by the
 * temporary Shoot hand-test tool (Phase-7 combat replaces this).
 */
let targetBody: Body | null = null;

/**
 * Register the body the Shoot tool damages (GDD §14 Milestone 0 hand-test).
 * main.ts calls this alongside the renderer's setBody so a click drives THE GATE.
 */
export function setTargetBody(body: Body | null): void {
  targetBody = body;
}

/**
 * Survivor list for the Assign tool (p6-t5, GDD §6.2). Set by main.ts once
 * survivors are created; Assign mode picks the nearest one to the pointer.
 */
let survivorList: Survivor[] = [];

/** Register the survivor array so the Assign tool can pick from it. */
export function setSurvivors(list: Survivor[]): void {
  survivorList = list;
}

/** Currently-selected survivor waiting for a role-menu choice; null = none. */
let selectedSurvivor: Survivor | null = null;

/**
 * Show the role-menu overlay for survivor `s` (p6-t5, GDD §6.2). Refresh button
 * greyed/disabled state based on canAssign (tool-gated and stockpile-gated), then
 * make the overlay visible. Only updates DOM — never touches the grid.
 */
function showRoleMenu(s: Survivor): void {
  selectedSurvivor = s;
  const menu = document.getElementById('role-menu') as HTMLElement | null;
  if (!menu) return;
  const ownedTools = s.tool ? [s.tool.kind] : [];
  // Refresh disabled/enabled state for each role button.
  const btns = menu.querySelectorAll('[data-role]') as NodeListOf<HTMLButtonElement>;
  btns.forEach((btn) => {
    const role = btn.getAttribute('data-role') as RoleName;
    if (role === 'none') {
      // Unassign is always available.
      btn.disabled = false;
      btn.style.opacity = '1';
    } else {
      const affordable = canAssign(role, ownedTools);
      btn.disabled = !affordable;
      btn.style.opacity = affordable ? '1' : '0.4';
    }
  });
  menu.style.display = 'block';
}

/** Hide the role-menu overlay and clear the selected survivor. */
function closeRoleMenu(): void {
  selectedSurvivor = null;
  const menu = document.getElementById('role-menu') as HTMLElement | null;
  if (menu) menu.style.display = 'none';
}

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
  } else if (toolState.mode === 'Shoot') {
    // Shoot on DOWN only (a click = a single hit; drags don't repeat-fire).
    // Pick the body region under the cursor and route it through THE GATE
    // (GDD §14 hand-test, §7.2 emergent damage). No-op if no live body.
    if (targetBody && targetBody.alive) {
      const canvasCoords = getCanvasRelativeCoords(event, canvas);
      const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
      const cellX = Math.floor(worldCoords.x);
      const cellY = Math.floor(worldCoords.y);
      const name = pickBone(targetBody, cellX, cellY);
      if (name) {
        applyDamage(targetBody, name);
      }
    }
  } else if (toolState.mode === 'Assign') {
    // Assign mode (p6-t5, GDD §6.2): tap a survivor to open the role menu.
    // Find the nearest ALIVE survivor within ASSIGN_PICK_RADIUS cells of the click.
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    const wx = worldCoords.x;
    const wy = worldCoords.y;
    const radiusSq = ASSIGN_PICK_RADIUS * ASSIGN_PICK_RADIUS;
    let nearest: Survivor | null = null;
    let nearestDist = radiusSq + 1; // one beyond threshold
    for (const s of survivorList) {
      if (!s.body.alive) continue;
      const dx = s.body.x - wx;
      const dy = s.body.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= radiusSq && d2 < nearestDist) {
        nearestDist = d2;
        nearest = s;
      }
    }
    if (nearest) {
      showRoleMenu(nearest);
    } else {
      closeRoleMenu();
    }
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
export function setToolMode(mode: 'Shoot'): void;
export function setToolMode(mode: 'Assign'): void;
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
    } else if (btnMode === 'shoot') {
      isActive = toolState.mode === 'Shoot';
    } else if (btnMode === 'assign') {
      isActive = toolState.mode === 'Assign';
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
      } else if (mode === 'shoot') {
        setToolMode('Shoot');
      } else if (mode === 'assign') {
        setToolMode('Assign');
        // Close any open role menu when switching to Assign tool.
        closeRoleMenu();
      }
    });
  });

  // Wire role-menu buttons (p6-t5, GDD §6.2): each data-role button calls
  // assignRole on the selected survivor, refreshes greyed state, then closes.
  const roleMenuBtns = document.querySelectorAll('[data-role]');
  roleMenuBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!selectedSurvivor) {
        closeRoleMenu();
        return;
      }
      const roleAttr = (btn as HTMLElement).getAttribute('data-role') as RoleName;
      assignRole(selectedSurvivor, roleAttr);
      closeRoleMenu();
    });
  });

  // Set initial toolbar state
  updateToolbarUI();
}
