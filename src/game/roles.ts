/**
 * game/roles.ts — Role definitions, wood-tier tools & tool-gated assignment
 * (GDD §6.2 roles, §6.3 tools/crafting/durability, §9 foliage harvest).
 *
 * Pure & DOM-free: this layer describes WHAT each role harvests and the gating
 * rules for assigning it; the per-survivor behaviour loop (find → path → work →
 * deposit) lives in the survivor controller (p6-t4). It reads the live grid for
 * target queries (mirroring survivor.ts' bounded ring-scan) and the global
 * stockpile for craft gating, so it stays headless-testable.
 *
 * MVP scope (GDD §6.2/§14): the four roles Miner / Lumberjack / Forager / Guard
 * at the WOOD tool tier only — no iron/stone tiers, no upgrade path, no
 * workstation. Diggers / Fisherman / Builder-Hauler are vertical-slice.
 *
 * Material distinction (GDD §9, §5.2): TREES and BUSHES in the world are FOLIAGE
 * (now permeable to bodies). A lumberjack CHOPS foliage → wood; a forager
 * GATHERS the same foliage → food — same material, different action/output/
 * timing. WOOD (id 6) is a placed STRUCTURE and is NEVER a harvest target. The
 * miner targets EXPOSED stone/ore (a rock cell with an AIR face) — you cannot
 * mine fully-buried rock.
 */

import type { ResourceKind } from './resources';
import { canAfford, spend, stockpilePoint } from './resources';
import { get } from '../engine/grid';
import { AIR, STONE, ORE, FOLIAGE } from '../engine/materials';
import { RESOURCE_SCAN_RADIUS, WOOD_TOOL_DURABILITY } from '../config';
import {
  CHOP_TICKS,
  MINE_TICKS,
  GATHER_TICKS,
  AXE_WOOD_COST,
  PICKAXE_WOOD_COST,
  WEAPON_WOOD_COST,
  BASKET_WOOD_COST,
} from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** MVP roles (GDD §6.2 subset); 'none' is the unassigned default. */
export type RoleName = 'none' | 'miner' | 'lumberjack' | 'forager' | 'guard';

/** Wood-tier tool kinds. Weapons are tools too (GDD §6.3). */
export type ToolKind = 'pickaxe' | 'axe' | 'basket' | 'weapon';

/** A held tool: a kind plus remaining durability (counts down to break). */
export interface Tool {
  kind: ToolKind;
  durability: number;
}

/**
 * Static role descriptor (GDD §6.2). `harvestMaterial`/`output` are null for the
 * miner (decided at harvest by the cell — STONE→stone, ORE→ore) and the guard
 * (no harvest). `craftCost` is what the colony spends to auto-craft the required
 * wood-tier tool.
 */
export interface RoleDef {
  requiredTool: ToolKind | null;
  output: ResourceKind | null;
  harvestMaterial: number | null;
  workTicks: number;
  craftCost: Partial<Record<ResourceKind, number>>;
}

// ---------------------------------------------------------------------------
// Tools (GDD §6.3 — durability, wood is brittle)
// ---------------------------------------------------------------------------

/** Fresh tool of the given kind at full wood-tier durability. */
export function makeTool(kind: ToolKind): Tool {
  return { kind, durability: WOOD_TOOL_DURABILITY };
}

/**
 * Spend one use of a tool. Decrements durability by 1 and returns true if this
 * use JUST broke it (durability reached ≤ 0) — the caller then discards it.
 */
export function useTool(tool: Tool): boolean {
  tool.durability -= 1;
  return tool.durability <= 0;
}

// ---------------------------------------------------------------------------
// Role table (GDD §6.2)
// ---------------------------------------------------------------------------

export const ROLES: Record<RoleName, RoleDef> = {
  none: {
    requiredTool: null,
    output: null,
    harvestMaterial: null,
    workTicks: 0,
    craftCost: {},
  },
  // Fells trees: walks THROUGH foliage and chops it to wood (GDD §9).
  lumberjack: {
    requiredTool: 'axe',
    output: 'wood',
    harvestMaterial: FOLIAGE,
    workTicks: CHOP_TICKS,
    craftCost: { wood: AXE_WOOD_COST },
  },
  // Gathers from bushes: same FOLIAGE material, but yields food (GDD §9).
  forager: {
    requiredTool: 'basket',
    output: 'food',
    harvestMaterial: FOLIAGE,
    workTicks: GATHER_TICKS,
    craftCost: { wood: BASKET_WOOD_COST },
  },
  // Mines EXPOSED stone/ore; output decided per-cell at harvest (mineOutput).
  miner: {
    requiredTool: 'pickaxe',
    output: null,
    harvestMaterial: null,
    workTicks: MINE_TICKS,
    craftCost: { wood: PICKAXE_WOOD_COST },
  },
  // Holds a point and fights (combat lands in Phase 7); no harvest.
  guard: {
    requiredTool: 'weapon',
    output: null,
    harvestMaterial: null,
    workTicks: 0,
    craftCost: { wood: WEAPON_WOOD_COST },
  },
};

// ---------------------------------------------------------------------------
// Target queries over the live grid (GDD §6.2 findTarget — mirrors the bounded
// ring-scan in survivor.ts; reads the world directly so targets track edits).
// ---------------------------------------------------------------------------

/**
 * Nearest cell of material `mat` within `maxR` (Chebyshev) of (cx, cy), or null.
 * Scans ring by ring outward (closest ring first) and returns the Euclidean-
 * closest hit in the FIRST ring that contains one — cheap, early-exiting probe.
 * Mirrors survivor.ts' nearestMaterial.
 */
function nearestMaterial(
  cx: number,
  cy: number,
  mat: number,
  maxR: number,
): { x: number; y: number } | null {
  for (let r = 1; r <= maxR; r++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // perimeter only
        const x = cx + dx;
        const y = cy + dy;
        if (get(x, y) === mat) {
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Is (x, y) an EXPOSED rock cell? True only for STONE/ORE with at least one
 * orthogonally-adjacent AIR neighbour (GDD §6.2 "find exposed stone/ore" — a
 * miner can't reach fully-buried rock). This adjacency test is the subtle part:
 * a buried block has solid neighbours on all four sides and is skipped.
 */
export function isExposedRock(x: number, y: number): boolean {
  const m = get(x, y);
  if (m !== STONE && m !== ORE) return false;
  return (
    get(x + 1, y) === AIR ||
    get(x - 1, y) === AIR ||
    get(x, y + 1) === AIR ||
    get(x, y - 1) === AIR
  );
}

/**
 * Nearest EXPOSED STONE/ORE cell within `maxR` (Chebyshev) of (cx, cy), or null.
 * Same ring-scan as nearestMaterial but the cell predicate is the exposed-rock
 * adjacency test (GDD §6.2).
 */
function nearestExposedRock(
  cx: number,
  cy: number,
  maxR: number,
): { x: number; y: number } | null {
  for (let r = 1; r <= maxR; r++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // perimeter only
        const x = cx + dx;
        const y = cy + dy;
        if (isExposedRock(x, y)) {
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Find the work target for a role from (fromX, fromY), or null if none in range:
 *   lumberjack/forager → nearest FOLIAGE (tree/bush) within RESOURCE_SCAN_RADIUS.
 *   miner             → nearest EXPOSED stone/ore (skips fully-buried rock).
 *   guard             → the stockpile hold point (MVP "hold a point", GDD §6.2).
 *   none              → null.
 */
export function findTarget(
  role: RoleName,
  fromX: number,
  fromY: number,
): { x: number; y: number } | null {
  switch (role) {
    case 'lumberjack':
    case 'forager':
      return nearestMaterial(fromX, fromY, FOLIAGE, RESOURCE_SCAN_RADIUS);
    case 'miner':
      return nearestExposedRock(fromX, fromY, RESOURCE_SCAN_RADIUS);
    case 'guard':
      return { x: stockpilePoint.x, y: stockpilePoint.y };
    case 'none':
    default:
      return null;
  }
}

/**
 * Output kind for a mined cell (GDD §6.2): STONE→'stone', ORE→'ore', else null.
 * Helper for the miner's harvest in p6-t4 (output is decided per-cell).
 */
export function mineOutput(cellMaterial: number): ResourceKind | null {
  if (cellMaterial === STONE) return 'stone';
  if (cellMaterial === ORE) return 'ore';
  return null;
}

// ---------------------------------------------------------------------------
// Tool-gated assignment (GDD §6.2 — assignable only if the required tool exists
// or can be auto-crafted from the stockpile).
// ---------------------------------------------------------------------------

/**
 * Can `role` be assigned given the tools the colony already owns? True if:
 *   - the role needs no tool (requiredTool === null), OR
 *   - the colony already owns that tool kind (in `ownedTools`), OR
 *   - the craft cost is affordable from the current stockpile.
 */
export function canAssign(role: RoleName, ownedTools: ToolKind[]): boolean {
  const def = ROLES[role];
  if (def.requiredTool === null) return true;
  if (ownedTools.includes(def.requiredTool)) return true;
  return canAfford(def.craftCost);
}

/**
 * Auto-craft the wood-tier tool a role requires, spending from the stockpile.
 * Returns null if the role needs no tool OR the spend fails (insufficient
 * stockpile). On success the stockpile is debited and a fresh tool is returned.
 */
export function craftToolFor(role: RoleName): Tool | null {
  const def = ROLES[role];
  if (def.requiredTool === null) return null;
  if (!spend(def.craftCost)) return null;
  return makeTool(def.requiredTool);
}
