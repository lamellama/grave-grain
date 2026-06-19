/**
 * game/ui.ts — Canvas HUD overlays (GDD §12.2).
 *
 * Provides:
 *   drawNeedsBars  — hunger + thirst bars rendered above each alive survivor,
 *                    camera-tracked via worldToScreen().
 *   pushToast      — queue a transient message (3-second fade/expire).
 *   drawToasts     — render the queued toasts onto the canvas.
 *   drawEndScreen  — dim overlay + big WIN/LOSE message when the game ends.
 *   getSimSpeed    — current simulation ticks-per-frame multiplier.
 *   cycleSimSpeed  — advance to next SIM_SPEEDS index (wraps), return new value.
 *
 * Everything here is guard-safe under the headless DOM stub:
 *   – ctx.canvas may be absent or have size 0; we bail silently.
 *   – worldToScreen() works fine headlessly (no DOM).
 */

import type { Survivor } from '../characters/survivor';
import type { GameState } from './state';
import { worldToScreen } from '../camera';
import {
  NEED_MAX,
  HUNGER_THRESHOLD,
  THIRST_THRESHOLD,
  SIM_SPEEDS,
  CELL_SIZE,
  BODY_W,
} from '../config';

// ---------------------------------------------------------------------------
// Sim-speed toggle (GDD §12.2 pause + speed controls)
// ---------------------------------------------------------------------------

let _speedIdx = 0; // index into SIM_SPEEDS

/** Return the current ticks-per-frame multiplier. */
export function getSimSpeed(): number {
  return SIM_SPEEDS[_speedIdx];
}

/**
 * Advance to the next speed step (wraps from the last back to the first).
 * Returns the NEW speed value so callers can update UI labels immediately.
 */
export function cycleSimSpeed(): number {
  _speedIdx = (_speedIdx + 1) % SIM_SPEEDS.length;
  return SIM_SPEEDS[_speedIdx];
}

// ---------------------------------------------------------------------------
// Toast queue (GDD §12.2 clear death-cause message on every death)
// ---------------------------------------------------------------------------

interface Toast {
  msg: string;
  expireAt: number; // Date.now() + 3000
}

/** Internal queue; capped at 5 entries (oldest dropped). */
const _toasts: Toast[] = [];
const TOAST_DURATION_MS = 3000;
const TOAST_MAX = 5;

/**
 * Add a message to the transient toast queue. If the queue is full the oldest
 * entry is dropped to make room. Toasts expire after TOAST_DURATION_MS.
 */
export function pushToast(msg: string): void {
  _toasts.push({ msg, expireAt: Date.now() + TOAST_DURATION_MS });
  if (_toasts.length > TOAST_MAX) {
    _toasts.splice(0, _toasts.length - TOAST_MAX);
  }
}

/**
 * Expose the internal toast array length for unit tests.
 * (Tests can also push toasts and verify pruning without touching internals.)
 * @internal
 */
export function _toastCount(): number {
  return _toasts.length;
}

/**
 * Render the current toast queue, pruning expired entries first.
 * Drawn bottom-centre, stacked upward, with alpha fading in the last 800 ms.
 * Guard-safe: bails silently when ctx.canvas is missing or zero-sized.
 */
export function drawToasts(ctx: CanvasRenderingContext2D): void {
  // Prune expired toasts.
  const now = Date.now();
  for (let i = _toasts.length - 1; i >= 0; i--) {
    if (_toasts[i].expireAt <= now) {
      _toasts.splice(i, 1);
    }
  }
  if (_toasts.length === 0) return;

  // Guard: canvas may not be a real canvas under the smoke stub.
  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 14px monospace';

  const lineH = 22;
  const baseY = ch - 60; // above the toolbar

  for (let i = 0; i < _toasts.length; i++) {
    const t = _toasts[i];
    const remaining = t.expireAt - now;
    // Fade in last 800 ms.
    const alpha = Math.min(1, remaining / 800);
    ctx.globalAlpha = Math.max(0, alpha);

    const y = baseY - i * lineH;

    // Dark shadow text for readability.
    ctx.fillStyle = '#000';
    ctx.fillText(t.msg, cw / 2 + 1, y + 1);
    ctx.fillStyle = '#ffdd44';
    ctx.fillText(t.msg, cw / 2, y);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Needs bars (GDD §12.2 bars over survivors)
// ---------------------------------------------------------------------------

/** Width (px) of a single needs bar — matches the body's visual footprint. */
const BAR_W = CELL_SIZE * BODY_W;
/** Height (px) of each individual bar (hunger or thirst). */
const BAR_H = 3;
/** Vertical gap (px) between the two bars. */
const BAR_GAP = 1;

/**
 * Colour for a bar whose value is v with a critical threshold t.
 * Green when comfortably above threshold, amber just above, red below.
 */
function barColor(v: number, threshold: number): string {
  const frac = v / NEED_MAX; // 0–1
  const critFrac = threshold / NEED_MAX;
  if (frac > critFrac + 0.15) return '#44cc44'; // green
  if (frac > critFrac)        return '#ddaa00'; // amber
  return '#cc2222';                              // red
}

/**
 * Draw one horizontal bar (filled + outline) at canvas pixel position (px, py).
 * fill is the fraction filled (0–1 clamped).
 */
function drawBar(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  fill: number,
  color: string,
): void {
  const clampedFill = Math.max(0, Math.min(1, fill));
  // Background track.
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(px, py, BAR_W, BAR_H);
  // Filled portion.
  if (clampedFill > 0) {
    ctx.fillStyle = color;
    ctx.fillRect(px, py, Math.round(BAR_W * clampedFill), BAR_H);
  }
}

/**
 * Draw hunger + thirst bars for every ALIVE survivor, positioned above their
 * body in screen space via worldToScreen() so the bars track the camera.
 * Skip survivors whose screen position is outside the canvas bounds.
 * Guard-safe under the DOM stub (canvas may be zero-sized).
 */
export function drawNeedsBars(
  ctx: CanvasRenderingContext2D,
  survivors: Survivor[],
): void {
  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;
  if (survivors.length === 0) return;

  ctx.save();

  for (const s of survivors) {
    if (!s.body.alive) continue;

    // Position bars horizontally centred on the body, a couple of world cells
    // above the feet anchor (body.y is feet-centre; subtract 2 extra cells for
    // the bar stack itself so it clears the head visually).
    const sc = worldToScreen(s.body.x - BODY_W / 2, s.body.y - 2);
    const px = sc.x;
    const py = sc.y - (BAR_H * 2 + BAR_GAP); // stack sits just above the anchor

    // Off-screen cull: skip if clearly outside the visible area.
    if (px + BAR_W < -4 || px > cw + 4) continue;
    if (py + BAR_H * 2 + BAR_GAP < -4 || py > ch + 4) continue;

    // Hunger bar (top).
    drawBar(
      ctx,
      px,
      py,
      s.needs.hunger / NEED_MAX,
      barColor(s.needs.hunger, HUNGER_THRESHOLD),
    );

    // Thirst bar (bottom, just below hunger).
    drawBar(
      ctx,
      px,
      py + BAR_H + BAR_GAP,
      s.needs.thirst / NEED_MAX,
      barColor(s.needs.thirst, THIRST_THRESHOLD),
    );
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// End screen (GDD §12.2 win/lose message)
// ---------------------------------------------------------------------------

/**
 * When state.status is not 'playing', render a semi-transparent dim overlay
 * and centred large text describing the outcome.
 *
 *   Won  → "YOU SURVIVED — Wave N"
 *   Lost → "COLONY LOST — <cause>"
 *
 * Guard-safe: silently returns when canvas is absent or zero-sized, or when
 * state.status is 'playing'.
 */
export function drawEndScreen(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  if (state.status === 'playing') return;

  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  ctx.save();

  // Semi-transparent dim.
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, cw, ch);

  const won = state.status === 'won';

  // Primary headline.
  const headline = won
    ? 'YOU SURVIVED'
    : 'COLONY LOST';

  // Sub-line: wave or result string.
  const sub = state.result ?? (won ? `Wave ${state.wave}` : 'overrun');

  ctx.textAlign = 'center';

  // Headline.
  ctx.font = 'bold 36px monospace';
  ctx.fillStyle = won ? '#44ff44' : '#ff4444';
  ctx.fillText(headline, cw / 2, ch / 2 - 20);

  // Sub-line.
  ctx.font = '22px monospace';
  ctx.fillStyle = '#dddddd';
  ctx.fillText(sub, cw / 2, ch / 2 + 20);

  // Instruction hint.
  ctx.font = '14px monospace';
  ctx.fillStyle = '#888888';
  ctx.fillText('Refresh to restart', cw / 2, ch / 2 + 56);

  ctx.restore();
}
