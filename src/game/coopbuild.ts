/**
 * game/coopbuild.ts - Cooperative shelter build wiring (VS-3 T3, GDD 8/6.1/13).
 *
 * The glue between a group's shelter PROJECT (shelter.ts) and the global builder
 * machinery (buildqueue.ts + the builder loop in survivor.ts). It owns no build
 * AI of its own: it STREAMS a project's blueprint cells into the one global queue
 * a few at a time, and the existing builder role does the hauling/placing. The
 * builders DIVIDE the work for free - reachableBlueprint() claims the nearest
 * UNRESERVED cell, so two builders never target the same one (the BQ-3 reserve
 * mechanism IS the cooperative split).
 *
 * Three responsibilities (PLAN VS-3 / GDD 8):
 *   1. ENSURE + STREAM - each active group gets one project (ensureShelterProject)
 *      and at most MAX_BUILD_CLAIMS of its still-unbuilt cells live in the queue
 *      at once (GDD 13 cost discipline). Cells stream BOTTOM-UP (lowest y first):
 *      a builder can only reach a cell it can stand beside, so raising the lowest
 *      wall course first keeps the capped claim-pool full of cells that are
 *      actually reachable NOW; the pool tops back up as builders finish. (Roof and
 *      upper courses need a built wall to stand on - tall-hut build reachability
 *      is a known phase-level limit, see PROGRESS; T3 only owns the wiring.)
 *   2. CAMPFIRE ON ENCLOSE - once the shell is complete (every project cell is its
 *      target material), queue ONE campfire blueprint on the interior floor so a
 *      builder lights the hearth inside (VS-2). Not before: a campfire in a roof-
 *      less frame would warm nothing.
 *   3. ABANDON - clearGroupBuild() cancels a group's UNRESERVED queued cells (T4
 *      merge-consolidate / extinct group). Reserved cells are left for their
 *      builder to finish or release on death (survivor.ts), so nothing deadlocks.
 *
 * Pure over (groups, projects, grid, queue) - no DOM, no RNG. Module-level state
 * is only the projects map in shelter.ts plus the queue; this file adds none of
 * its own, mirroring building.ts (a stateless actuator over shared stores).
 */

import type { Survivor } from '../characters/survivor';
import type { ShelterProject } from './shelter';
import { ensureShelterProject, getShelterProject } from './shelter';
import { groupIds, groupMembers } from './groups';
import { STRUCTURES } from './building';
import { addBlueprint, blueprintAt, cancelBlueprintAt } from './buildqueue';
import { get } from '../engine/grid';
import { CAMPFIRE } from '../engine/materials';
import { MAX_BUILD_CLAIMS } from '../config';

/** True iff (x,y) already holds the structure material this cell builds toward. */
function cellBuilt(x: number, y: number, kind: 'wall' | 'fence' | 'campfire'): boolean {
  return get(x, y) === STRUCTURES[kind].material;
}

/**
 * Is the project's SHELL complete? True when every blueprint cell (roof + walls,
 * doorway already excluded) holds its target material. This is the enclose test
 * that gates the campfire and signals the hut is done.
 */
export function shellComplete(project: ShelterProject): boolean {
  for (const c of project.cells) {
    if (!cellBuilt(c.x, c.y, c.kind)) return false;
  }
  return true;
}

/**
 * How many of this project's shell cells are CURRENTLY in the build queue (a
 * proxy for live claims - the cap in streamProject keeps this <= MAX_BUILD_CLAIMS).
 */
export function queuedCellCount(project: ShelterProject): number {
  let n = 0;
  for (const c of project.cells) {
    if (blueprintAt(c.x, c.y) !== null) n++;
  }
  return n;
}

/**
 * Stream this project toward completion (one sync step):
 *   - shell still building -> top the queue up to MAX_BUILD_CLAIMS of this
 *     project's unbuilt, not-yet-queued cells, BOTTOM-UP (lowest course first) so
 *     the capped pool holds reachable cells.
 *   - shell complete -> queue the single campfire cell once (if not built/queued).
 * No-op once the hut is fully built and the hearth lit. Returns the project.
 */
export function streamProject(project: ShelterProject): ShelterProject {
  if (!shellComplete(project)) {
    // Lowest cells first (larger y = lower on screen = nearer the floor a builder
    // stands on). Stable secondary sort by x keeps the order deterministic.
    const order = project.cells
      .map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.y - a.c.y || a.c.x - b.c.x || a.i - b.i);
    let live = queuedCellCount(project);
    for (const { c } of order) {
      if (live >= MAX_BUILD_CLAIMS) break;
      if (cellBuilt(c.x, c.y, c.kind)) continue; // already raised
      if (blueprintAt(c.x, c.y) !== null) continue; // already queued
      if (addBlueprint(c.x, c.y, c.kind)) live++;
    }
    return project;
  }
  // Shell encloses -> light the hearth inside (VS-2 campfire), exactly once.
  const f = project.campfire;
  if (!cellBuilt(f.x, f.y, 'campfire') && blueprintAt(f.x, f.y) === null) {
    addBlueprint(f.x, f.y, 'campfire');
  }
  return project;
}

/**
 * Drive cooperative building for the whole colony (call from main on the group
 * recheck cadence - T5). For each active group: ensure its one shelter project,
 * then stream it toward completion. Groups with no live, plannable site are
 * skipped this pass (ensureShelterProject returns null - retried later).
 */
export function updateCoopBuild(survivors: Survivor[]): void {
  for (const g of groupIds()) {
    const members = groupMembers(g);
    const project = ensureShelterProject(g, members, survivors);
    if (project) streamProject(project);
  }
}

/**
 * Abandon a group's queued build (T4 merge-consolidate, or an extinct group).
 * Cancels every UNRESERVED project cell still in the queue (incl. the campfire);
 * RESERVED cells are left alone so their builder finishes or releases the claim
 * on death/reassignment (survivor.ts) - cancelling a reserved cell out from under
 * a walking builder is the deadlock T3 must avoid. Does NOT clear the project
 * record itself - callers use clearShelterProject (shelter.ts) for that.
 */
export function clearGroupBuild(groupId: number): void {
  const project = getShelterProject(groupId);
  if (!project) return;
  for (const c of project.cells) {
    const bp = blueprintAt(c.x, c.y);
    if (bp && !bp.reserved) cancelBlueprintAt(c.x, c.y);
  }
  const f = project.campfire;
  const fbp = blueprintAt(f.x, f.y);
  if (fbp && !fbp.reserved && get(f.x, f.y) !== CAMPFIRE) cancelBlueprintAt(f.x, f.y);
}
