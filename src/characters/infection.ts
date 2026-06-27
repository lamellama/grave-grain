/**
 * characters/infection.ts - Bite-infection progression & turning (revised death
 * model, GDD 5.1 outcome 3 / 7.2 "bite & turning").
 *
 * A zombie's BITE (combat.ts biteAttack, Task 3) marks a survivor's Body
 * `infected` and resets its `infectionTicks`. This module ticks that clock once
 * per sim tick and drives the SUBTLE CORE progression:
 *
 *   act  -> INFECTION_ACTING_TICKS -> prone/downed -> TURN_DELAY_TICKS -> REANIMATE
 *
 *   - act    : the survivor keeps acting (updateSurvivor still drives it) while
 *              the clock counts up.
 *   - prone  : at INFECTION_ACTING_TICKS the body drops to a downed state
 *              (`prone=true`); updateSurvivor no-ops its drive (no work/fight).
 *   - turn   : at TURN_DELAY_TICKS the EXISTING body reanimates as a zombie
 *              (reanimateAsZombie reuses the same rig - THE GATE stays intact),
 *              joins the live horde, and the survivor is marked `turned`. The
 *              body STAYS alive===true - the Zombie controller now drives it.
 *
 * COUNTERPLAY (GDD 5.1/7.2): an EXTREME hit (head / torso-disintegrate / fire
 * / burial -> dissolveBody, or a quiet death -> layDownCorpse) BEFORE the turn
 * timer kills the body for good. Those paths clear `infected` (damage.ts) and
 * flip `alive`/`corpse`, so the guard below skips the body and it never rises.
 *
 * DOM-free pure logic so it stays headless-testable.
 */

import type { Survivor } from './survivor';
import type { Zombie } from './zombie';
import { reanimateAsZombie } from './zombie';
import { INFECTION_ACTING_TICKS, TURN_DELAY_TICKS } from '../config';

/**
 * Advance every infected survivor's turn clock by one tick. Called once per tick
 * from main AFTER the survivor updates and BEFORE updateGameState, so a freshly
 * reanimated zombie is in `zombies` for this tick's render/prune/state pass.
 * Reanimated zombies are PUSHED onto the shared `zombies` array (same reference
 * the loop/renderer hold). The `tick` argument is accepted for call-site
 * symmetry with the other per-tick updaters; the clock lives on the body.
 */
export function updateInfection(
  survivors: Survivor[],
  zombies: Zombie[],
  _tick: number,
): void {
  for (const s of survivors) {
    const body = s.body;
    // Only living, infected, not-yet-turned, non-corpse bodies progress. A
    // dissolved (alive=false) or quiet-death (corpse) body is the counterplay
    // case - its infection was cleared and it never reaches here.
    if (!body.infected || !body.alive || body.corpse || s.turned) {
      continue;
    }

    body.infectionTicks++;

    // act -> prone: at INFECTION_ACTING_TICKS the survivor drops to downed.
    if (body.infectionTicks >= INFECTION_ACTING_TICKS && !body.prone) {
      body.prone = true; // GDD 7.2: downed - acts no more (updateSurvivor no-ops)
    }

    // prone -> turn: at TURN_DELAY_TICKS the body reanimates as a zombie that
    // REUSES the existing rig (controller swap), joining the live horde.
    if (body.infectionTicks >= TURN_DELAY_TICKS) {
      zombies.push(reanimateAsZombie(body));
      s.turned = true; // this survivor is now part of the horde
      body.infected = false; // infection consumed
      body.prone = false; // the zombie stands and walks (no prone crawl, MVP)
      // body.alive stays TRUE - the Zombie controller now drives the same body.
    }
  }
}
