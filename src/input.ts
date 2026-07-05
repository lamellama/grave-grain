/**
 * input.ts - Pointer-first input handler: multi-pointer registry + gesture classification.
 * GDD 12.3-12.4: one unified path for mouse + touch via Pointer Events API.
 * GDD 12.3: pan-vs-act tension resolved via tool-mode system.
 *
 * Task 10-4: replaces the single inputState with a per-pointer Map so that
 * pinch (10-5) and long-press context menu / tap-cycle (10-6) can be wired in
 * without rearchitecting.
 *
 * Gesture classification:
 *   drag      - pointer moved > TAP_MAX_MOVE_PX (GDD 12.3 pan-vs-act)
 *   longpress - held >= LONG_PRESS_MS without moving past TAP_MAX_MOVE_PX
 *   tap       - released before LONG_PRESS_MS and within TAP_MAX_MOVE_PX
 *
 * Tool behaviours:
 *   Pan        - single-pointer drag scrolls camera.x (incremental, 1:1); a
 *                stationary TAP on a survivor SELECTS it and opens the role
 *                menu (playtest R9 - there is no separate Assign tool)
 *   Paint      - drag-paint: acts on every pointermove while pressed
 *   Ignite     - drag-ignite: acts on every pointermove while pressed
 *   Build      - drag-build: acts on every pointermove while pressed
 *   Shoot      - fires on TAP (not on raw pointerdown, so dragging doesn't shoot)
 *   Flag       - fires on TAP (plants/moves the camp flag)
 */

import { camera, panCamera, clampCamera, screenToWorld, jumpCameraTo, setZoom, effectiveCellPx } from './camera';
import { cycleSimSpeed, getSimSpeed, minimapXToWorld, MINIMAP_HEIGHT_PX, MINIMAP_AT_TOP, pushToast } from './game/ui';
import { spendAmmo, getAmmo } from './game/resources';
import { getRenderer } from './render/renderer';
import * as grid from './engine/grid';
import { AIR, SAND, STONE, WATER, DIRT, FOLIAGE, SAPLING, isFlammable } from './engine/materials';
import { ignite } from './engine/simulation';
import { placeStructure, canPlace, type StructureKind } from './game/building';
import { addBlueprint, blueprintAt, cancelBlueprintAt } from './game/buildqueue';
import { plantCampFlagAt } from './game/camp';
import { BRUSH_RADIUS, TAP_MAX_MOVE_PX, LONG_PRESS_MS, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, SELECT_TAP_RADIUS, TAP_CYCLE_RESET_MS } from './config';
import type { Body } from './characters/body';
import { pickBone } from './characters/pick';
import { applyDamage } from './characters/damage';
import type { Survivor } from './characters/survivor';
import { assignRole } from './characters/survivor';
import type { Zombie } from './characters/zombie';
import type { RoleName } from './game/roles';
import { roleTintCss } from './game/roles';
import { canAssign } from './game/roles';

// Re-export the pure picking query so callers can reach it via the input module
// while it stays defined in a DOM-free helper (GDD 14 hand-test, p4-t7).
export { pickBone } from './characters/pick';

/**
 * Tool mode state: 'Pan' (drag scrolls camera; TAP a survivor to select +
 * open the role menu - playtest R9, no separate Assign tool), 'Paint' (drag
 * paints), 'Ignite' (drag ignites flammable cells - GDD 8 ignite verb), etc.
 * GDD 12.3: the currently selected tool defines what a drag does.
 */
type ToolMode = 'Pan' | 'Paint' | 'Ignite' | 'Shoot' | 'Build' | 'Plan' | 'Flag';

const toolState = {
  mode: 'Pan' as ToolMode,
  paintMaterialId: SAND, // which material to paint when in Paint mode
  buildStructure: 'fence' as StructureKind, // which structure to place in Build mode (task 8-3)
};

// ---------------------------------------------------------------------------
// Multi-pointer registry (task 10-4, GDD 12.3 pinch/long-press setup)
// ---------------------------------------------------------------------------

/**
 * Per-pointer tracking state.
 *   startX/Y    - client coords at pointerdown (used for total-delta classification)
 *   lastX/Y     - client coords at last move (used for incremental pan delta)
 *   startTime   - performance.now() at pointerdown
 *   moved       - true once total movement exceeds TAP_MAX_MOVE_PX
 *   cameraStartX - camera.x at pointerdown (available for pinch in task 10-5)
 *   timerId     - handle for the long-press setTimeout, null when not pending
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

/** Active pointer registry: pointerId -> PointerInfo. */
const pointers = new Map<number, PointerInfo>();

// ---------------------------------------------------------------------------
// Pinch-zoom state (task 10-5, GDD 12.3)
// ---------------------------------------------------------------------------

/**
 * Pure pinch-zoom helper: returns the unclamped target zoom given the initial
 * pinch distance, the current pinch distance, and the zoom at pinch start.
 * Clamping to [ZOOM_MIN, ZOOM_MAX] is handled by camera.setZoom.
 * Exported for headless unit-testing (p10-pinch test).
 * Guard: if startDist <= 0 return startZoom unchanged (avoid NaN/Infinity).
 */
export function pinchZoom(startDist: number, curDist: number, startZoom: number): number {
  if (startDist <= 0) return startZoom;
  return startZoom * (curDist / startDist);
}

/** True while two fingers are actively pinching. */
let pinching = false;

/** Pinch distance (px) when the pinch gesture began. */
let pinchStartDist = 0;

/** camera.zoom value when the pinch gesture began. */
let pinchStartZoom = 1;

/**
 * World cell that sat under the two fingers' MIDPOINT when the pinch began.
 * Two-finger gestures both ZOOM and PAN (playtest R9 "two fingers only appears
 * to zoom"): each move re-pins this world point under the CURRENT midpoint, so
 * spreading fingers zooms about them while dragging both fingers pans 1:1.
 */
let pinchStartWorldX = 0;
let pinchStartWorldY = 0;

/**
 * Pure two-finger camera solve: the camera position that puts world point
 * (worldX, worldY) under screen point (midX, midY) at `effCellPx` screen px per
 * world cell. Exported for headless unit-testing (r9-pan test). Clamping is the
 * caller's job (clampCamera), exactly like pinchZoom above.
 */
export function pinchPanCamera(
  worldX: number,
  worldY: number,
  midX: number,
  midY: number,
  effCellPx: number,
): { x: number; y: number } {
  return { x: worldX - midX / effCellPx, y: worldY - midY / effCellPx };
}

/**
 * Pointer IDs that were part of a pinch and must be ignored for tool actions
 * until they produce a fresh pointerdown. Prevents the lingering finger from
 * inadvertently painting/panning after the second finger lifts.
 */
const suppressedPointers = new Set<number>();

/**
 * Pointer IDs that landed on the minimap strip and are SCRUBBING it (playtest
 * R9: the nav bar "only allows clicking, not click and drag"). While a pointer
 * is in this set every move re-jumps the camera to the dragged strip position;
 * it never falls through to tool actions or the gesture classifier.
 */
const minimapScrubPointers = new Set<number>();

// ---------------------------------------------------------------------------
// Pure gesture classifier (exported for headless unit tests, task 10-4)
// ---------------------------------------------------------------------------

/**
 * Classify a completed pointer gesture.
 *   drag      - total movement (Euclidean) exceeded TAP_MAX_MOVE_PX
 *   longpress - held >= LONG_PRESS_MS without moving past TAP_MAX_MOVE_PX
 *   tap       - quick release within movement threshold
 *
 * Pure function (no DOM, no side effects). GDD 12.3: pan-vs-act boundary.
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
// Task 10-6 - pure cycling helper (GDD 12.4 forgiving tap selection)
// ---------------------------------------------------------------------------

/**
 * Pick an alive survivor near (wx, wy) within `radius` cells, with tap-cycle
 * support for overlapping survivors (GDD 12.4). Pure function - no DOM, no
 * side-effects. Exported for headless unit-testing (p10-select test).
 *
 * Candidates are sorted by distance ascending, then by list-index for a stable
 * deterministic tie-break order.
 *
 *  - When `sameSpot` is false (new spot or reset): return the NEAREST candidate.
 *  - When `sameSpot` is true (repeated tap at ~same location within
 *    TAP_CYCLE_RESET_MS): return the NEXT alive candidate after `lastPicked`
 *    (wrapping), so repeated taps cycle through the clump. If `lastPicked` is
 *    no longer in the candidate set, restart from the nearest.
 *
 * @param list       live survivor array
 * @param wx         world cell X of the tap
 * @param wy         world cell Y of the tap
 * @param radius     pick radius in cells (Euclidean)
 * @param lastPicked survivor returned by the previous call (for cycling)
 * @param sameSpot   true when this tap is a same-spot repeated tap
 */
export function pickCycling(
  list: Survivor[],
  wx: number,
  wy: number,
  radius: number,
  lastPicked: Survivor | null,
  sameSpot: boolean
): Survivor | null {
  // Build candidate set: alive survivors within radius, sorted by distance then index.
  const radiusSq = radius * radius;
  const candidates = list
    .filter((s) => {
      if (!s.body.alive) return false;
      const dx = s.body.x - wx;
      const dy = s.body.y - wy;
      return dx * dx + dy * dy <= radiusSq;
    })
    .sort((a, b) => {
      const da = (a.body.x - wx) ** 2 + (a.body.y - wy) ** 2;
      const db = (b.body.x - wx) ** 2 + (b.body.y - wy) ** 2;
      if (da !== db) return da - db;
      return list.indexOf(a) - list.indexOf(b); // stable tie-break by list order
    });

  if (candidates.length === 0) return null;

  // Cycle: advance past lastPicked when this is a same-spot repeated tap.
  if (sameSpot && lastPicked !== null) {
    const idx = candidates.indexOf(lastPicked);
    if (idx !== -1) {
      return candidates[(idx + 1) % candidates.length];
    }
  }

  // Default: return the nearest candidate.
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Tap-cycle state (module-level - shared between Assign and Shoot tap paths)
// ---------------------------------------------------------------------------

/** Survivor returned by the most recent Assign/Shoot tap (for cycling). */
let _lastPickedSurvivor: Survivor | null = null;

/** World X of the most recent Assign/Shoot tap. */
let _lastTapWx = -9999;

/** World Y of the most recent Assign/Shoot tap. */
let _lastTapWy = -9999;

/** performance.now() timestamp of the most recent Assign/Shoot tap. */
let _lastTapTime = 0;

// ---------------------------------------------------------------------------
// Long-press - task 10-6: open context/role menu (GDD 12.3)
// ---------------------------------------------------------------------------

/**
 * Called when a single pointer is held still for >= LONG_PRESS_MS (GDD 12.3).
 * Picks the nearest alive survivor within SELECT_TAP_RADIUS and opens the
 * role-assign menu (a global shortcut independent of the current tool mode).
 * Closes the menu if no survivor is nearby.
 */
function onLongPress(worldX: number, worldY: number): void {
  // GDD 12.3 long-press -> context menu (task 10-6).
  const s = pickCycling(survivorList, worldX, worldY, SELECT_TAP_RADIUS, null, false);
  if (s) {
    showRoleMenu(s);
  } else {
    closeRoleMenu();
  }
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
 * Register the body the Shoot tool damages (GDD 14 Milestone 0 hand-test).
 * main.ts calls this alongside the renderer's setBody so a click drives THE GATE.
 */
export function setTargetBody(body: Body | null): void {
  targetBody = body;
}

/**
 * Survivor list for the Assign tool (p6-t5, GDD 6.2). Set by main.ts once
 * survivors are created; Assign mode picks the nearest one to the pointer.
 */
let survivorList: Survivor[] = [];

/** Register the survivor array so the Assign tool can pick from it. */
export function setSurvivors(list: Survivor[]): void {
  survivorList = list;
}

/**
 * Zombie list for the Shoot tool (p7-t7, GDD 7.2). Set by main.ts with the live
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
 * whatever body is closest - a player headshot routes through the same GATE
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
 * Show the role-menu overlay for survivor `s` (p6-t5, GDD 6.2). Refresh button
 * greyed/disabled state based on canAssign (tool-gated and stockpile-gated), then
 * make the overlay visible. Only updates DOM - never touches the grid.
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
 * The survivor whose role-menu is open (null = none). Exposed so the render loop
 * can draw a selection highlight that TRACKS the sprite each frame (v0.8 playtest
 * K - the menu floats centred, so without this the player can't tell who is
 * selected, especially while they move). Cleared if the selected survivor dies.
 */
export function getSelectedSurvivor(): Survivor | null {
  if (selectedSurvivor && (!selectedSurvivor.body.alive || selectedSurvivor.turned)) {
    closeRoleMenu();
  }
  return selectedSurvivor;
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
 * Floored to integers; paints all cells within BRUSH_RADIUS (GDD 8 direct placement).
 */
function paintDisc(centerWorldX: number, centerWorldY: number, materialId: number): void {
  // Plant-a-seed (playtest v0.6 #G, GDD 9): the Plant tool drops a SINGLE
  // SAPLING that grows into foliage on its own, rather than painting a blob of
  // material. Route it through plantSeed so it only lands on suitable soil and
  // never paves over the terrain it needs to grow from.
  if (materialId === SAPLING) {
    plantSeed(centerWorldX, centerWorldY);
    return;
  }
  const centerX = Math.floor(centerWorldX);
  const centerY = Math.floor(centerWorldY);
  forEachDiscCell(centerX, centerY, (x, y) => grid.placeMaterial(x, y, materialId));
}

/**
 * Plant a single SAPLING (Plant tool, playtest v0.6 #G; GDD 9). Drops one seed
 * on suitable soil: the sapling goes into an AIR cell that sits directly on DIRT
 * or already-grown FOLIAGE. Clicking the soil itself plants in the AIR just
 * above it (forgiving). placeMaterial leaves the SAPLING's integrity at 0; the
 * growth rule (simulation.updateSapling) seeds the GROW_TICKS countdown on the
 * sapling's first sim visit, so no special integrity seeding is needed here.
 */
function plantSeed(centerWorldX: number, centerWorldY: number): void {
  let x = Math.floor(centerWorldX);
  let y = Math.floor(centerWorldY);
  if (!grid.inBounds(x, y)) return;
  const here = grid.get(x, y);
  // Clicked on the ground itself -> plant in the AIR cell just above it.
  if (here === DIRT || here === FOLIAGE) y -= 1;
  if (!grid.inBounds(x, y) || grid.get(x, y) !== AIR) return;
  const below = grid.get(x, y + 1);
  if (below !== DIRT && below !== FOLIAGE) return; // grow only on suitable soil
  grid.placeMaterial(x, y, SAPLING); // integrity 0 -> updateSapling seeds the timer
}

/**
 * Attempt to ignite a single cell at (x, y).
 * Only acts if the cell's material is flammable (WOOD/FOLIAGE); ignores all
 * other materials (AIR, STONE, SAND, WATER, DIRT, etc.) - GDD 8 ignite verb.
 * Calls simulation.ignite() which sets FIRE and seeds the lifetime countdown.
 * Pure grid+materials query - exported for headless unit-testing.
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
 * world coordinates (GDD 8 ignite verb, direct placement).
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
 * GDD 12.4: account for pointer coordinate conversion for touch/mobile.
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
 * Fire the long-press action for a given pointer (task 10-4, GDD 12.3).
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
 * Shoot/Assign no longer act on down - they wait for a TAP on pointerup.
 */
function onPointerDown(event: PointerEvent): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) return;

  // -----------------------------------------------------------------------
  // Minimap strip hit-test (GDD 12.1 off-screen awareness, task 9-6).
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
      // Keep scrubbing while this pointer drags along the strip (playtest R9
      // "click and drag would make it easier") - onPointerMove re-jumps until
      // pointerup. The pointer is NOT added to the tool-gesture registry.
      minimapScrubPointers.add(event.pointerId);
      return; // consumed - do NOT fall through to paint/pan/etc.
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
  // A fresh pointerdown clears any prior pinch-suppression for this pointer ID.
  suppressedPointers.delete(event.pointerId);
  pointers.set(event.pointerId, info);

  // --- Pinch detection (task 10-5, GDD 12.3) ---
  // When a second finger arrives, enter pinch mode: cancel all long-press timers
  // and record the initial distance + zoom so pointermove can scale from it.
  // Two-finger gestures must NEVER paint/pan/ignite/build.
  if (pointers.size >= 2) {
    // Cancel long-press timers for ALL active pointers.
    for (const [, pi] of pointers) {
      if (pi.timerId !== null) {
        clearTimeout(pi.timerId);
        pi.timerId = null;
      }
    }
    if (!pinching) {
      // Just entered pinch - record baseline.
      pinching = true;
      const pts = Array.from(pointers.values());
      const ddx = pts[1].lastX - pts[0].lastX;
      const ddy = pts[1].lastY - pts[0].lastY;
      pinchStartDist = Math.hypot(ddx, ddy);
      pinchStartZoom = camera.zoom;
      // World point under the fingers' midpoint - re-pinned under the moving
      // midpoint each move so the gesture pans as well as zooms (R9 mobile pan).
      const rect = canvas.getBoundingClientRect();
      const midX = (pts[0].lastX + pts[1].lastX) / 2 - rect.left;
      const midY = (pts[0].lastY + pts[1].lastY) / 2 - rect.top;
      const w = screenToWorld(midX, midY);
      pinchStartWorldX = w.x;
      pinchStartWorldY = w.y;
    }
    return; // GDD 12.3: two-finger gesture is pinch, not paint/pan/tap.
  }

  // --- Single-pointer path ---
  // Arm long-press timer (GDD 12.3, task 10-4).
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
  } else if (toolState.mode === 'Plan') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    const cellX = Math.floor(worldCoords.x);
    const cellY = Math.floor(worldCoords.y);
    // Drag-plan is ADD-ONLY (idempotent: addBlueprint dedups). Toggling here
    // would flicker a blueprint on/off as repeated move events hit one cell;
    // tap-to-cancel lives on pointer-down (applyPlanAt) only.
    addBlueprint(cellX, cellY, toolState.buildStructure);
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
  // Minimap scrub (playtest R9): a pointer that went down on the strip keeps
  // driving the camera as it drags. Handled before the registry lookup - scrub
  // pointers are never registered for tool gestures.
  if (minimapScrubPointers.has(event.pointerId)) {
    const scrubCanvas = document.getElementById('game') as HTMLCanvasElement | null;
    if (scrubCanvas) {
      const rect = scrubCanvas.getBoundingClientRect();
      const renderer = getRenderer();
      const worldX = minimapXToWorld(event.clientX - rect.left, rect.width);
      jumpCameraTo(worldX, renderer.viewportWidthPx, renderer.viewportHeightPx);
    }
    return;
  }

  const info = pointers.get(event.pointerId);
  if (!info) return;

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) return;

  // Capture prev position for incremental pan delta before updating.
  const prevLastX = info.lastX;
  // Update position (used by pinch midpoint calc below).
  info.lastX = event.clientX;
  info.lastY = event.clientY;

  // --- Pinch zoom + two-finger pan (task 10-5 / playtest R9 mobile pan) ---
  // When two pointers are active: scale camera.zoom by the distance ratio
  // relative to the pinch baseline, AND re-pin the world point that was under
  // the initial midpoint beneath the CURRENT midpoint. Spreading the fingers
  // zooms about them; dragging both fingers together pans 1:1 (the R9 fix -
  // two fingers used to only zoom, leaving no reliable way to pan on mobile
  // while a paint/build tool was selected).
  if (pinching && pointers.size === 2) {
    const pts = Array.from(pointers.values());
    const curDx = pts[1].lastX - pts[0].lastX;
    const curDy = pts[1].lastY - pts[0].lastY;
    const curDist = Math.hypot(curDx, curDy);
    const newZoom = pinchZoom(pinchStartDist, curDist, pinchStartZoom);

    // Midpoint in client coords -> canvas-relative.
    const rect = canvas.getBoundingClientRect();
    const midClientX = (pts[0].lastX + pts[1].lastX) / 2;
    const midClientY = (pts[0].lastY + pts[1].lastY) / 2;
    const midX = midClientX - rect.left;
    const midY = midClientY - rect.top;

    camera.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    const cam = pinchPanCamera(
      pinchStartWorldX,
      pinchStartWorldY,
      midX,
      midY,
      effectiveCellPx(),
    );
    camera.x = cam.x;
    camera.y = cam.y;
    const renderer = getRenderer();
    clampCamera(renderer.viewportWidthPx, renderer.viewportHeightPx);
    return; // pinch consumes the event - no pan/paint.
  }

  // --- Suppressed pointers (lingering finger after pinch end, GDD 12.3) ---
  if (suppressedPointers.has(event.pointerId)) {
    return; // don't pan/paint until a fresh pointerdown.
  }

  // Total displacement from start (for moved flag / long-press guard).
  const totalDx = event.clientX - info.startX;
  const totalDy = event.clientY - info.startY;

  if (!info.moved && Math.hypot(totalDx, totalDy) > TAP_MAX_MOVE_PX) {
    info.moved = true;
    // Cancel long-press timer - pointer has drifted past the tap threshold.
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
  } else if (toolState.mode === 'Plan') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    const cellX = Math.floor(worldCoords.x);
    const cellY = Math.floor(worldCoords.y);
    applyPlanAt(cellX, cellY);
  } else if (toolState.mode === 'Ignite') {
    const canvasCoords = getCanvasRelativeCoords(event, canvas);
    const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
    igniteDisc(worldCoords.x, worldCoords.y);
  } else if (toolState.mode === 'Pan') {
    // Pan: incremental delta from the last recorded position (tracks 1:1).
    // prevLastX captured before info.lastX was updated above.
    const deltaX = event.clientX - prevLastX;
    panCamera(-deltaX);
    const renderer = getRenderer();
    clampCamera(renderer.viewportWidthPx, renderer.viewportHeightPx);
  }
}

/**
 * Perform the tap-classified action for Shoot / Pan-select / Flag modes.
 * Called from onPointerUp when the gesture classifies as a tap.
 * Uses pickCycling for forgiving, tap-cycle survivor selection (GDD 12.4,
 * task 10-6). State (_lastPickedSurvivor, _lastTapW*, _lastTapTime) is
 * shared between modes so cycling is consistent across tool switches.
 */
function handleTapAction(event: PointerEvent, canvas: HTMLCanvasElement): void {
  // --- Resolve world cell and tap-cycle state (shared by select + Shoot) ---
  const canvasCoords = getCanvasRelativeCoords(event, canvas);
  const worldCoords = screenToWorld(canvasCoords.x, canvasCoords.y);
  const wx = worldCoords.x;
  const wy = worldCoords.y;

  const now = performance.now();
  const sameSpot =
    Math.hypot(wx - _lastTapWx, wy - _lastTapWy) <= SELECT_TAP_RADIUS &&
    now - _lastTapTime <= TAP_CYCLE_RESET_MS;

  if (toolState.mode === 'Shoot') {
    // Shoot on TAP: a quick tap shoots; a drag does NOT (task 10-4 key change).
    // Limited ammo (playtest): every shot costs a bullet; out of ammo -> no-op + toast.
    if (!spendAmmo()) {
      pushToast('Out of ammo!');
      return;
    }
    // Routes through THE GATE (GDD 14 hand-test, 7.2 emergent damage).
    const cellX = Math.floor(wx);
    const cellY = Math.floor(wy);

    // Tap-cycle: try picking a survivor via the cycling helper first (GDD 12.4).
    // Fall back to nearestBodyTo (which includes zombies) if no survivor nearby.
    const cycledSurvivor = pickCycling(survivorList, wx, wy, SELECT_TAP_RADIUS, _lastPickedSurvivor, sameSpot);
    const targetBodyHit = cycledSurvivor ? cycledSurvivor.body : nearestBodyTo(cellX, cellY);

    // Update tap-cycle tracking state.
    _lastPickedSurvivor = cycledSurvivor;
    _lastTapWx = wx;
    _lastTapWy = wy;
    _lastTapTime = now;

    if (targetBodyHit) {
      const name = pickBone(targetBodyHit, cellX, cellY);
      if (name) {
        applyDamage(targetBodyHit, name);
      }
    }
    if (getAmmo() === 0) pushToast('Last bullet - out of ammo!');
  } else if (toolState.mode === 'Pan') {
    // Pan on TAP = SELECT (playtest R9): there is no dedicated Assign tool any
    // more - tapping a survivor in the default Pan mode selects it and opens
    // the role menu directly (a drag still pans; only a stationary tap selects).
    // Forgiving tap-cycle from task 10-6 (GDD 12.4) picks the nearest/cycled
    // alive survivor within SELECT_TAP_RADIUS; an empty tap closes the menu.
    const picked = pickCycling(survivorList, wx, wy, SELECT_TAP_RADIUS, _lastPickedSurvivor, sameSpot);

    // Update tap-cycle tracking state.
    _lastPickedSurvivor = picked;
    _lastTapWx = wx;
    _lastTapWy = wy;
    _lastTapTime = now;

    if (picked) {
      showRoleMenu(picked);
    } else {
      closeRoleMenu();
    }
  } else if (toolState.mode === 'Flag') {
    // Flag on TAP (playtest R9 base assignment): plant/move the camp flag,
    // snapped to the local surface. Survivors build camp ONLY at (and after)
    // the flag - main re-homes the colony on the version bump and coopbuild
    // re-plans at the new site.
    plantCampFlagAt(Math.floor(wx), Math.floor(wy));
    pushToast('Camp flag planted - survivors will build camp here');
  }
}

/**
 * Handle pointerup: classify gesture, execute tap actions, remove pointer.
 */
function onPointerUp(event: PointerEvent): void {
  // End a minimap scrub (playtest R9): the pointer was never in the tool
  // registry, so just release it - no tap/drag classification.
  if (minimapScrubPointers.delete(event.pointerId)) return;

  const info = pointers.get(event.pointerId);
  if (!info) return;

  // Cancel long-press timer (pointer lifted before it fired).
  if (info.timerId !== null) {
    clearTimeout(info.timerId);
    info.timerId = null;
  }

  // --- Pinch exit (task 10-5, GDD 12.3) ---
  // If we were pinching, suppress the lingering finger so it can't immediately
  // paint/pan/tap. A fresh pointerdown is required to re-activate it.
  if (pinching) {
    pointers.delete(event.pointerId);
    suppressedPointers.add(event.pointerId); // will be cleared on next pointerdown
    if (pointers.size < 2) {
      // End pinch mode; mark all remaining pointers as suppressed.
      pinching = false;
      for (const [id] of pointers) {
        suppressedPointers.add(id);
      }
    }
    return; // no tap action from a pinch-participant finger.
  }

  // Normal single-pointer path.
  const heldMs = performance.now() - info.startTime;
  const dx = event.clientX - info.startX;
  const dy = event.clientY - info.startY;
  const gesture = classifyGesture(dx, dy, heldMs);

  // Skip tap/actions for suppressed pointers (lingered from a pinch).
  const wasSuppressed = suppressedPointers.has(event.pointerId);
  suppressedPointers.delete(event.pointerId);

  if (!wasSuppressed && gesture === 'tap') {
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
  minimapScrubPointers.delete(event.pointerId);
  const info = pointers.get(event.pointerId);
  if (info?.timerId !== null && info) {
    clearTimeout(info.timerId!);
  }
  pointers.delete(event.pointerId);
  suppressedPointers.delete(event.pointerId);
  // If we lost a pinch finger via cancel, exit pinch mode.
  if (pinching && pointers.size < 2) {
    pinching = false;
    for (const [id] of pointers) {
      suppressedPointers.add(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool mode management (unchanged API)
// ---------------------------------------------------------------------------

/**
 * Set the tool mode. Mode 'Pan' disables painting; mode 'Paint' with a materialId enables painting.
 * Updates the toolbar UI to show which tool is active (GDD 12.3: persistent, thumb-reachable toolbar).
 */
export function setToolMode(mode: 'Pan'): void;
export function setToolMode(mode: 'Paint', materialId: number): void;
export function setToolMode(mode: 'Ignite'): void;
export function setToolMode(mode: 'Shoot'): void;
export function setToolMode(mode: 'Flag'): void;
export function setToolMode(mode: 'Build', structure: StructureKind): void;
export function setToolMode(mode: 'Plan', structure: StructureKind): void;
export function setToolMode(mode: ToolMode, materialIdOrStructure?: number | StructureKind): void {
  toolState.mode = mode;
  if (mode === 'Paint' && typeof materialIdOrStructure === 'number') {
    toolState.paintMaterialId = materialIdOrStructure;
  } else if ((mode === 'Build' || mode === 'Plan') && typeof materialIdOrStructure === 'string') {
    toolState.buildStructure = materialIdOrStructure as StructureKind;
  }
  updateToolbarUI();
}

/**
 * Apply the Plan tool action at a grid cell: toggle blueprint (add or cancel).
 * Exported for headless testing (CB-4).
 */
export function applyPlanAt(cellX: number, cellY: number): void {
  if (blueprintAt(cellX, cellY) !== null) {
    cancelBlueprintAt(cellX, cellY);
  } else {
    addBlueprint(cellX, cellY, toolState.buildStructure);
  }
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
    } else if (btnMode === 'flag') {
      isActive = toolState.mode === 'Flag';
    } else if (btnMode === 'build') {
      const btnStructure = btn.getAttribute('data-structure');
      isActive = toolState.mode === 'Build' && btnStructure === toolState.buildStructure;
    } else if (btnMode === 'plan') {
      const btnStructure = btn.getAttribute('data-structure');
      isActive = toolState.mode === 'Plan' && btnStructure === toolState.buildStructure;
    }

    btn.classList.toggle('active', isActive);
  });
}

/**
 * Refresh the disabled/opacity state of Build toolbar buttons based on current
 * stockpile affordability (task 8-4, GDD 8).  Called every render frame from
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
 * Also sets touch-action: none to prevent browser default touch scroll/zoom (GDD 12.3).
 */
export function initInput(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  // pointercancel fires on system interrupts (task 10-4): clean up registry.
  document.addEventListener('pointercancel', onPointerCancel);

  // --- Scroll-wheel zoom (task 10-5, GDD 12.3 desktop zoom) ---
  // Multiplicative step: each notch scales zoom by (1 +/- ZOOM_STEP), keeping
  // the world point under the cursor stationary. Clamping is handled by setZoom.
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const direction = e.deltaY < 0 ? 1 : -1; // scroll up = zoom in
    const newZoom = camera.zoom * (1 + direction * ZOOM_STEP);
    const renderer = getRenderer();
    setZoom(newZoom, cursorX, cursorY, renderer.viewportWidthPx, renderer.viewportHeightPx);
  }, { passive: false });

  // Prevent browser default touch actions (scrolling, zooming, etc.)
  canvas.style.touchAction = 'none';

  // --- Right-click context menu: open role-assign overlay (task 10-6 / playtest #F) ---
  // GDD 12.3: desktop equivalent of the long-press gesture; works in ANY tool mode.
  canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const world = screenToWorld(cx, cy);
    const s = pickCycling(survivorList, world.x, world.y, SELECT_TAP_RADIUS, null, false);
    if (s) showRoleMenu(s);
  });

  // Wire up toolbar buttons to set tool mode (GDD 12.3: toolbar switches modes)
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
      } else if (mode === 'flag') {
        setToolMode('Flag');
      } else if (mode === 'build') {
        const structure = button.getAttribute('data-structure');
        if (structure) {
          setToolMode('Build', structure as StructureKind);
        }
      } else if (mode === 'plan') {
        const structure = button.getAttribute('data-structure');
        if (structure) {
          setToolMode('Plan', structure as StructureKind);
        }
      }
    });
  });

  // Debug menu toggle (playtest R9): the developer-only tools (Shoot, Ignite,
  // Plan Fence/Wall, Campfire, Door) live in a collapsed panel so the main
  // toolbar stays focused on the player-facing verbs. The toggle just shows /
  // hides the panel; the buttons inside it keep their data-tool wiring above.
  const debugToggle = document.getElementById('debug-toggle');
  const debugMenu = document.getElementById('debug-menu');
  if (debugToggle && debugMenu) {
    debugToggle.addEventListener('click', () => {
      const showing = debugMenu.style.display !== 'none' && debugMenu.style.display !== '';
      debugMenu.style.display = showing ? 'none' : 'flex';
      debugToggle.classList.toggle('active', !showing);
    });
  }

  // Wire role-menu buttons (p6-t5, GDD 6.2): each data-role button calls
  // assignRole on the selected survivor, refreshes greyed state, then closes.
  const roleMenuBtns = document.querySelectorAll('[data-role]');
  roleMenuBtns.forEach((btn) => {
    // v0.8 playtest L: colour-match each button to its role's sprite tint, via a
    // left-edge swatch derived from ROLE_TINT (single source of truth -> the menu
    // legend can never drift from the on-screen body colour).
    const role = (btn as HTMLElement).getAttribute('data-role') as RoleName;
    (btn as HTMLElement).style.borderLeft = `6px solid ${roleTintCss(role)}`;

    btn.addEventListener('click', () => {
      if (!selectedSurvivor) {
        closeRoleMenu();
        return;
      }
      assignRole(selectedSurvivor, role);
      closeRoleMenu();
    });
  });

  // Wire speed toggle button (GDD 12.2 sim-speed controls, task 9-5).
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
