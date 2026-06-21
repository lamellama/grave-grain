declare const process: any;
/**
 * p12-corpse-render.test.ts — Headless test for Task 2: corpse render list,
 * decay lifecycle, and MAX_CORPSES cap.
 *
 * Tests the PURE helpers in src/characters/corpseLifecycle.ts so no DOM stubs
 * are needed. GDD §5.1 / §13.
 *
 * Done-when:
 *   (a) A body with corpse=true, corpseTicks>0 is INCLUDED in the render list.
 *   (b) After corpseTicks decrements to 0, the body is EXCLUDED (retired).
 *   (c) When >MAX_CORPSES corpses are active, the count is clamped to MAX_CORPSES
 *       by retiring the oldest (lowest corpseTicks).
 */

import { createBody } from '../src/characters/body';
import { buildCorpseRenderList, tickCorpseDecay } from '../src/characters/corpseLifecycle';
import { MAX_CORPSES, CORPSE_DECAY_TICKS } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  process.exit(1);
  throw new Error(msg); // satisfy TS never return
}

function ok(msg: string): void {
  console.log('PASS:', msg);
}

// ---------------------------------------------------------------------------
// Helper: make a fake corpse body (no grid, no world — just in-memory state).
// ---------------------------------------------------------------------------
function makeCorpse(corpseTicks: number) {
  const body = createBody(0, 0);
  body.alive = false;
  body.corpse = true;
  body.corpseTicks = corpseTicks;
  return body;
}

// ---------------------------------------------------------------------------
// (a) Body with corpse=true, corpseTicks>0 → INCLUDED in render list.
// ---------------------------------------------------------------------------
{
  const body = makeCorpse(CORPSE_DECAY_TICKS);
  const list = buildCorpseRenderList([body]);
  if (!list.includes(body)) fail('(a) active corpse not included in render list');
  ok(`(a) body with corpse=true corpseTicks=${CORPSE_DECAY_TICKS} is INCLUDED. list.length=${list.length}`);
}

// ---------------------------------------------------------------------------
// (a2) alive body → excluded.
// ---------------------------------------------------------------------------
{
  const alive = createBody(0, 0);  // alive=true by default
  const list = buildCorpseRenderList([alive]);
  if (list.includes(alive)) fail('(a2) alive body should NOT appear in corpse render list');
  ok('(a2) alive body correctly EXCLUDED from corpse render list');
}

// ---------------------------------------------------------------------------
// (a3) corpse=false body → excluded.
// ---------------------------------------------------------------------------
{
  const body = createBody(0, 0);
  body.alive = false;
  body.corpse = false;
  body.corpseTicks = 100;
  const list = buildCorpseRenderList([body]);
  if (list.includes(body)) fail('(a3) retired corpse (corpse=false) should be excluded');
  ok('(a3) retired corpse (corpse=false) correctly EXCLUDED');
}

// ---------------------------------------------------------------------------
// (b) tickCorpseDecay: corpseTicks decrements to 0 → body retired (corpse=false).
// ---------------------------------------------------------------------------
{
  const body = makeCorpse(3); // only 3 ticks of life
  const bodies = [body];

  tickCorpseDecay(bodies); // ticks: 3 → 2
  const after1 = buildCorpseRenderList(bodies);
  if (!after1.includes(body)) fail('(b) body at corpseTicks=2 should still be included');

  tickCorpseDecay(bodies); // 2 → 1
  tickCorpseDecay(bodies); // 1 → 0 → retired (corpse=false)

  if (body.corpse !== false) fail(`(b) body.corpse should be false after decay; got ${body.corpse}`);
  if (body.corpseTicks !== 0) fail(`(b) corpseTicks should be 0; got ${body.corpseTicks}`);

  const after3 = buildCorpseRenderList(bodies);
  if (after3.includes(body)) fail('(b) retired corpse should be EXCLUDED after corpseTicks=0');

  ok(`(b) corpse decayed over 3 ticks; retired at corpseTicks=0 (corpse=false), EXCLUDED from render list`);
}

// ---------------------------------------------------------------------------
// (c) MAX_CORPSES cap: >MAX_CORPSES active corpses → oldest retired, count clamped.
// ---------------------------------------------------------------------------
{
  const OVER = MAX_CORPSES + 5;
  const bodies = [];
  // Create OVER corpses with varying corpseTicks: 1..OVER (ascending).
  // Lowest corpseTicks = oldest = should be retired first.
  for (let i = 1; i <= OVER; i++) {
    bodies.push(makeCorpse(i)); // corpseTicks = 1, 2, ..., OVER
  }

  const list = buildCorpseRenderList(bodies);

  if (list.length !== MAX_CORPSES)
    fail(`(c) expected ${MAX_CORPSES} active corpses after cap; got ${list.length}`);

  // Verify the OLDEST (lowest corpseTicks = 1..5) were retired.
  const retiredCount = bodies.filter((b) => !b.corpse).length;
  if (retiredCount !== 5) fail(`(c) expected 5 retired corpses; got ${retiredCount}`);

  // Verify the retired ones were the oldest (corpseTicks 1..5).
  const retiredTicks = bodies.filter((b) => !b.corpse).map((b) => b.corpseTicks);
  const maxRetiredTick = Math.max(...retiredTicks);
  if (maxRetiredTick > 5)
    fail(`(c) a retired corpse had corpseTicks=${maxRetiredTick} > 5 (should retire OLDEST first)`);

  ok(
    `(c) ${OVER} corpses capped to ${MAX_CORPSES}; ${retiredCount} oldest retired ` +
      `(their corpseTicks: ${retiredTicks.sort((a, b) => a - b).join(',')}); ` +
      `active count = ${list.length}`,
  );
}

// ---------------------------------------------------------------------------
// (d) Full lifecycle: CORPSE_DECAY_TICKS ticks to full retirement.
// ---------------------------------------------------------------------------
{
  const body = makeCorpse(CORPSE_DECAY_TICKS);
  const bodies = [body];
  let ticksDriven = 0;
  while (body.corpse) {
    tickCorpseDecay(bodies);
    ticksDriven++;
    if (ticksDriven > CORPSE_DECAY_TICKS + 10)
      fail(`(d) corpse never retired after ${ticksDriven} ticks (CORPSE_DECAY_TICKS=${CORPSE_DECAY_TICKS})`);
  }
  if (ticksDriven !== CORPSE_DECAY_TICKS)
    fail(`(d) expected retirement after ${CORPSE_DECAY_TICKS} ticks; got ${ticksDriven}`);
  ok(`(d) corpse persisted for exactly CORPSE_DECAY_TICKS=${CORPSE_DECAY_TICKS} ticks then retired`);
}

console.log('\nALL PASS');
console.log(
  `SUMMARY: buildCorpseRenderList includes active corpses, excludes dead/retired;\n` +
    `tickCorpseDecay decrements corpseTicks and retires at 0;\n` +
    `MAX_CORPSES cap (${MAX_CORPSES}) retires oldest corpses first.`,
);
