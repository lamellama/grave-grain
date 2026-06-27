/**
 * Headless verification for VS-2 Task T-C (rest) - campfire PLACEMENT, the
 * seekWarmth->campfire huddle, and the wet-icon HUD (GDD 8/6.1). Real modules.
 *
 * Covers:
 *   1. PLACEMENT: placeStructure('campfire') spends CAMPFIRE_COST wood and writes
 *      a CAMPFIRE cell; an unaffordable placement is refused (no spend, no cell).
 *   2. SEEK-TO-CAMPFIRE: a cold survivor with a reachable campfire but NO shelter
 *      auto-overrides to seekWarmth, walks to the campfire, and recovers warmth
 *      (never freezes) - the VS-2 "huddle by a campfire" Done-when.
 *   3. WET HUD: drawNeedsBars draws the wet glyph for a wet survivor, not a dry one.
 */
import {
  WORLD_W,
  NEED_MAX,
  WARMTH_THRESHOLD,
  COLD_THRESHOLD,
  CAMPFIRE_COST,
  WET_ICON_THRESHOLD,
} from '../src/config';
import { CAMPFIRE, STONE, AIR } from '../src/engine/materials';
import { material, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import * as resources from '../src/game/resources';
import { placeStructure, canPlace } from '../src/game/building';
import {
  createSurvivor,
  updateSurvivor,
  effectiveTemp,
} from '../src/characters/survivor';
import { __setWeatherForTest } from '../src/engine/weather';

declare const require: (m: string) => any;

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
/** Solid STONE floor, rows [top, top+8), across [x0,x1]. */
function floor(x0: number, x1: number, top = 150): void {
  for (let x = x0; x <= x1; x++) for (let r = top; r < top + 8; r++) set(x, r, STONE);
}

// ===========================================================================
// 1. PLACEMENT - costed, atomic, refused when unaffordable.
// ===========================================================================
clearGrid();
floor(180, 240);
{
  resources.resetStockpile();
  const need = CAMPFIRE_COST.wood as number;
  resources.addResource('wood', need + 1); // afford exactly one campfire, not two
  const before = resources.getStockpile().wood;

  const placed = placeStructure(210, 149, 'campfire');
  check(placed === true, '1: placeStructure(campfire) returns true when affordable');
  check(get(210, 149) === CAMPFIRE, '1: a CAMPFIRE cell was written to the grid');
  check(resources.getStockpile().wood === before - need, `1: spent exactly ${need} wood (atomic)`);

  // Now only (need-1) wood remains -> a second campfire is unaffordable.
  check(canPlace('campfire') === false, '1: canPlace(campfire) false once wood < cost');
  const placed2 = placeStructure(214, 149, 'campfire');
  check(placed2 === false, '1: unaffordable placement refused');
  check(get(214, 149) !== CAMPFIRE, '1: refused placement wrote nothing (no free campfire)');
}

// ===========================================================================
// 2. SEEK-TO-CAMPFIRE. Cold world (snow), open floor, NO shelter, one campfire a
//    short walk away. A cold survivor must seekWarmth -> reach the campfire ->
//    recover warmth without freezing.
// ===========================================================================
__setWeatherForTest('snow');
clearGrid();
floor(180, 260);
set(215, 149, CAMPFIRE); // a short walk from the spawn at 200; outside warmth range initially
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  s.needs.warmth = 40; // start below WARMTH_THRESHOLD so it wants warmth now
  // Spawn must NOT already be warm (campfire 15 cells away > FIRE_WARMTH_RADIUS 8).
  check(
    effectiveTemp(s.body) < COLD_THRESHOLD,
    '2: survivor starts cold and out of campfire range',
  );

  let sawSeek = false;
  let reached = false;
  let maxWarmth = s.needs.warmth;
  let diedTick = -1;
  for (let t = 0; t < 6000; t++) {
    s.needs.hunger = NEED_MAX; // isolate warmth as the only driver
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
    if (s.behaviour === 'seekWarmth') sawSeek = true;
    if (effectiveTemp(s.body) >= COLD_THRESHOLD) reached = true; // within campfire warmth
    if (s.needs.warmth > maxWarmth) maxWarmth = s.needs.warmth;
    if (!s.body.alive && diedTick < 0) diedTick = t;
  }

  check(sawSeek, '2: cold survivor auto-overrode to seekWarmth');
  check(reached, '2: survivor walked into the campfire warmth radius');
  check(diedTick < 0 && s.body.alive, '2: survivor never froze (campfire kept it alive)');
  check(maxWarmth > WARMTH_THRESHOLD, `2: warmth recovered above threshold (max ${maxWarmth.toFixed(1)})`);
}

// ===========================================================================
// 3. WET HUD - drawNeedsBars draws the wet glyph only when wet enough.
// ===========================================================================
const WET_GLYPH = '☔';
function makeHudCtx(): { ctx: any; texts: string[] } {
  const texts: string[] = [];
  const ctx: any = {
    canvas: { width: 800, height: 600 },
    save() {}, restore() {},
    fillRect() {}, strokeRect() {},
    set fillStyle(_v: any) {}, get fillStyle() { return '#000'; },
    set strokeStyle(_v: any) {}, get strokeStyle() { return '#000'; },
    set font(_v: any) {}, get font() { return ''; },
    set textAlign(_v: any) {}, get textAlign() { return 'left'; },
    set textBaseline(_v: any) {}, get textBaseline() { return 'top'; },
    set lineWidth(_v: any) {}, get lineWidth() { return 1; },
    set globalAlpha(_v: any) {}, get globalAlpha() { return 1; },
    fillText(txt: string) { texts.push(String(txt)); },
  };
  return { ctx, texts };
}
function hudSurvivor(wetness: number): any {
  return {
    body: { alive: true, prone: false, x: 100, y: 50 },
    turned: false,
    needs: { hunger: 80, thirst: 60, warmth: 40 },
    wetness,
  };
}
{
  const ui = require('../src/game/ui');
  // Wet survivor (>= threshold) -> wet glyph drawn.
  const wet = makeHudCtx();
  ui.drawNeedsBars(wet.ctx, [hudSurvivor(NEED_MAX)]);
  check(
    wet.texts.some((t) => t.indexOf(WET_GLYPH) !== -1),
    '3: wet survivor draws the wet glyph',
  );
  // Dry survivor (below threshold) -> no wet glyph.
  const dry = makeHudCtx();
  ui.drawNeedsBars(dry.ctx, [hudSurvivor(WET_ICON_THRESHOLD * NEED_MAX - 1)]);
  check(
    dry.texts.every((t) => t.indexOf(WET_GLYPH) === -1),
    '3: dry survivor draws NO wet glyph',
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) throw new Error('p12-campseek assertions failed');
console.log(
  'SUMMARY: campfire placement is costed/atomic/refused-when-broke; a cold survivor with a reachable campfire seeks it, huddles, and recovers warmth without freezing; the HUD shows a wet icon only when a survivor is meaningfully wet.',
);
