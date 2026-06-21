/**
 * p12-deathlog — Task 5: death-log records corpse deaths + turns (GDD §12.2).
 *
 * Tests (headless, minimal stubs):
 *  (a) A survivor that starves → exactly ONE deathLog entry, cause = 'starvation'.
 *  (b) A survivor that turns (s.turned = true) → exactly ONE deathLog entry with
 *      cause containing 'turned'; the alive-watcher does NOT also fire for the
 *      same survivor (no double-count even if body.alive stays true).
 *  (c) Cap holds at 8: with 10 deaths only the last 8 remain.
 */

import { createGameState, updateGameState } from '../src/game/state';
import type { WaveState } from '../src/game/waves';
import { WIN_WAVES } from '../src/config';

declare const process: any;

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log('  PASS:', msg); }
  else { console.error('  FAIL:', msg); failed++; }
}

// ---------------------------------------------------------------------------
// Minimal survivor stubs — only fields state.ts reads.
// ---------------------------------------------------------------------------
function makeSurvivor(alive: boolean, deathCause: string | null = null, turned = false): any {
  return { body: { alive, x: 100, y: 50 }, deathCause, turned };
}

function playingWaveState(): WaveState {
  return { waveNumber: 1, ticksToNextWave: 999, pendingThisWave: 0, ticksToNextSpawn: 0 };
}

// ---------------------------------------------------------------------------
// (a) Starve → exactly one deathLog entry, cause = 'starvation'
// ---------------------------------------------------------------------------
console.log('\n(a) Starvation / corpse death');
{
  const gs = createGameState();
  const s = makeSurvivor(true);
  const ws = playingWaveState();

  // Tick 0 — register alive.
  updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 0 });
  assert(gs.deathLog.length === 0, 'no entries before death');

  // Kill with starvation cause.
  s.body.alive = false;
  s.deathCause = 'starvation';

  // Tick 1 — death detected.
  updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 1 });
  assert(gs.deathLog.length === 1, `exactly 1 death-log entry (got ${gs.deathLog.length})`);
  assert(gs.deathLog[0].cause === 'starvation', `cause = 'starvation' (got '${gs.deathLog[0]?.cause}')`);
  console.log('  entry:', JSON.stringify(gs.deathLog[0]));

  // State latched to 'lost'; no more entries on re-tick.
  const lenBefore = gs.deathLog.length;
  // (status is 'lost' so updateGameState latches — verify no extra entry)
  updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 2 });
  assert(gs.deathLog.length === lenBefore, 'no duplicate on latched tick');
}

// ---------------------------------------------------------------------------
// (b) Turn → one entry with cause containing 'turned'; alive-watcher NOT fired
// ---------------------------------------------------------------------------
console.log('\n(b) Turn (bitten → turned)');
{
  const gs = createGameState();
  // Two survivors so the game stays 'playing' long enough to test both ticks.
  const ally = makeSurvivor(true);
  const victim = makeSurvivor(true); // will turn (alive stays true)
  const ws = playingWaveState();

  // Tick 0 — register both alive (body.alive = true, turned = false).
  updateGameState(gs, { survivors: [ally, victim], waveState: ws, aliveZombieCount: 0, tick: 0 });
  assert(gs.deathLog.length === 0, 'no entries before turn');

  // Turn victim: set turned=true, body.alive stays true (zombie controller takes over).
  victim.turned = true;

  // Tick 1 — turn detected by turn-watcher.
  updateGameState(gs, { survivors: [ally, victim], waveState: ws, aliveZombieCount: 0, tick: 1 });
  assert(gs.deathLog.length === 1, `exactly 1 entry after turn (got ${gs.deathLog.length})`);
  assert(
    gs.deathLog[0].cause.includes('turned'),
    `cause includes 'turned' (got '${gs.deathLog[0]?.cause}')`
  );
  console.log('  entry:', JSON.stringify(gs.deathLog[0]));

  // Tick 2 — same turned survivor, should NOT fire again (neither turn nor alive-watcher).
  const lenBefore = gs.deathLog.length;
  updateGameState(gs, { survivors: [ally, victim], waveState: ws, aliveZombieCount: 0, tick: 2 });
  assert(gs.deathLog.length === lenBefore, 'no second entry for already-turned survivor');

  // Now kill the turned survivor's body (simulating the zombie being killed).
  // This should NOT fire the alive-watcher since the survivor was removed from _prevAlive
  // when it turned.
  victim.body.alive = false;
  updateGameState(gs, { survivors: [ally, victim], waveState: ws, aliveZombieCount: 0, tick: 3 });
  assert(gs.deathLog.length === lenBefore, 'killing a turned body does NOT add a second death entry');
  console.log('  deathLog after body kill:', JSON.stringify(gs.deathLog));
}

// ---------------------------------------------------------------------------
// (c) Cap holds at 8: 10 deaths → only last 8 remain
// ---------------------------------------------------------------------------
console.log('\n(c) Cap at 8 entries');
{
  const gs = createGameState();
  const ws = playingWaveState();
  // We need 10 distinct survivors (one death per survivor per tick).
  // Keep a permanent "alive" survivor to prevent 'lost' status after each death.
  const keeper = makeSurvivor(true);

  // Register them all alive first with keeper.
  const dying: any[] = [];
  for (let i = 0; i < 10; i++) dying.push(makeSurvivor(true, `cause-${i}`));

  // Tick 0: register all alive.
  updateGameState(gs, { survivors: [keeper, ...dying], waveState: ws, aliveZombieCount: 0, tick: 0 });

  // Kill one per tick so each registers as a fresh death.
  for (let i = 0; i < 10; i++) {
    dying[i].body.alive = false;
    updateGameState(gs, { survivors: [keeper, ...dying], waveState: ws, aliveZombieCount: 0, tick: i + 1 });
  }

  assert(gs.deathLog.length === 8, `deathLog capped at 8 (got ${gs.deathLog.length})`);
  // The last entry should be cause-9 (the most recent death).
  assert(
    gs.deathLog[gs.deathLog.length - 1].cause === 'cause-9',
    `last entry is cause-9 (got '${gs.deathLog[gs.deathLog.length - 1]?.cause}')`
  );
  // The first (oldest retained) should be cause-2.
  assert(
    gs.deathLog[0].cause === 'cause-2',
    `first retained entry is cause-2 (got '${gs.deathLog[0]?.cause}')`
  );
  console.log('  retained causes:', gs.deathLog.map(e => e.cause).join(', '));
}

// ---------------------------------------------------------------------------
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
