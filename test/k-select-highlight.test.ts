/**
 * Headless verification for v0.8 playtest K - the selection highlight that
 * tracks the selected survivor (ui.drawSelectionHighlight). Real module, stub
 * ctx that records strokeRect calls. Run via tsc (commonjs) -> node.
 *
 * Covers:
 *   1. A selected, on-screen, alive survivor draws exactly one box (strokeRect),
 *      and the box TRACKS the body (moving the body moves the box).
 *   2. null selection draws nothing.
 *   3. A dead survivor draws nothing.
 *   4. SELECT_TAP_RADIUS was widened (forgiving pick of a moving sprite).
 */
import { SELECT_TAP_RADIUS } from '../src/config';

declare const require: (m: string) => any;

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

function makeStubCtx(): { ctx: any; rects: Array<{ x: number; y: number }> } {
  const rects: Array<{ x: number; y: number }> = [];
  const ctx: any = {
    canvas: { width: 800, height: 600 },
    save() {},
    restore() {},
    setLineDash() {},
    strokeRect(x: number, y: number) {
      rects.push({ x, y });
    },
    fillRect() {},
    fillText() {},
    set strokeStyle(_v: any) {},
    get strokeStyle() {
      return '#000';
    },
    set lineWidth(_v: any) {},
    get lineWidth() {
      return 1;
    },
  };
  return { ctx, rects };
}

const ui = require('../src/game/ui');
const draw: (ctx: any, s: any) => void = ui.drawSelectionHighlight;

function survivor(x: number, y: number, alive = true): any {
  return { body: { x, y, alive }, turned: false };
}

// 1. Selected alive survivor -> one box; moving the body moves the box.
{
  const { ctx, rects } = makeStubCtx();
  const s = survivor(50, 60); // well within the 800x600 view at CELL_SIZE=6
  draw(ctx, s);
  check(rects.length === 1, '1: a selected survivor draws one selection box');
  const x0 = rects[0].x;

  const moved = makeStubCtx();
  s.body.x = 70; // survivor walks right (still on-screen)
  draw(moved.ctx, s);
  check(moved.rects.length === 1, '1: still one box after the survivor moves');
  check(moved.rects[0].x > x0, '1: the box TRACKS the sprite (box x followed body x)');
}

// 2. null selection -> nothing.
{
  const { ctx, rects } = makeStubCtx();
  draw(ctx, null);
  check(rects.length === 0, '2: no box when nothing is selected');
}

// 3. Dead survivor -> nothing.
{
  const { ctx, rects } = makeStubCtx();
  draw(ctx, survivor(100, 80, false));
  check(rects.length === 0, '3: no box for a dead survivor');
}

// 4. Forgiving pick radius widened (was 6).
check(SELECT_TAP_RADIUS >= 12, `4: SELECT_TAP_RADIUS widened for moving sprites (${SELECT_TAP_RADIUS})`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) throw new Error('k-select-highlight assertions failed');
console.log(
  'SUMMARY: the selection highlight draws a single box that tracks the selected survivor each frame, nothing for null/dead, and the tap radius is widened so a moving survivor is easy to select.',
);
