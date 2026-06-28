/**
 * Headless verification for VS-3 - survivor grouping by sight (groups.ts, GDD
 * 6.2/7.1/13). Real module. Fake survivor-shaped objects (groups.ts only reads
 * body.x/body.y/body.alive + turned). Run via tsc (commonjs) -> node.
 *
 * Covers:
 *   1. Co-located survivors form ONE group immediately (init, no debounce).
 *   2. Far-apart survivors are SEPARATE groups.
 *   3. Transitive: A-B-C in a chain (A can't see C) are ONE group (component).
 *   4. Line-of-sight: a solid wall between two in-range survivors blocks grouping.
 *   5. SPLIT debounce: lead one away -> still grouped until SPLIT_DEBOUNCE_TICKS,
 *      then it forks into its own group.
 *   6. MERGE debounce: bring two groups together -> separate until
 *      MERGE_DEBOUNCE_TICKS, then they rejoin.
 *   7. Interval gate: clustering only recomputes every GROUP_RECHECK_TICKS.
 *   8. Dead/turned survivors get group -1.
 */
import {
  SIGHT_RADIUS,
  GROUP_RECHECK_TICKS,
  SPLIT_DEBOUNCE_TICKS,
  MERGE_DEBOUNCE_TICKS,
} from '../src/config';
import { material, set } from '../src/engine/grid';
import { STONE, AIR } from '../src/engine/materials';
import {
  resetGroups,
  updateGroups,
  groupCount,
  groupIdOf,
  groupMembers,
} from '../src/game/groups';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
/** Minimal survivor-shaped object groups.ts understands. */
function sv(x: number, y: number, alive = true, turned = false): any {
  return { body: { x, y, alive }, turned };
}
/** Same-group test: do indices i and j share a (non -1) group? */
function sameGroup(i: number, j: number): boolean {
  const g = groupIdOf(i);
  return g >= 0 && g === groupIdOf(j);
}

// ===========================================================================
// 1. Co-located -> one group immediately.
// ===========================================================================
clearGrid();
{
  resetGroups();
  const survs = [sv(100, 100), sv(105, 100), sv(110, 100)];
  updateGroups(survs, 0);
  check(groupCount() === 1, '1: three co-located survivors form ONE group');
  check(sameGroup(0, 1) && sameGroup(1, 2), '1: all three share the group');
}

// ===========================================================================
// 2. Far apart -> separate groups.
// ===========================================================================
{
  resetGroups();
  const far = SIGHT_RADIUS + 10;
  const survs = [sv(100, 100), sv(100 + far, 100)];
  updateGroups(survs, 0);
  check(groupCount() === 2, '2: two far-apart survivors are SEPARATE groups');
  check(!sameGroup(0, 1), '2: they do not share a group');
}

// ===========================================================================
// 3. Transitive chain A-B-C (A cannot see C directly).
// ===========================================================================
{
  resetGroups();
  const step = SIGHT_RADIUS - 5; // adjacent pairs in range, ends out of range
  const survs = [sv(100, 100), sv(100 + step, 100), sv(100 + 2 * step, 100)];
  // sanity: ends are beyond sight of each other
  check(2 * step > SIGHT_RADIUS, '3: setup - A and C are beyond direct sight');
  updateGroups(survs, 0);
  check(groupCount() === 1, '3: A-B-C chain is ONE group (connected component)');
}

// ===========================================================================
// 4. Line-of-sight blocked by a solid wall.
// ===========================================================================
{
  resetGroups();
  clearGrid();
  // Two survivors 20 cells apart (well within sight), wall between them.
  const survs = [sv(100, 100), sv(120, 100)];
  for (let y = 90; y <= 110; y++) set(110, y, STONE); // vertical wall at x=110
  updateGroups(survs, 0);
  check(groupCount() === 2, '4: a wall between in-range survivors blocks grouping');
  clearGrid();
}

// ===========================================================================
// 5. SPLIT debounce. Start co-located (1 group); move one far; stays grouped
//    until SPLIT_DEBOUNCE_TICKS of continuous blindness, then forks.
// ===========================================================================
{
  resetGroups();
  clearGrid();
  const far = SIGHT_RADIUS + 50;
  const survs = [sv(100, 100), sv(105, 100)];
  updateGroups(survs, 0);
  check(groupCount() === 1, '5: co-located start = 1 group');

  // Move survivor 1 away; first recompute that SEES the change is at tick 30.
  survs[1].body.x = 100 + far;
  const changeTick = GROUP_RECHECK_TICKS; // 30
  // Just BEFORE the debounce elapses (elapsed = SPLIT_DEBOUNCE - 30): still 1 group.
  const beforeSplit = changeTick + SPLIT_DEBOUNCE_TICKS - GROUP_RECHECK_TICKS;
  for (let t = GROUP_RECHECK_TICKS; t <= beforeSplit; t += GROUP_RECHECK_TICKS) {
    updateGroups(survs, t);
  }
  check(groupCount() === 1, `5: still 1 group before split debounce (t=${beforeSplit})`);

  // One more recheck pushes elapsed >= SPLIT_DEBOUNCE_TICKS -> split.
  const splitTick = changeTick + SPLIT_DEBOUNCE_TICKS;
  updateGroups(survs, splitTick);
  check(groupCount() === 2, `5: split into 2 groups at debounce (t=${splitTick})`);
  check(!sameGroup(0, 1), '5: the led-away survivor is its own group');
}

// ===========================================================================
// 6. MERGE debounce. Start far apart (2 groups); bring together; separate until
//    MERGE_DEBOUNCE_TICKS of continuous sight, then rejoin.
// ===========================================================================
{
  resetGroups();
  clearGrid();
  const far = SIGHT_RADIUS + 50;
  const survs = [sv(100, 100), sv(100 + far, 100)];
  updateGroups(survs, 0);
  check(groupCount() === 2, '6: far-apart start = 2 groups');

  survs[1].body.x = 110; // now within sight; first seen at tick 30
  const changeTick = GROUP_RECHECK_TICKS;
  const beforeMerge = changeTick + MERGE_DEBOUNCE_TICKS - GROUP_RECHECK_TICKS;
  for (let t = GROUP_RECHECK_TICKS; t <= beforeMerge; t += GROUP_RECHECK_TICKS) {
    updateGroups(survs, t);
  }
  check(groupCount() === 2, `6: still 2 groups before merge debounce (t=${beforeMerge})`);

  const mergeTick = changeTick + MERGE_DEBOUNCE_TICKS;
  updateGroups(survs, mergeTick);
  check(groupCount() === 1, `6: merged into 1 group at debounce (t=${mergeTick})`);
}

// ===========================================================================
// 7. Interval gate - no recompute between GROUP_RECHECK_TICKS boundaries.
// ===========================================================================
{
  resetGroups();
  clearGrid();
  const survs = [sv(100, 100), sv(105, 100)];
  updateGroups(survs, 0); // 1 group
  // Move far apart but only tick a LITTLE (< interval) -> no recompute -> unchanged.
  survs[1].body.x = 100 + SIGHT_RADIUS + 50;
  updateGroups(survs, GROUP_RECHECK_TICKS - 1);
  check(groupCount() === 1, '7: no recompute before the recheck interval elapses');
}

// ===========================================================================
// 8. Dead / turned survivors get group -1.
// ===========================================================================
{
  resetGroups();
  clearGrid();
  const survs = [sv(100, 100), sv(105, 100, false), sv(108, 100, true, true)];
  updateGroups(survs, 0);
  check(groupIdOf(1) === -1, '8: a dead survivor has group -1');
  check(groupIdOf(2) === -1, '8: a turned survivor has group -1');
  check(groupIdOf(0) >= 0, '8: the alive survivor still has a real group');
  check(groupMembers(groupIdOf(0)).length === 1, '8: group has only the alive member');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) throw new Error('vs3-groups assertions failed');
console.log(
  'SUMMARY: sight grouping forms components by distance + line-of-sight; split/merge are debounced (SPLIT/MERGE_DEBOUNCE_TICKS); clustering recomputes only on the GROUP_RECHECK_TICKS interval; dead/turned survivors leave their group.',
);
