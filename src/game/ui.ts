/**
 * game/ui.ts - Canvas HUD overlays (GDD 12.2).
 *
 * Provides:
 *   drawNeedsBars  - hunger + thirst bars rendered above each alive survivor,
 *                    camera-tracked via worldToScreen().
 *   pushToast      - queue a transient message (3-second fade/expire).
 *   drawToasts     - render the queued toasts onto the canvas.
 *   drawEndScreen  - dim overlay + big WIN/LOSE message when the game ends.
 *   getSimSpeed    - current simulation ticks-per-frame multiplier.
 *   cycleSimSpeed  - advance to next SIM_SPEEDS index (wraps), return new value.
 *
 * Everything here is guard-safe under the headless DOM stub:
 *   - ctx.canvas may be absent or have size 0; we bail silently.
 *   - worldToScreen() works fine headlessly (no DOM).
 */

import type { Survivor } from '../characters/survivor';
import type { Zombie } from '../characters/zombie';
import type { GameState } from './state';
import { worldToScreen, effectiveCellPx } from '../camera';
import { stockpilePoint } from './resources';
import { getCampFlag } from './camp';
import { recentChips, getBreachTick } from './breaching';
import { getWeather, getTemperature, type WeatherState } from '../engine/weather';
import {
  NEED_MAX,
  HUNGER_THRESHOLD,
  THIRST_THRESHOLD,
  WARMTH_THRESHOLD,
  WET_ICON_THRESHOLD,
  SIM_SPEEDS,
  CELL_SIZE,
  BODY_W,
  BODY_H,
  WORLD_W,
  CHIP_FLASH_TICKS,
  UNDER_ATTACK_ALERT,
  RAIN_STREAK_COLOR,
  SNOW_FLECK_COLOR,
  WEATHER_OVERLAY_DENSITY,
  RAIN_OVERLAY_DENSITY,
  WEATHER_SKY_DARKEN_RAIN,
  WEATHER_SKY_DARKEN_SNOW,
} from '../config';

// ---------------------------------------------------------------------------
// Minimap / edge-arrow layout constants (GDD 12.1 off-screen awareness)
// ---------------------------------------------------------------------------

/** Height (px) of the minimap strip, drawn along the top of the canvas. */
export const MINIMAP_HEIGHT_PX = 16;

/** True = strip sits at the top of the canvas; false = bottom. */
export const MINIMAP_AT_TOP = true;

// ---------------------------------------------------------------------------
// Sim-speed toggle (GDD 12.2 pause + speed controls)
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
// Toast queue (GDD 12.2 clear death-cause message on every death)
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
  // Anchor the stack just above the REAL toolbar, not a guessed 60px (playtest
  // R9: "ui buttons overlap the overlay messages" - the toolbar wraps to two
  // rows on short/narrow screens and swallowed the old fixed offset). The
  // toolbar is a DOM overlay in CSS px and the canvas backing store is CSS-px
  // sized (main.resizeCanvas), so its measured height subtracts directly.
  // Guard-safe: headless stubs without the element fall back to 60.
  let toolbarH = 0;
  if (typeof document !== 'undefined' && document.getElementById) {
    const tb = document.getElementById('toolbar');
    if (tb && typeof tb.getBoundingClientRect === 'function') {
      toolbarH = tb.getBoundingClientRect().height || 0;
    }
  }
  const baseY = ch - Math.max(60, toolbarH + 24);

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
// Weather HUD + precipitation overlay (VS-1 T5, GDD 10)
//
// Two cosmetic, draw-time-only pieces:
//   1. A precipitation overlay (rain streaks / snow flakes) drawn over the
//      world so the active weather is felt, not just labelled.
//   2. A top-of-screen readout - "icon  Label  Ndeg" - so the HUD ALWAYS shows
//      the current weather and temperature (the VS-1 Done-when).
// Animation is wall-clock driven (performance.now): it never touches the sim
// grid or RNG, so chunk-equivalence / replay determinism are unaffected.
// ---------------------------------------------------------------------------

/** Per-weather presentation (icon, label, particle + text colour). */
const WEATHER_VIS: Record<WeatherState, { icon: string; label: string; tint: string }> = {
  clear: { icon: '\u2600', label: 'Clear', tint: '#ffd866' }, // sun
  rain:  { icon: '\u2602', label: 'Rain',  tint: '#7fb8ff' }, // umbrella
  snow:  { icon: '\u2744', label: 'Snow',  tint: '#cfe8ff' }, // snowflake
};

/**
 * Stable pseudo-random in [0,1) from an integer seed - gives each particle a
 * fixed lane/offset so the field looks coherent frame-to-frame (no per-frame
 * Math.random sparkle). Cheap LCG-style hash.
 */
function particleRand(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Draw the precipitation overlay + the weather/temperature HUD readout.
 * No-op for the smoke stub (no real canvas) and when weather is 'clear'
 * (overlay only - the readout still shows for clear).
 */
export function drawWeather(ctx: CanvasRenderingContext2D): void {
  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  const weather = getWeather();
  const temp = getTemperature();
  const vis = WEATHER_VIS[weather];
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

  ctx.save();

  // --- 1. Precipitation overlay (skip when clear) ---
  // Rain draws fewer streaks than snow draws flakes (R9 "rain too heavy"):
  // the shower should read as light as the halved spawn rate makes it.
  const PRECIP_PARTICLES =
    weather === 'rain' ? RAIN_OVERLAY_DENSITY : WEATHER_OVERLAY_DENSITY;
  if (weather === 'rain' || weather === 'snow') {
    // Sky-darken wash so storms read as gloomier (config-driven tint).
    ctx.fillStyle = weather === 'rain' ? WEATHER_SKY_DARKEN_RAIN : WEATHER_SKY_DARKEN_SNOW;
    ctx.fillRect(0, 0, cw, ch);
    if (weather === 'rain') {
      ctx.strokeStyle = RAIN_STREAK_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < PRECIP_PARTICLES; i++) {
        const laneX = particleRand(i) * cw;
        const speed = 700 + particleRand(i + 999) * 300; // px/s, fast
        const y = ((particleRand(i + 7) * ch + t * speed) % (ch + 20)) - 10;
        const x = (laneX + y * 0.25) % cw; // slight diagonal slant
        ctx.moveTo(x, y);
        ctx.lineTo(x - 2, y + 10);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = SNOW_FLECK_COLOR;
      for (let i = 0; i < PRECIP_PARTICLES; i++) {
        const speed = 60 + particleRand(i + 999) * 50; // px/s, slow drift
        const baseX = particleRand(i) * cw;
        const y = ((particleRand(i + 7) * ch + t * speed) % (ch + 8)) - 4;
        const x = (baseX + Math.sin((y + i * 30) * 0.05) * 8 + cw) % cw; // sway
        const r = 1 + particleRand(i + 3) * 1.2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // --- 2. Weather + temperature readout (always shown) ---
  // Sits just below the minimap strip at the top of the canvas.
  const text = `${vis.icon} ${vis.label}  ${Math.round(temp)}\u00b0`; // deg
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const x = cw - 6;
  const y = (MINIMAP_AT_TOP ? MINIMAP_HEIGHT_PX : 0) + 4;
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillText(text, x + 1, y + 1); // shadow
  ctx.fillStyle = vis.tint;
  ctx.fillText(text, x, y);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Needs bars (GDD 12.2 bars over survivors)
// ---------------------------------------------------------------------------

/** Width (px) of a single needs bar - matches the body's visual footprint. */
const BAR_W = CELL_SIZE * BODY_W;
/** Height (px) of each individual bar (hunger, thirst, or warmth). */
const BAR_H = 3;
/** Vertical gap (px) between bars. */
const BAR_GAP = 1;

/**
 * Colour for a bar whose value is v with a critical threshold t.
 * Green when comfortably above threshold, amber just above, red below.
 */
function barColor(v: number, threshold: number): string {
  const frac = v / NEED_MAX; // 0-1
  const critFrac = threshold / NEED_MAX;
  if (frac > critFrac + 0.15) return '#44cc44'; // green
  if (frac > critFrac)        return '#ddaa00'; // amber
  return '#cc2222';                              // red
}

/**
 * Colour for the WARMTH bar - distinct from hunger/thirst so the player can
 * tell them apart at a glance. Healthy = warm-orange (#ee8800); critical tint
 * uses the same amber -> red ladder as the other bars (GDD 12.2, Task W4).
 */
function warmthBarColor(v: number): string {
  const frac = v / NEED_MAX;
  const critFrac = WARMTH_THRESHOLD / NEED_MAX;
  if (frac > critFrac + 0.15) return '#ee8800'; // warm-orange (healthy)
  if (frac > critFrac)        return '#ddaa00'; // amber (approaching critical)
  return '#cc2222';                              // red (frozen)
}

/**
 * Draw one horizontal bar (filled + outline) at canvas pixel position (px, py).
 * fill is the fraction filled (0-1 clamped).
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
    // Three-bar stack: total height = BAR_H*3 + BAR_GAP*2; sit it just above
    // the anchor so all bars clear the head (Task W4, GDD 12.2).
    const py = sc.y - (BAR_H * 3 + BAR_GAP * 2);

    // Off-screen cull: skip if clearly outside the visible area.
    if (px + BAR_W < -4 || px > cw + 4) continue;
    if (py + BAR_H * 3 + BAR_GAP * 2 < -4 || py > ch + 4) continue;

    // Hunger bar (top).
    drawBar(
      ctx,
      px,
      py,
      s.needs.hunger / NEED_MAX,
      barColor(s.needs.hunger, HUNGER_THRESHOLD),
    );

    // Thirst bar (middle, just below hunger).
    drawBar(
      ctx,
      px,
      py + BAR_H + BAR_GAP,
      s.needs.thirst / NEED_MAX,
      barColor(s.needs.thirst, THIRST_THRESHOLD),
    );

    // Warmth bar (bottom, distinct warm-orange hue; GDD 12.2 Task W4).
    // Uses warmthBarColor() so it reads differently from hunger/thirst green.
    const warmthY = py + (BAR_H + BAR_GAP) * 2;
    drawBar(
      ctx,
      px,
      warmthY,
      s.needs.warmth / NEED_MAX,
      warmthBarColor(s.needs.warmth),
    );

    // Wet icon (VS-2 T-C, GDD 6.1 HUD "a wet icon"): a small blue droplet glyph
    // just right of the warmth bar when the survivor is meaningfully wet
    // (wetness >= WET_ICON_THRESHOLD). Wetness amplifies the cold, so the player
    // sees at a glance who needs to dry off by a fire.
    if (s.wetness >= WET_ICON_THRESHOLD * NEED_MAX) {
      const ix = px + BAR_W + 3;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText('\u2614', ix + 1, warmthY + 1); // shadow (umbrella w/ rain)
      ctx.fillStyle = '#7fb8ff'; // wet blue
      ctx.fillText('\u2614', ix, warmthY);
    }
  }

  ctx.restore();
}

/**
 * Selection highlight (v0.8 playtest K): a dashed box that TRACKS the selected
 * survivor's body each frame (drawn in screen space via worldToScreen), so the
 * player can see who the floating role-menu applies to - even while the survivor
 * walks around. No-op for a null/dead survivor or a missing/zero-size canvas.
 */
export function drawSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  survivor: Survivor | null,
): void {
  if (!survivor || !survivor.body.alive) return;
  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  const cell = effectiveCellPx();
  const margin = 2; // world cells of padding around the figure
  // Body anchor is feet-centre: figure spans x in [-BODY_W/2, BODY_W/2], y in
  // [-(BODY_H-1), 0] above the feet. Box that, padded.
  const left = survivor.body.x - BODY_W / 2 - margin;
  const top = survivor.body.y - (BODY_H - 1) - margin;
  const sc = worldToScreen(left, top);
  const w = (BODY_W + margin * 2) * cell;
  const h = (BODY_H + margin * 2) * cell;
  if (sc.x + w < 0 || sc.x > cw || sc.y + h < 0 || sc.y > ch) return; // off-screen

  ctx.save();
  ctx.strokeStyle = '#ffe066'; // bright yellow selection
  ctx.lineWidth = 2;
  if (ctx.setLineDash) ctx.setLineDash([4, 3]);
  ctx.strokeRect(
    Math.round(sc.x) + 0.5,
    Math.round(sc.y) + 0.5,
    Math.round(w),
    Math.round(h),
  );
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Camp flag marker (playtest R9, game/camp.ts)
// ---------------------------------------------------------------------------

/**
 * Draw the planted camp flag - a pole with a green pennant at the flag's world
 * cell, tracked by the camera. No-op while no flag is planted. Pure ctx
 * overlay (never the ImageData path); guard-safe for stub/zero-size canvas.
 */
export function drawCampFlag(ctx: CanvasRenderingContext2D): void {
  const flag = getCampFlag();
  if (!flag) return;
  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  const cell = effectiveCellPx();
  const sc = worldToScreen(flag.x, flag.y);
  const poleH = cell * 6;
  if (sc.x < -40 || sc.x > cw + 40 || sc.y < -40 || sc.y > ch + poleH + 40) return;

  ctx.save();
  // Pole.
  ctx.fillStyle = '#d8c9a3';
  ctx.fillRect(Math.round(sc.x), Math.round(sc.y - poleH), Math.max(2, cell / 3), Math.round(poleH));
  // Pennant (green triangle flying right from the pole top).
  ctx.fillStyle = '#3dd25f';
  ctx.beginPath();
  ctx.moveTo(sc.x + cell / 3, sc.y - poleH);
  ctx.lineTo(sc.x + cell / 3 + cell * 3, sc.y - poleH + cell);
  ctx.lineTo(sc.x + cell / 3, sc.y - poleH + cell * 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Minimap strip (GDD 12.1 off-screen awareness)
// ---------------------------------------------------------------------------

/**
 * Convert a canvas client-x (pixels) within the minimap strip to the
 * corresponding world column (cells). Pure and unit-testable.
 * Strip spans the full canvas width (canvasWidthCss pixels) mapping to
 * world columns [0, WORLD_W].
 */
export function minimapXToWorld(clientX: number, canvasWidthCss: number): number {
  if (canvasWidthCss <= 0) return 0;
  const frac = Math.max(0, Math.min(1, clientX / canvasWidthCss));
  return Math.round(frac * WORLD_W);
}

/**
 * Given a world column, return the strip x (pixels) within a strip of
 * canvasWidthCss pixels. Inverse of minimapXToWorld (within integer rounding).
 */
function worldToStripX(worldX: number, canvasWidthCss: number): number {
  return (worldX / WORLD_W) * canvasWidthCss;
}

/**
 * Draw a thin minimap strip (full-width, MINIMAP_HEIGHT_PX tall) at the top
 * (or bottom) of the canvas. Plots survivors (cyan), alive zombies (red),
 * the stockpile point (yellow diamond) and the current camera window (white
 * outline). Guard-safe for zero-sized or stub canvas.
 * GDD 12.1 off-screen awareness.
 */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  opts: {
    survivors: Survivor[];
    zombies: Zombie[];
    camera: { x: number; y: number };
    viewportWpx: number;
    viewportHpx: number;
  },
): void {
  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  const stripY = MINIMAP_AT_TOP ? 0 : ch - MINIMAP_HEIGHT_PX;

  ctx.save();

  // Strip background.
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, stripY, cw, MINIMAP_HEIGHT_PX);

  // Helper: draw a 2x2 dot.
  const dot = (worldX: number, color: string): void => {
    const sx = worldToStripX(worldX, cw);
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(sx) - 1, stripY + MINIMAP_HEIGHT_PX / 2 - 1, 2, 2);
  };

  // Stockpile marker (yellow, 3x3).
  if (stockpilePoint.x !== 0 || stockpilePoint.y !== 0) {
    const sx = worldToStripX(stockpilePoint.x, cw);
    ctx.fillStyle = '#ffdd00';
    ctx.fillRect(Math.round(sx) - 1, stripY + 1, 3, MINIMAP_HEIGHT_PX - 2);
  }

  // Camp flag marker (green, playtest R9): where the survivors build camp.
  const flag = getCampFlag();
  if (flag) {
    const fx = worldToStripX(flag.x, cw);
    ctx.fillStyle = '#3dd25f';
    ctx.fillRect(Math.round(fx) - 1, stripY + 1, 3, MINIMAP_HEIGHT_PX - 2);
  }

  // Alive zombies (red).
  for (const z of opts.zombies) {
    if (z.body.alive) dot(z.body.x, '#ff4444');
  }

  // Alive survivors (cyan).
  for (const s of opts.survivors) {
    if (s.body.alive) dot(s.body.x, '#44ffff');
  }

  // Camera window (white outline).
  // Visible width in world cells depends on zoom (GDD 12.3): the minimap maps
  // the WHOLE world (zoom-independent), but the camera window rect must shrink
  // when zoomed in and grow when zoomed out.
  const camLeft = worldToStripX(opts.camera.x, cw);
  const camRight = worldToStripX(
    opts.camera.x + opts.viewportWpx / effectiveCellPx(),
    cw,
  );
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(camLeft),
    stripY + 1,
    Math.max(2, Math.round(camRight - camLeft)),
    MINIMAP_HEIGHT_PX - 2,
  );

  ctx.restore();
}

/**
 * Determine which direction (if any) a world column is relative to the current
 * camera window. Returns '' when the column is on-screen.
 * GDD 12.1 off-screen alert arrows.
 */
export function directionToWorldX(
  worldX: number,
  cam: { x: number },
  viewportWpx: number,
): '\u2190' | '\u2192' | '' {
  const visLeft = cam.x;
  const visRight = cam.x + viewportWpx / effectiveCellPx();
  if (worldX < visLeft) return '\u2190'; // <-
  if (worldX >= visRight) return '\u2192'; // ->
  return '';
}

/**
 * Draw directional edge arrows for off-screen zombie clusters.
 * Left arrow at the left screen edge when zombies exist left of camera;
 * right arrow at the right edge when zombies exist right of camera.
 * Arrow size and opacity scale with the count of off-screen zombies on that
 * side. Guard-safe for zero-sized canvas.
 * GDD 12.1 off-screen awareness.
 */
export function drawEdgeArrows(
  ctx: CanvasRenderingContext2D,
  zombies: Zombie[],
  cam: { x: number; y: number },
  viewportWpx: number,
  viewportHpx: number,
): void {
  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  const visLeft = cam.x;
  const visRight = cam.x + viewportWpx / effectiveCellPx();

  let leftCount = 0;
  let rightCount = 0;
  for (const z of zombies) {
    if (!z.body.alive) continue;
    if (z.body.x < visLeft) leftCount++;
    else if (z.body.x >= visRight) rightCount++;
  }

  if (leftCount === 0 && rightCount === 0) return;

  ctx.save();

  // Vertical centre (accounting for minimap strip).
  const midY = MINIMAP_AT_TOP
    ? MINIMAP_HEIGHT_PX + (ch - MINIMAP_HEIGHT_PX) / 2
    : ch / 2;

  const drawArrow = (
    count: number,
    side: 'left' | 'right',
  ): void => {
    if (count === 0) return;
    const opacity = Math.min(1, 0.4 + count * 0.12);
    const size = Math.min(32, 16 + count * 2); // px, capped at 32
    ctx.globalAlpha = opacity;
    ctx.font = `bold ${size}px monospace`;
    ctx.textAlign = side === 'left' ? 'left' : 'right';
    ctx.textBaseline = 'middle';

    // Drop shadow.
    ctx.fillStyle = '#000';
    if (side === 'left') {
      ctx.fillText('\u25c4', 3, midY + 1); // <
    } else {
      ctx.fillText('\u25ba', cw - 3, midY + 1); // >
    }
    // Arrow (red-orange for threat).
    ctx.fillStyle = '#ff6622';
    if (side === 'left') {
      ctx.fillText('\u25c4', 2, midY); // <
    } else {
      ctx.fillText('\u25ba', cw - 4, midY); // >
    }
  };

  drawArrow(leftCount, 'left');
  drawArrow(rightCount, 'right');

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Under-attack alert (task 11-4, GDD 12 UX readability)
// ---------------------------------------------------------------------------

/**
 * Draw left / right edge alert arrows when a structure cell is being breached
 * OFF-SCREEN (GDD 12.1 off-screen awareness). Driven by `recentChips` from
 * game/breaching.ts - any chip older than CHIP_FLASH_TICKS is ignored so the
 * alert fades naturally when the breach stops.
 *
 * Reuses the `directionToWorldX` helper (same formula as drawEdgeArrows) and
 * draws a small warning glyph + arrow at the vertical mid-point of the screen
 * (below the zombie edge arrows, above the toolbar). Guard-safe for zero canvas.
 * Only active when `UNDER_ATTACK_ALERT` config flag is true.
 */
export function drawUnderAttackAlert(
  ctx: CanvasRenderingContext2D,
  cam: { x: number },
  viewportWpx: number,
  viewportHpx: number,
): void {
  if (!UNDER_ATTACK_ALERT) return;

  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  const tick = getBreachTick();
  let alertLeft = false;
  let alertRight = false;

  for (const [key, chipTick] of recentChips) {
    if (tick - chipTick >= CHIP_FLASH_TICKS) continue; // expired
    // Recover world-x from the flat cell index (formula inverse of grid.idx).
    const cellX = key % WORLD_W;
    const dir = directionToWorldX(cellX, cam, viewportWpx);
    if (dir === '\u2190') alertLeft = true;
    if (dir === '\u2192') alertRight = true;
    if (alertLeft && alertRight) break; // both sides found - no need to keep scanning
  }

  if (!alertLeft && !alertRight) return;

  ctx.save();

  // Vertical position: below the zombie edge arrows (those sit at midY),
  // so offset by ~40 px to avoid overlapping them.
  const midY = MINIMAP_AT_TOP
    ? MINIMAP_HEIGHT_PX + (ch - MINIMAP_HEIGHT_PX) / 2
    : ch / 2;
  const alertY = midY + 40;

  ctx.font = 'bold 16px monospace';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.92;

  if (alertLeft) {
    ctx.textAlign = 'left';
    // Shadow.
    ctx.fillStyle = '#000';
    ctx.fillText('\u26a0\u2190', 3, alertY + 1);
    // Amber warning.
    ctx.fillStyle = '#ff8800';
    ctx.fillText('\u26a0\u2190', 2, alertY);
  }
  if (alertRight) {
    ctx.textAlign = 'right';
    // Shadow.
    ctx.fillStyle = '#000';
    ctx.fillText('\u26a0\u2192', cw - 3, alertY + 1);
    // Amber warning.
    ctx.fillStyle = '#ff8800';
    ctx.fillText('\u26a0\u2192', cw - 4, alertY);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// End screen (GDD 12.2 win/lose message)
// ---------------------------------------------------------------------------

/**
 * When state.status is not 'playing', render a semi-transparent dim overlay
 * and centred large text describing the outcome.
 *
 *   Won  -> "YOU SURVIVED - Wave N"
 *   Lost -> "COLONY LOST - <cause>"
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

// ---------------------------------------------------------------------------
// Hit-flash registry (task 11-7, GDD 12 UX readability)
//
// A tiny time-bounded juice layer. registerHit() records the world position of
// a fresh damage event; drawHitFlashes() renders a brief expanding ring there
// via the ctx overlay (NEVER the ImageData path - putImageData invariant kept).
// The array is hard-capped at MAX_HIT_FLASHES: when full the OLDEST entry is
// evicted so the count never grows unboundedly. Flashes expire after exactly
// HIT_FLASH_TICKS ticks via advanceHitFlashes().
// ---------------------------------------------------------------------------
import { HIT_FLASH_TICKS, MAX_HIT_FLASHES } from '../config';

interface HitFlash {
  worldX: number;
  worldY: number;
  age: number; // ticks since creation (0 = fresh; expires when >= HIT_FLASH_TICKS)
}

const _hitFlashes: HitFlash[] = [];

/**
 * Record a hit at the given world position so drawHitFlashes can render the
 * brief ring this and subsequent frames. If MAX_HIT_FLASHES are already active
 * the oldest entry is evicted (array stays bounded - NEVER grows past the cap).
 * Safe to call from the sim (pure data write, no DOM or ctx access).
 */
export function registerHit(worldX: number, worldY: number): void {
  if (_hitFlashes.length >= MAX_HIT_FLASHES) {
    _hitFlashes.shift(); // evict oldest - O(n) but n<=24, negligible
  }
  _hitFlashes.push({ worldX, worldY, age: 0 });
}

/**
 * Advance all active hit-flash timers by one tick and prune expired entries.
 * Call once per simulation tick (BEFORE drawHitFlashes) so the ring expands
 * frame-consistently regardless of the sim-speed multiplier.
 */
export function advanceHitFlashes(): void {
  for (let i = _hitFlashes.length - 1; i >= 0; i--) {
    _hitFlashes[i].age++;
    if (_hitFlashes[i].age >= HIT_FLASH_TICKS) {
      _hitFlashes.splice(i, 1);
    }
  }
}

/**
 * Expose the internal hit-flash array length for unit tests.
 * @internal
 */
export function _hitFlashCount(): number {
  return _hitFlashes.length;
}

/**
 * Draw brief expanding rings for each active hit flash. Must be called AFTER
 * renderer.render() and BEFORE the end-screen dim so the rings appear above the
 * world but below any full-screen overlays. Guard-safe for zero-sized canvas.
 *
 * Ring design: starts small (radius=2 cells) and expands linearly to ~5 cells
 * over HIT_FLASH_TICKS, fading from opaque white -> transparent. Costs one
 * ctx.arc + ctx.stroke per active flash - bounded by MAX_HIT_FLASHES.
 */
export function drawHitFlashes(
  ctx: CanvasRenderingContext2D,
  _camera: { x: number; y: number },
  _vpW: number,
  _vpH: number,
): void {
  if (_hitFlashes.length === 0) return;

  const canvas = ctx.canvas;
  if (!canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;

  const cellPx = effectiveCellPx(); // screen px per world cell (zoom-aware)

  ctx.save();
  ctx.lineWidth = 1.5;

  for (const f of _hitFlashes) {
    const progress = f.age / HIT_FLASH_TICKS; // 0 -> 1
    const alpha = 1 - progress;               // fade out
    const radiusCells = 2 + progress * 3;     // 2->5 cells
    const radiusPx = radiusCells * cellPx;

    // Convert world anchor to screen pixels.
    const sc = worldToScreen(f.worldX, f.worldY);
    const sx = sc.x;
    const sy = sc.y;

    // Cull off-screen rings (not mandatory - canvas clips anyway, but avoids
    // needless arc calls for distant flashes).
    if (sx + radiusPx < -4 || sx - radiusPx > cw + 4) continue;
    if (sy + radiusPx < -4 || sy - radiusPx > ch + 4) continue;

    ctx.globalAlpha = Math.max(0, alpha);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}
