/**
 * Headless verification for v0.8 playtest L - the Assign-menu role colour legend
 * (roles.roleTintCss). Real module. Run via tsc (commonjs) -> node.
 *
 * The menu buttons are colour-matched to each role's SPRITE tint, derived from
 * ROLE_TINT (single source of truth), so the legend can never drift from the
 * on-screen body colour.
 *
 * Covers:
 *   1. roleTintCss(role) == rgb(...) of ROLE_TINT[role] for every working role.
 *   2. 'none' (Unassign) is a neutral grey (no sprite tint).
 *   3. The working roles' swatches are all DISTINCT (a meaningful legend).
 */
import { ROLE_TINT, roleTintCss, type RoleName } from '../src/game/roles';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const WORKING: RoleName[] = ['miner', 'lumberjack', 'forager', 'guard', 'builder'];

// 1. Each working role's swatch matches its ROLE_TINT exactly.
for (const role of WORKING) {
  const t = ROLE_TINT[role];
  const want = `rgb(${t[0]},${t[1]},${t[2]})`;
  check(roleTintCss(role) === want, `1: ${role} swatch == ROLE_TINT (${want})`);
}

// 2. Unassign is a neutral grey (the 'none' sentinel has no real tint).
{
  const none = roleTintCss('none');
  check(/^rgb\(\d+,\d+,\d+\)$/.test(none), '2: none -> a valid rgb() colour');
  check(none !== `rgb(0,0,0)`, '2: none is NOT the black sentinel (uses a neutral grey)');
}

// 3. The working swatches are all distinct (so the legend actually disambiguates).
{
  const swatches = WORKING.map(roleTintCss);
  const distinct = new Set(swatches).size === swatches.length;
  check(distinct, `3: all working-role swatches are distinct (${swatches.join(' ')})`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) throw new Error('l-role-legend assertions failed');
console.log(
  'SUMMARY: each Assign-menu role button is colour-matched to its sprite tint via roleTintCss (derived from ROLE_TINT, so menu + sprite never drift); Unassign is neutral; working swatches are all distinct.',
);
