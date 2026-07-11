/**
 * characters/infection.ts - Bite-infection progression & turning (revised death
 * model, GDD 5.1 outcome 3 / 7.2 "bite & turning").
 *
 * A zombie's BITE (combat.ts biteAttack, Task 3) marks a survivor's Body
 * `infected` and resets its `infectionTicks`. This module ticks that clock once
 * per sim tick and drives the DIE-FIRST progression (playtest fix: infected
 * survivors "should die first and come back to life as a zombie"):
 *
 *   act -> ACTING -> prone -> DEATH -> dead corpse -> TURN_DELAY -> REANIMATE
 *
 *   - act    : the survivor keeps acting (updateSurvivor still drives it) while
 *              the clock counts up.
 *   - prone  : at INFECTION_ACTING_TICKS the body drops to a downed/convulsing
 *              state (`prone=true`); updateSurvivor no-ops its drive.
 *   - die    : at INFECTION_DEATH_TICKS the survivor DIES - it lies down as a
 *              (twitching) corpse (alive=false, corpse=true) flagged
 *              `reanimating`, and stops counting as a living survivor. The rig is
 *              left INTACT (no cell release) so it can rise whole.
 *   - turn   : at TURN_DELAY_TICKS the dead corpse comes back to LIFE - the
 *              EXISTING body reanimates as a zombie (reanimateAsZombie reuses the
 *              same rig - THE GATE stays intact), rejoins the live horde
 *              (alive=true again), and the survivor is marked `turned`.
 *
 * COUNTERPLAY (GDD 5.1/7.2): an EXTREME hit (head / torso-disintegrate / fire
 * / burial -> dissolveBody) at ANY point before the turn - during the acting
 * phase OR on the twitching corpse - clears both `infected` and `reanimating`
 * and releases the rig's cells, killing the body for good so it never rises. A
 * quiet death (layDownCorpse) likewise clears `reanimating`.
 *
 * DOM-free pure logic so it stays headless-testable.
 */

import type { Survivor } from './survivor';
import type { Zombie } from './zombie';
import { reanimateAsZombie } from './zombie';
import {
  INFECTION_ACTING_TICKS,
  INFECTION_DEATH_TICKS,
  TURN_DELAY_TICKS,
  CORPSE_DECAY_TICKS,
} from '../config';

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
    if (s.turned) continue; // already part of the horde
    // A body progresses while it is EITHER a living infected survivor OR a dead
    // corpse still scheduled to reanimate. The counterplay case - an EXTREME hit
    // (head/torso/fire/burial -> dissolveBody) before the turn - clears BOTH
    // `infected` and `reanimating`, so a dissolved body drops out here and never
    // rises (GDD 5.1/7.2). A plain quiet death (layDownCorpse) likewise clears
    // `reanimating`, so a starved/frozen corpse never turns.
    const progressing = (body.infected && body.alive) || body.reanimating;
    if (!progressing) continue;

    body.infectionTicks++;

    // act -> prone: at INFECTION_ACTING_TICKS the living survivor drops to a
    // downed/convulsing state (still alive; updateSurvivor no-ops its drive).
    if (body.alive && !body.prone && body.infectionTicks >= INFECTION_ACTING_TICKS) {
      body.prone = true; // GDD 7.2: downed - acts no more
    }

    // prone -> DIE: at INFECTION_DEATH_TICKS the survivor DIES FIRST (playtest
    // fix). It lies down as a (twitching) corpse - alive=false, corpse=true -
    // flagged `reanimating` so this loop keeps ticking its clock. This is a real
    // death: it stops counting as a living survivor and the state watcher/toast
    // fire, but the rig is left intact (no cell release) so it can rise whole.
    if (body.alive && body.infectionTicks >= INFECTION_DEATH_TICKS) {
      body.alive = false;
      body.corpse = true;
      body.corpseTicks = CORPSE_DECAY_TICKS;
      body.prone = true; // lies down dead
      body.infected = false; // infection has run its course -> reanimation phase
      body.reanimating = true; // ...but this corpse WILL rise (unless dissolved)
      body.deathCause = 'bitten';
    }

    // dead corpse -> REANIMATE: at TURN_DELAY_TICKS the corpse claws back up as a
    // zombie that REUSES the existing rig (controller swap), rejoining the live
    // horde. It comes back to LIFE (alive=true again) - the Zombie controller now
    // drives the same body.
    if (body.reanimating && body.infectionTicks >= TURN_DELAY_TICKS) {
      body.alive = true; // back to life as one of the undead
      body.corpse = false; // no longer an inert corpse
      body.reanimating = false; // reanimation consumed
      body.prone = false; // the zombie stands and walks (no prone crawl, MVP)
      body.infected = false;
      zombies.push(reanimateAsZombie(body));
      s.turned = true; // this survivor is now part of the horde
    }
  }
}
