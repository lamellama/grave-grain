/**
 * p8-t1 — Player-placed STONE WALL material (GDD §8 / §7.4).
 *
 * Verifies (real modules, no mocks): placing WALL seeds WALL_INTEGRITY into the
 * integrity array (so breaching can chip it), while raw STONE stays at 0
 * integrity (never breachable). WALL is solid for bodies and not flammable, and
 * the material table grew by exactly one row with ids 0–13 unchanged.
 */
import { placeMaterial, getIntegrity } from '../src/engine/grid';
import {
  MATERIALS,
  WALL,
  STONE,
  WOOD,
  isSolidForBody,
  isFlammable,
} from '../src/engine/materials';
import { WALL_INTEGRITY, STONE_LOOSE } from '../src/config';

declare const process: any;

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    console.error('  FAIL:', msg);
    failed++;
  }
}

// WALL placement seeds integrity.
placeMaterial(5, 5, WALL);
assert(getIntegrity(5, 5) === WALL_INTEGRITY, `placeMaterial(WALL) integrity === WALL_INTEGRITY (${WALL_INTEGRITY})`);
assert(WALL_INTEGRITY === 200, 'WALL_INTEGRITY === 200');

// Raw STONE stays non-breachable: hasIntegrity is FALSE, so breaching and the
// breach-visual ignore its integrity slot entirely. Since playtest v0.11 R the
// slot is REUSED as the loose-block marker (the FIRE-lifetime pattern) -
// placeMaterial(STONE) is the player paint path and seeds STONE_LOOSE so a
// painted stone falls-and-stacks instead of hanging off lateral contact.
placeMaterial(6, 5, STONE);
assert(MATERIALS[STONE].hasIntegrity === false, 'STONE hasIntegrity === false (non-breachable)');
assert(getIntegrity(6, 5) === STONE_LOOSE, 'placeMaterial(STONE) seeds the LOOSE-block marker (v0.11 R)');

// WALL properties.
assert(isSolidForBody(WALL) === true, 'isSolidForBody(WALL) === true');
assert(isFlammable(WALL) === false, 'isFlammable(WALL) === false');

// Table shape / spot-checks of existing rows. Length grew past Phase 8's 15:
// VS-1 added SNOW (id 16) and VS-2 added CAMPFIRE (id 17) -> length 18; WALL
// stays id 14.
assert(MATERIALS.length === 19, 'MATERIALS.length === 19 (Phase 8 + SNOW + CAMPFIRE + v0.10 DOOR)');
assert(WALL === 14, 'WALL id === 14');
assert(MATERIALS[STONE].hasIntegrity === false, 'STONE.hasIntegrity === false (unchanged)');
assert(MATERIALS[WOOD].baseIntegrity === 60, 'WOOD.baseIntegrity === 60 (unchanged)');
assert(MATERIALS[WALL].name === 'wall', "MATERIALS[14].name === 'wall'");
assert(MATERIALS[WALL].color === '#8a93a0', 'WALL color is distinct blue-grey #8a93a0');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
