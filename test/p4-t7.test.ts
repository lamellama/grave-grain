/**
 * Headless verification for p4-t7 (Shoot tool picking — THE GATE hand-test).
 * Imports the PURE pick query (no DOM, no input plumbing). tsc (commonjs) -> node.
 *
 * Covers GDD §14 Milestone 0 hand-test geometry:
 *   1. a world cell over the LEFT leg returns 'lLeg'
 *   2. a world cell over the HEAD returns 'head'
 *   3. a far-away cell returns null
 *   4. a dead body returns null
 *   5. a destroyed bone is never picked (its pixels are skipped)
 */
import { SHOOT_PICK_RADIUS } from '../src/config';
import { createBody } from '../src/characters/body';
import { pickBone } from '../src/characters/pick';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

// Body at feet-centre (100, 100). rx=100, ry=100.
//   head cells:  x∈{99,100},  y∈{89,90,91}
//   lLeg cells:  x∈{98,99},   y∈{97,98,99,100}
const body = createBody(100, 100);

// 1. Over the left leg.
{
  const name = pickBone(body, 98, 99);
  if (name !== 'lLeg') fail(`left-leg click returned ${name}, expected 'lLeg'`);
  ok("cell (98,99) over left leg → 'lLeg'");
}

// 2. Over the head.
{
  const name = pickBone(body, 100, 90);
  if (name !== 'head') fail(`head click returned ${name}, expected 'head'`);
  ok("cell (100,90) over head → 'head'");
}

// 3. Far away → null (well beyond SHOOT_PICK_RADIUS).
{
  const name = pickBone(body, 300, 300);
  if (name !== null) fail(`far-away click returned ${name}, expected null`);
  ok(`cell (300,300) far away → null (radius ${SHOOT_PICK_RADIUS})`);
}

// 4. Dead body → null regardless of where you click.
{
  const dead = createBody(100, 100);
  dead.alive = false;
  const name = pickBone(dead, 100, 90);
  if (name !== null) fail(`dead-body click returned ${name}, expected null`);
  ok('dead body → null');
}

// 5. A destroyed bone is skipped — clicking the head after it is gone falls to
//    the nearest still-standing bone (torso) if in range, else null.
{
  const b2 = createBody(100, 100);
  const head = b2.rig.find((bn) => bn.name === 'head')!;
  head.destroyed = true;
  const name = pickBone(b2, 100, 90);
  if (name === 'head') fail('destroyed head was still picked');
  ok(`destroyed head skipped → ${name}`);
}

console.log('\nALL PASS');
console.log('SUMMARY: pickBone is pure (no DOM); left-leg→lLeg, head→head, far→null, dead→null, destroyed bone skipped.');
