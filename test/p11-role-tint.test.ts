declare const require: any;
declare const process: any;
/**
 * p11-role-tint.test.ts — Headless tests for task 11-5 survivor role tints.
 *
 * Tests tintForRole() and ROLE_TINT exported from game/roles.ts (pure, DOM-free).
 *   1. tintForRole(rgb, 'none') returns rgb UNCHANGED.
 *   2. tintForRole(rgb, 'guard') blends toward the guard tint (result ≠ source,
 *      each channel between source and tint).
 *   3. Each non-none role yields a DISTINCT blended colour for a given source.
 *   4. Calling tintForRole twice returns consistent values (pure function).
 *   5. All four role tints are distinct from each other (ROLE_TINT table sanity).
 */

// ---------------------------------------------------------------------------
// Minimal stubs — roles.ts has no DOM dependency but camera / resources may
// be loaded transitively; guard against missing performance.now on some envs.
// ---------------------------------------------------------------------------
const g: any = globalThis;
g.performance = g.performance || { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Import under test (CommonJS require — compiled by tsconfig.p11-role-tint.json)
// ---------------------------------------------------------------------------
const { tintForRole, ROLE_TINT } = require('../src/game/roles');

// Source colour chosen to be clearly distinct from every role tint so the blend
// produces a visibly different result for each role.
const src: [number, number, number] = [200, 180, 160];

// ── Test 1: 'none' returns rgb unchanged ────────────────────────────────────
{
  const result: [number, number, number] = tintForRole(src, 'none');
  assert(
    result[0] === src[0] && result[1] === src[1] && result[2] === src[2],
    "tintForRole(rgb, 'none') returns rgb unchanged",
  );
}

// ── Test 2: 'guard' blends toward its tint (between source and tint) ────────
{
  const result: [number, number, number] = tintForRole(src, 'guard');
  const t: [number, number, number] = ROLE_TINT['guard'];

  // Must differ from source
  const different = result[0] !== src[0] || result[1] !== src[1] || result[2] !== src[2];
  assert(different, "tintForRole(rgb, 'guard') result ≠ source rgb");

  // Each channel must be between source and tint (inclusive)
  function between(v: number, a: number, b: number): boolean {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return v >= lo && v <= hi;
  }
  assert(
    between(result[0], src[0], t[0]) &&
    between(result[1], src[1], t[1]) &&
    between(result[2], src[2], t[2]),
    "tintForRole(rgb, 'guard') result is between source and guard tint",
  );
}

// ── Test 3: each non-none role yields a DISTINCT blended colour ──────────────
{
  const roles = ['miner', 'lumberjack', 'forager', 'guard'] as const;
  const results: Record<string, [number, number, number]> = {};

  for (const role of roles) {
    results[role] = tintForRole(src, role);
    console.log(`  Role ${role.padEnd(10)}: [${results[role].join(', ')}]`);
  }

  assert(
    JSON.stringify(results['miner']) !== JSON.stringify(results['lumberjack']),
    'miner tint ≠ lumberjack tint',
  );
  assert(
    JSON.stringify(results['lumberjack']) !== JSON.stringify(results['forager']),
    'lumberjack tint ≠ forager tint',
  );
  assert(
    JSON.stringify(results['forager']) !== JSON.stringify(results['guard']),
    'forager tint ≠ guard tint',
  );
  assert(
    JSON.stringify(results['miner']) !== JSON.stringify(results['guard']),
    'miner tint ≠ guard tint',
  );
}

// ── Test 4: pure function — consistent on repeated calls ────────────────────
{
  const r1: [number, number, number] = tintForRole(src, 'guard');
  const r2: [number, number, number] = tintForRole(src, 'guard');
  assert(
    r1[0] === r2[0] && r1[1] === r2[1] && r1[2] === r2[2],
    'tintForRole is consistent (same result on repeated calls)',
  );
}

// ── Test 5: ROLE_TINT entries are all distinct from each other ───────────────
{
  const t = ROLE_TINT as Record<string, [number, number, number]>;
  const roles = ['miner', 'lumberjack', 'forager', 'guard'];
  let allDistinct = true;
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      if (JSON.stringify(t[roles[i]]) === JSON.stringify(t[roles[j]])) {
        allDistinct = false;
        console.log(`  NOTE: ROLE_TINT['${roles[i]}'] === ROLE_TINT['${roles[j]}']`);
      }
    }
  }
  assert(allDistinct, 'ROLE_TINT entries for all non-none roles are distinct');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('PASS: p11-role-tint all assertions pass');
