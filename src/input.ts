/**
 * input.ts — Pointer-first input handler: multi-pointer registry + gesture classification.
 * GDD §12.3–12.4: one unified path for mouse + touch via Pointer Events API.
 * GDD §12.3: pan-vs-act tension resolved via tool-mode system.
 *
 * Task 10-4: replaces the single inputState with a per-pointer Map so that
 * pinch (10-5) and long-press context menu / tap-cycle (10-6) can be wired in
 * without rearchitecting.
 *
 * Gesture classification:
 *   drag      — pointer moved > TAP_MAX_MOVE_PX (GDD §12.3 pan-vs-act)
 *   longpress — held ≥ LONG_PRESS_MS without moving past TAP_MAX_MOVE_PX
 *   tap       — released before LONG_PRESS_MS and within TAP_MAX_MOVE_PX
 *
 * Tool behaviours:
 *   Pan        — single-pointer drag scrolls camera.x (incremental, 1:1)
 *   Paint      — drag-paint: acts on every pointermove while pressed
 *   Ignite     — drag-ignite: acts on every pointermove while pressed
 *   Build      — drag-build: acts on every pointermove while pressed
 *   Shoot      — fires on TAP (not on raw pointerdown, so dragging doesn't shoot)
 *   Assign     — fires on TAP (opens role menu for nearest survivor)
 */

import { camera, panCamera, clampCamera, screenToWorld, jumpCameraTo } from './camera';
import { cycleSimSpeed, getSimSpeed, minimapXToWorld, MINIMAP_HEIGHT_PX, MINIMAP_AT_TOP, pushToast } from './game/ui';
import { spendAmmo, getAmmo } from './game/resources';
import { getRenderer } from './render/renderer';
import * as grid from './engine/grid';
import { AIR, SAND, STONE, WATER, isFlammable } from './engine/materials';
import { ignite } from './engine/simulation';
import { placeStructure, canPlace, type StructureKind } from './game/building';
import { BRUSH_RADIUS, ASSIGN_PICK_RADIUS, TAP_MAX_MOVE_PX, LONG_PRESS_MS } from './config';
import type { Body } from './characters/body';
import { pickBone } from './characters/pick';
import { applyDamage } from './characters/damage';
import type { Survivor } from './characters/survivor';
import { assignRole } from './characters/survivor';
import type { Zombie } from './characters/zombie';
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
type ToolMode = 'Pan' | 'Paint' | 'Ignite' | 'Shoot' | 'Assign' | 'Build';

const toolState = {
  mode: 'Pan' as ToolMode,
  paintMaterialId: SAND, // which material to paint when in Paint mode
  buildStructure: 'fence' as StructureKind, // which structure to place in Build mode (task 8-3)
};

// ---------------------------------------------------------------------------
// Multi-pointer registry (task 10-4, GDD §12.3 pinch/long-press setup)
// ---------------------------------------------------------------------------

/**
 * Per-pointer tracking state.
 *   startX/Y    — client coords at pointerdown (used for total-delta classification)
 *   lastX/Y     — client coords at last move (used for incremental pan delta)
 *   startTime   — performance.now() at pointerdown
 *   moved       — true once total movement exceeds TAP_MAX_MOVE_PX
 *   cameraStartX — camera.x at pointerdown (available for pinch in task 10-5)
 *   timerId     — handle for the long-press setTimeout, null when not pending
 */
interface PointerInfo {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  moved: boolean;
  cameraStartX: number;
  timerId: number | null;
}

/** Active pointer registry: pointerId → PointerInfo. */
const pointers = new Map<number, PointerInfo>();

// ---------------------------------------------------------------------------
// Pure gesture classifier (exported for headless unit tests, task 10-4)
// ---------------------------------------------------------------------------

/**
 * Classify a completed pointer gesture.
 *   drag      — total movement (Euclidean) exceeded TAP_MAX_MOVE_PX
 *   longpress — held ≥ LONG_PRESS_MS without moving past TAP_MAX_MOVE_PX
 *   tap       — quick release within movement threshold
 *
 * Pure function (no DOM, no side effects). GDD §12.3: pan-vs-act boundary.
 *
 * @param dx      total horizontal displacement in screen pixels
 * @param dy      total vertical displacement in screen pixels
 * @param heldMs  duration the pointer was held in milliseconds
 */
export function classifyGesture(dx: number, dy: number, heldMs: number): 'tap' | 'drag' | 'longpress' {
  if (Math.hypot(dx, dy) > TAP_MAX_MOVE_PX) return 'drag';
  if (heldMs >= LONG_PRESS_MS) return 'longpress';
  return 'tap';
}

// ---------------------------------------------------------------------------
// Long-press stub — task 10-6 fills this with the context/role menu
// ---------------------------------------------------------------------------

/**
 * Called when a single pointer is held still for ≥ LONG_PRESS_MS (GDD §12.3).
 * No-op stub: task 10-6 wires this to the contextual role menu.
 *
 * @param _worldX  world cell X under the held pointer
 * @param _worldY  world cell Y under the held pointer
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onLongPress(_worldX: number, _worldY: number): void {
  // No-op stub — task 10-6 implements the role context menu here.
}

// ---------------------------------------------------------------------------
// Target body / survivor / zombie registration (unchanged from pre-10-4)
// ---------------------------------------------------------------------------

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

/**
 * Zombie list for the Shoot tool (p7-t7, GDD §7.2). Set by main.ts with the live
 * array reference so the player can manually headshot zombies, not just
 * survivors. Mirrors setSurvivors.
 */
let zombieList: Zombie[] = [];

/** Register the zombie array so the Shoot tool can target zombies too. */
export function setZombies(list: Zombie[]): void {
  zombieList = list;
}

/**
 * Find the nearest ALIVE body (survivor OR zombie) to world cell (wx, wy) by
 * squared anchor distance (p7-t7). Used by the Shoot tool so a click damages
 * whatever body is closest — a player headshot routes through the same GATE
 * (applyDamage) as combat. Returns null if no live body exists.
 */
function nearestBodyTo(wx: number, wy: number): Body | null {
  let best: Body | null = null;
  let bestD = Infinity;
  const consider = (b: Body): void => {
    if (!b.alive) return;
    const dx = b.x - wx;
    const dy = b.y - wy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  };
  for (const s of survivorList) consider(s.body);
  for (const z of zombieList) consider(z.body);
  // Back-compat: the explicitly-registered target body (e.g. survivors[0]).
  if (targetBody) consider(targetBody);
  return best;
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

// ---------------------------------------------------------------------------
// Disc brush helpers (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Coordinate helpers (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pointer event handlers (task 10-4 refactor)
// ---------------------------------------------------------------------------

/**
 * Fire the long-press action for a given pointer (task 10-4, GDD §12.3).
 * Checks single-pointer constraint and `moved` guard before calling onLongPress.
 */
function fireLongPress(pointerId: number): void {
  const p = pointers.get(pointerId);
  if (!p || p.moved) return;
  // Long-press requires exactly one active pointer (not a two-finger gesture).
  if (pointers.size !== 1) return;
  // Compute world position from the (still) pointer position.
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const cx = p.lastX - rect.left;
  const cy = p.lastY - rect.top;
  const world = screenToWorld(cx, cy);
  onLongPress(world.x, world.y);
}

/**
 * Handle pointerdown: add pointer to registry, start long-press timer,
 * and immediately act for drag-paint tools (Paint/Ignite/Build).
 * Shoot/Assign no longer act on down — they wait for a TAP on pointerup.
 */
function onPointerDown(event: PointerEvent): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) return;

  // -----------------------------------------------------------------------
  // Minimap strip hit-test (GDD §12.1 off-screen awareness, task 9-6).
  // If the pointer lands inside the minimap band, treat it as a camera-jump
  // and consume the event so it doesn't fall through to normal tool actions.
  // -----------------------------------------------------------------------
  {
    const rect = canvas.getBoundingClientRect();
    const canvasY = event.clientY - rect.top;
    const canvasH = rect.height;
    const stripY = MINIMAP_AT_TOP ? 0 : canvasH - MINIMAP_HEIGHT_PX;
    if (canvasY >= stripY && canvasY < stripY + MINIMAP_HEIGHT_PX) {
      const renderer = getRenderer();
      const canvasX = event.clientX - rect.left;
      const worldX = minimapXToWorld(canvasX, rect.width);
      jumpCameraTo(worldX, renderer.viewportWidthPx, renderer.viewportHeightPx);
      return; // consumed — do NOT fall through to paint/pan/etc.
    }
  }

  // Register the pointer.
  const now = performance.now();
  const info: PointerInfo = {
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    startTime: now,
    moved: false,
    cameraStartX: camera.x,
    timerId: null,
  };
  pointers.set(event.pointerId, info);

  // Arm long-press timer (GDD §12.3, task 10-4).
  info.timerId = window.setTimeout(() => {
    fireLongPress(event.pointerId);
  }, LONG_PRESS_MS);

  // Drag-paint tools: act immediately on down (continuous-paint feel).
  if (toolState.mode === 'Paint') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    paintDisc(worldCoords.x, worldCoords.y, toolState.paintMaterialId);
  } else if (toolState.mode === 'Build') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    const cellX = Math.floor(worldCoords.x);
    const cellY = Math.floor(worldCoords.y);
    placeStructure(cellX, cellY, toolState.buildStructure);
  } else if (toolState.mode === 'Ignite') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    igniteDisc(worldCoords.x, worldCoords.y);
  }
  // Shoot / Assign: deferred to pointerup tap classification (task 10-4).
  // Pan: handled in pointermove.
}

/**
 * Handle pointermove: update per-pointer state, act on drag-paint tools,
 * and pan the camera in Pan mode (all using incremental per-pointer deltas).
 */
function onPointerMove(event: PointerEvent): void {
  const info = pointers.get(event.pointerId);
  if (!info) return;

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) return;

  // Total displacement from start (for moved flag / long-press guard).
  const totalDx = event.clientX - info.startX;
  const totalDy = event.clientY - info.startY;

  if (!info.moved && Math.hypot(totalDx, totalDy) > TAP_MAX_MOVE_PX) {
    info.moved = true;
    // Cancel long-press timer — pointer has drifted past the tap threshold.
    if (info.timerId !== null) {
      clearTimeout(info.timerId);
      info.timerId = null;
    }
  }

  // Drag-paint tools: continue acting on every move while the pointer is down.
  if (toolState.mode === 'Paint') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    paintDisc(worldCoords.x, worldCoords.y, toolState.paintMaterialId);
  } else if (toolState.mode === 'Build') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    const cellX = Math.floor(worldCoords.x);
    const cellY = Math.floor(worldCoords.y);
    placeStructure(cellX, cellY, toolState.buildStructure);
  } else if (toolState.mode === 'Ignite') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    igniteDisc(worldCoords.x, worldCoords.y);
  } else if (toolState.mode === 'Pan') {
    // Pan: incremental delta from the last recorded position (tracks 1:1).
    // Reset anchor each move so panning tracks the pointer without accumulation.
    const deltaX = event.clientX - info.lastX;
    panCamera(-deltaX);
    const renderer = getRenderer();
    clampCamera(renderer.viewportWidthPx, renderer.viewportHeightPx);
  }

  // Advance anchor for the next incremental delta.
  info.lastX = event.clientX;
  info.lastY = event.clientY;
}

/**
 * Perform the tap-classified action for Shoot / Assign modes.
 * Called from onPointerUp when the gesture classifies as a tap.
 */
function handleTapAction(event: PointerEvent, canvas: HTMLCanvasElement): void {
  if (toolState.mode === 'Shoot') {
    // Shoot on TAP: a quick tap shoots; a drag does NOT (task 10-4 key change).
    // Limited ammo (playtest): every shot costs a bullet; out of ammo → no-op + toast.
    if (!spendAmmo()) {
      pushToast('Out of ammo!');
      return;
    }
    // Routes through THE GATE (GDD §14 hand-test, §7.2 emergent damage).
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    const cellX = Math.floor(worldCoords.x);
    const cellY = Math.floor(worldCoords.y);
    const targetBodyHit = nearestBodyTo(cellX, cellY);
    if (targetBodyHit) {
      const name = pickBone(targetBodyHit, cellX, cellY);
      if (name) {
        applyDamage(targetBodyHit, name);
      }
    }
    if (getAmmo() === 0) pushToast('Last bullet — out of ammo!');
  } else if (toolState.mode === 'Assign') {
    // Assign on TAP: open role menu for nearest alive survivor (p6-t5, GDD §6.2).
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
 * Handle pointerup: classify gesture, execute tap actions, remove pointer.
 */
function onPointerUp(event: PointerEvent): void {
  const info = pointers.get(event.pointerId);
  if (!info) return;

  // Cancel long-press timer (pointer lifted before it fired).
  if (info.timerId !== null) {
    clearTimeout(info.timerId);
    info.timerId = null;
  }

  const heldMs = performance.now() - info.startTime;
  const dx = event.clientX - info.startX;
  const dy = event.clientY - info.startY;
  const gesture = classifyGesture(dx, dy, heldMs);

  // Tap action: Shoot and Assign now fire on tap (not on raw pointerdown).
  if (gesture === 'tap') {
    const canvas = document.getElementById('game') as HTMLCanvasElement | null;
    if (canvas) {
      handleTapAction(event, canvas);
    }
  }

  pointers.delete(event.pointerId);
}

/**
 * Handle pointercancel: clean up registry and timer (e.g. system interrupts).
 */
function onPointerCancel(event: PointerEvent): void {
  const info = pointers.get(event.pointerId);
  if (info?.timerId !== null && info) {
    clearTimeout(info.timerId!);
  }
  pointers.delete(event.pointerId);
}

// ---------------------------------------------------------------------------
// Tool mode management (unchanged API)
// ---------------------------------------------------------------------------

/**
 * Set the tool mode. Mode 'Pan' disables painting; mode 'Paint' with a materialId enables painting.
 * Updates the toolbar UI to show which tool is active (GDD §12.3: persistent, thumb-reachable toolbar).
 */
export function setToolMode(mode: 'Pan'): void;
export function setToolMode(mode: 'Paint', materialId: number): void;
export function setToolMode(mode: 'Ignite'): void;
export function setToolMode(mode: 'Shoot'): void;
export function setToolMode(mode: 'Assign'): void;
export function setToolMode(mode: 'Build', structure: StructureKind): void;
export function setToolMode(mode: ToolMode, materialIdOrStructure?: number | StructureKind): void {
  toolState.mode = mode;
  if (mode === 'Paint' && typeof materialIdOrStructure === 'number') {
    toolState.paintMaterialId = materialIdOrStructure;
  } else if (mode === 'Build' && typeof materialIdOrStructure === 'string') {
    toolState.buildStructure = materialIdOrStructure as StructureKind;
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
    } else if (btnMode === 'build') {
      const btnStructure = btn.getAttribute('data-structure');
      isActive = toolState.mode === 'Build' && btnStructure === toolState.buildStructure;
    }

    btn.classList.toggle('active', isActive);
  });
}

/**
 * Refresh the disabled/opacity state of Build toolbar buttons based on current
 * stockpile affordability (task 8-4, GDD §8).  Called every render frame from
 * main.ts next to the stockpile-readout update.
 *
 * Guards for null/empty button lists so it is safe to call before the DOM is
 * fully initialised and under headless test stubs where querySelectorAll returns
 * an empty array-like.
 */
export function refreshBuildButtons(): void {
  const btns = document.querySelectorAll('[data-tool="build"]') as NodeListOf<HTMLButtonElement>;
  if (!btns || btns.length === 0) return;
  btns.forEach((btn) => {
    const structure = btn.getAttribute('data-structure') as StructureKind | null;
    if (!structure) return;
    const affordable = canPlace(structure);
    btn.disabled = !affordable;
    btn.style.opacity = affordable ? '1' : '0.4';
  });
}

// ---------------------------------------------------------------------------
// Initialisation (kept; adds pointercancel listener for task 10-4)
// ---------------------------------------------------------------------------

/**
 * Initialize pointer event listeners on the canvas and wire up the toolbar.
 * Also sets touch-action: none to prevent browser default touch scroll/zoom (GDD §12.3).
 */
export function initInput(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  // pointercancel fires on system interrupts (task 10-4): clean up registry.
  document.addEventListener('pointercancel', onPointerCancel);

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
      } else if (mode === 'build') {
        const structure = button.getAttribute('data-structure');
        if (structure) {
          setToolMode('Build', structure as StructureKind);
        }
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

  // Wire speed toggle button (GDD §12.2 sim-speed controls, task 9-5).
  // Guard for missing element so this is safe under the headless DOM stub.
  const speedBtn = document.getElementById('speed-btn') as HTMLButtonElement | null;
  if (speedBtn) {
    speedBtn.addEventListener('click', () => {
      const newSpeed = cycleSimSpeed();
      speedBtn.textContent = newSpeed + '\u00d7';
    });
  }

  // Set initial toolbar state
  updateToolbarUI();
}
