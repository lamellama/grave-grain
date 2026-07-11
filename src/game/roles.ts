/**
 * game/roles.ts - Role definitions, wood-tier tools & tool-gated assignment
 * (GDD 6.2 roles, 6.3 tools/crafting/durability, 9 foliage harvest).
 *
 * Pure & DOM-free: this layer describes WHAT each role harvests and the gating
 * rules for assigning it; the per-survivor behaviour loop (find -> path -> work ->
 * deposit) lives in the survivor controller (p6-t4). It reads the live grid for
 * target queries (mirroring survivor.ts' bounded ring-scan) and the global
 * stockpile for craft gating, so it stays headless-testable.
 *
 * MVP scope (GDD 6.2/14): the four roles Miner / Lumberjack / Forager / Guard
 * at the WOOD tool tier only - no iron/stone tiers, no upgrade path, no
 * workstation. Diggers / Fisherman / Builder-Hauler are vertical-slice.
 *
 * Material distinction (GDD 9, 5.2): TREES and BUSHES in the world are FOLIAGE
 * (now permeable to bodies). A lumberjack CHOPS foliage -> wood; a forager
 * GATHERS the same foliage -> food - same material, different action/output/
 * timing. WOOD (id 6) is a placed STRUCTURE and is NEVER a harvest target. The
 * miner targets EXPOSED stone/ore (a rock cell with an AIR face) - you cannot
 * mine fully-buried rock.
 */

import type { ResourceKind } from './resources';
import { canAfford, spend, stockpilePoint } from './resources';
import { get } from '../engine/grid';
import { AIR, STONE, ORE, FOLIAGE, WATER, DIRT, SAND, SNOW, ASH } from '../engine/materials';
import { RESOURCE_SCAN_RADIUS, WOOD_TOOL_DURABILITY, ROLE_TINT_MIX } from '../config';
import {
  CHOP_TICKS,
  MINE_TICKS,
  GATHER_TICKS,
  AXE_WOOD_COST,
  PICKAXE_WOOD_COST,
  WEAPON_WOOD_COST,
  BASKET_WOOD_COST,
  HAMMER_WOOD_COST,
  HAMMER_DURABILITY,
  BUILD_TICKS,
  BUILDER_TINT,
  IRON_TOOL_ORE_COST,
  IRON_TOOL_WOOD_COST,
  IRON_DURABILITY_MULT,
  SHOVEL_WOOD_COST,
  SHOVEL_DURABILITY,
  DIG_TICKS,
  ROD_WOOD_COST,
  FISH_TICKS,
  DIGGER_DOWN_TINT,
  DIGGER_UP_TINT,
  FISHERMAN_TINT,
} from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Roles (GDD 6.2); 'none' is the unassigned default. The two diggers and the
 * fisherman are the GDD 14 "Beyond" additions (item 4) on top of the MVP five.
 */
export type RoleName =
  | 'none'
  | 'miner'
  | 'lumberjack'
  | 'forager'
  | 'guard'
  | 'builder'
  | 'diggerDown'
  | 'diggerUp'
  | 'fisherman';

// ---------------------------------------------------------------------------
// Role tints (GDD 12 UX readability, task 11-5 - render-only)
// ---------------------------------------------------------------------------

/**
 * Per-role RGB tint colour. At draw time each body pixel is blended toward its
 * role's tint by ROLE_TINT_MIX so roles are visually distinct. 'none' carries a
 * sentinel (black) - tintForRole returns rgb UNCHANGED for 'none'.
 */
export const ROLE_TINT: Record<RoleName, [number, number, number]> = {
  none:       [  0,   0,   0], // sentinel - tintForRole returns rgb unchanged
  miner:      [110, 120, 135], // slate-grey
  lumberjack: [150,  90,  40], // brown / orange
  forager:    [ 60, 140,  60], // forest green
  guard:      [ 70, 110, 170], // steel-blue
  builder:    BUILDER_TINT,    // amber/tan (GDD 6.2 builder role)
  diggerDown: DIGGER_DOWN_TINT, // deep purple (GDD 6.2 down-diagonal digger)
  diggerUp:   DIGGER_UP_TINT,   // plum/magenta (GDD 6.2 up-diagonal digger)
  fisherman:  FISHERMAN_TINT,   // teal (GDD 6.2 fisherman)
};

// ---------------------------------------------------------------------------
// Role CLOTHING (round 11 "improve the colouring of the survivors by role") -
// render-only, per-pixel garments layered over the authored figure. Where a
// role has no garment for a pixel this returns null and the ordinary
// tint/authored colour shows through. Damage stays honest: clothing is a draw
// concern only - a shed pixel still enters the sim as FLESH/BONE in material
// colours (the clothes stay on the figure, not on the gore).
// ---------------------------------------------------------------------------

// Buffalo-plaid shirt for the lumberjack (alternating red/black check).
const PLAID_RED = '#a83226';
const PLAID_DARK = '#4a1410';
// Steel helmet for the guard.
const HELMET_STEEL = '#aeb6bf';
// Work gloves for the forager.
const GLOVE_TAN = '#d1a24a';

/**
 * The garment colour for one authored body pixel, or null when this role
 * leaves that pixel bare (fall through to tint/authored colours).
 *
 *   lumberjack - a CHECKERED SHIRT across the torso and both arm sleeves
 *                (local-parity checker, so the pattern is stable as it walks);
 *   guard      - a HELMET over the top of the head;
 *   forager    - GLOVES on both hands (the lowest arm pixels).
 *
 * Coordinates are the pixel's AUTHORED bone-local (dx, dy) - stable for the
 * body's whole life, so garments never swim over the figure. Pure and
 * per-pixel-safe (no allocation, no globals).
 */
export function clothingPixelColor(
  role: RoleName,
  bone: string,
  dx: number,
  dy: number,
): string | null {
  switch (role) {
    case 'lumberjack':
      if (bone === 'torso' || bone === 'lArm' || bone === 'rArm') {
        return ((dx + dy) & 1) === 0 ? PLAID_RED : PLAID_DARK;
      }
      return null;
    case 'guard':
      // Head rows run dy -1..1; the top two rows wear the steel.
      if (bone === 'head' && dy <= 0) return HELMET_STEEL;
      return null;
    case 'forager':
      // Arm pixels run dy -2..2; the bottom two rows are the gloved hands.
      if ((bone === 'lArm' || bone === 'rArm') && dy >= 1) return GLOVE_TAN;
      return null;
    default:
      return null;
  }
}

/**
 * Blend `rgb` toward the role's tint by ROLE_TINT_MIX (render-only helper).
 * 'none' returns `rgb` unchanged (no tint).
 * Pure - no side-effects, no globals mutated - so it is safe to call per-pixel.
 */
export function tintForRole(
  rgb: [number, number, number],
  role: RoleName,
): [number, number, number] {
  if (role === 'none') return rgb;
  const t = ROLE_TINT[role];
  const m = ROLE_TINT_MIX;
  return [
    Math.round(rgb[0] * (1 - m) + t[0] * m),
    Math.round(rgb[1] * (1 - m) + t[1] * m),
    Math.round(rgb[2] * (1 - m) + t[2] * m),
  ];
}

/**
 * CSS `rgb(...)` swatch colour for a role's sprite tint (v0.8 playtest L). Used
 * to colour-match the Assign-menu buttons to the on-screen body tint - derived
 * from ROLE_TINT so the menu and the sprite never drift. 'none' (Unassign) has
 * no tint, so it gets a neutral grey.
 */
export function roleTintCss(role: RoleName): string {
  if (role === 'none') return 'rgb(120,120,120)'; // neutral - Unassign
  const t = ROLE_TINT[role];
  return `rgb(${t[0]},${t[1]},${t[2]})`;
}

/** Tool kinds. Weapons are tools too (GDD 6.3). */
export type ToolKind = 'pickaxe' | 'axe' | 'basket' | 'weapon' | 'hammer' | 'shovel' | 'rod';

/** Tool quality tier (GDD 6.3): wood is cheap and brittle, iron durable/fast. */
export type ToolTier = 'wood' | 'iron';

/**
 * Kinds that HAVE an iron tier (GDD 6.2 table: shovel/pickaxe/axe are
 * "wood->iron", weapons and by extension the hammer are metal tools). The
 * basket and fishing rod stay wood-only - there is no iron basket.
 */
export const IRON_UPGRADABLE: readonly ToolKind[] = [
  'pickaxe',
  'axe',
  'shovel',
  'weapon',
  'hammer',
];

/** A held tool: kind + tier + remaining durability (counts down to break). */
export interface Tool {
  kind: ToolKind;
  tier: ToolTier;
  durability: number;
}

/**
 * Static role descriptor (GDD 6.2). `harvestMaterial`/`output` are null for the
 * miner (decided at harvest by the cell - STONE->stone, ORE->ore) and the guard
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
// Tools (GDD 6.3 - durability, wood is brittle)
// ---------------------------------------------------------------------------

/** Fresh tool of the given kind and tier at that tier's full durability. */
export function makeTool(kind: ToolKind, tier: ToolTier = 'wood'): Tool {
  // Hammer/shovel use their own higher wood-tier durability so a builder can
  // finish a wall line and a digger a full-length tunnel (one use per column).
  const base =
    kind === 'hammer' ? HAMMER_DURABILITY :
    kind === 'shovel' ? SHOVEL_DURABILITY :
    WOOD_TOOL_DURABILITY;
  // GDD 6.3: wood is brittle, iron durable - same kind, x-multiplied lifespan.
  const durability = tier === 'iron' ? base * IRON_DURABILITY_MULT : base;
  return { kind, tier, durability };
}

/** Stockpile cost of the IRON tier of a kind (flat across upgradable kinds). */
export function ironCostFor(): Partial<Record<ResourceKind, number>> {
  return { wood: IRON_TOOL_WOOD_COST, ore: IRON_TOOL_ORE_COST };
}

/**
 * Spend one use of a tool. Decrements durability by 1 and returns true if this
 * use JUST broke it (durability reached <= 0) - the caller then discards it.
 */
export function useTool(tool: Tool): boolean {
  tool.durability -= 1;
  return tool.durability <= 0;
}

// ---------------------------------------------------------------------------
// Role table (GDD 6.2)
// ---------------------------------------------------------------------------

export const ROLES: Record<RoleName, RoleDef> = {
  // BQ-3 will add the driving behaviour loop for builder; role data is here.
  builder: {
    requiredTool: 'hammer',
    output: null,
    harvestMaterial: null,
    workTicks: BUILD_TICKS,
    craftCost: { wood: HAMMER_WOOD_COST },
  },
  none: {
    requiredTool: null,
    output: null,
    harvestMaterial: null,
    workTicks: 0,
    craftCost: {},
  },
  // Fells trees: walks THROUGH foliage and chops it to wood (GDD 9). The axe
  // is FREE (AXE_WOOD_COST=0) so a colony at 0 wood can always bootstrap its
  // wood economy through this role (playtest v0.9 P).
  lumberjack: {
    requiredTool: 'axe',
    output: 'wood',
    harvestMaterial: FOLIAGE,
    workTicks: CHOP_TICKS,
    craftCost: { wood: AXE_WOOD_COST },
  },
  // Gathers from bushes: same FOLIAGE material, but yields food (GDD 9).
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
  // Tunnels diagonally DOWN a set distance or until hitting rock (GDD 6.2):
  // output is ACCESS (depth, exposed ore), not a stockpile resource. The dig
  // loop is self-driven (driveDigger in survivor.ts), so no harvestMaterial.
  diggerDown: {
    requiredTool: 'shovel',
    output: null,
    harvestMaterial: null,
    workTicks: DIG_TICKS,
    craftCost: { wood: SHOVEL_WOOD_COST },
  },
  // Tunnels diagonally UP - ramps and escape routes (GDD 6.2).
  diggerUp: {
    requiredTool: 'shovel',
    output: null,
    harvestMaterial: null,
    workTicks: DIG_TICKS,
    craftCost: { wood: SHOVEL_WOOD_COST },
  },
  // Fishes AT water (GDD 6.2): stands on the bank and pulls food from the
  // WATER cell WITHOUT consuming it - renewable food, paid for in FISH_TICKS.
  fisherman: {
    requiredTool: 'rod',
    output: 'food',
    harvestMaterial: WATER,
    workTicks: FISH_TICKS,
    craftCost: { wood: ROD_WOOD_COST },
  },
};

// ---------------------------------------------------------------------------
// Target queries over the live grid (GDD 6.2 findTarget - mirrors the bounded
// ring-scan in survivor.ts; reads the world directly so targets track edits).
// ---------------------------------------------------------------------------

/**
 * Nearest cell of material `mat` within `maxR` (Chebyshev) of (cx, cy), or null.
 * Scans ring by ring outward (closest ring first) and returns the Euclidean-
 * closest hit in the FIRST ring that contains one - cheap, early-exiting probe.
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
 * Can a shovel remove this material (GDD 6.2 diggers)? Soils and powders only:
 * DIRT/SAND/SNOW/ASH. STONE and ORE stop a dig ("tunnels until hitting
 * ore/stone" - the face is left EXPOSED for a miner); structures (WOOD/WALL/
 * DOOR) also stop it, so a digger can never shovel through the colony's own
 * defenses. Fluids and permeables neither dig nor block - water pouring into a
 * fresh tunnel is the GDD 6.2 intended emergent risk.
 */
export function isDiggable(m: number): boolean {
  return m === DIRT || m === SAND || m === SNOW || m === ASH;
}

/**
 * Is (x, y) an EXPOSED rock cell? True only for STONE/ORE with at least one
 * orthogonally-adjacent AIR neighbour (GDD 6.2 "find exposed stone/ore" - a
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
 * adjacency test (GDD 6.2).
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
 *   lumberjack/forager -> nearest FOLIAGE (tree/bush) within RESOURCE_SCAN_RADIUS.
 *   miner             -> nearest EXPOSED stone/ore (skips fully-buried rock).
 *   fisherman         -> nearest WATER cell (the bank stand is survivor.ts' job).
 *   guard             -> the stockpile hold point (MVP "hold a point", GDD 6.2).
 *   builder           -> null (target acquisition is queue-driven - BQ-3 in survivor.ts).
 *   diggerDown/Up     -> null (the dig face is self-propelled - driveDigger).
 *   none              -> null.
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
    case 'fisherman':
      return nearestMaterial(fromX, fromY, WATER, RESOURCE_SCAN_RADIUS);
    case 'guard':
      return { x: stockpilePoint.x, y: stockpilePoint.y };
    case 'builder':
      // Builder targets are pulled from the blueprint queue (BQ-3), not
      // grid-scanned here. Return null; survivor.ts drives the pick.
      return null;
    case 'diggerDown':
    case 'diggerUp':
      // Diggers carve their own advancing face from the body's position
      // (driveDigger in survivor.ts) - there is no scanned target.
      return null;
    case 'none':
    default:
      return null;
  }
}

/**
 * Output kind for a mined cell (GDD 6.2): STONE->'stone', ORE->'ore', else null.
 * Helper for the miner's harvest in p6-t4 (output is decided per-cell).
 */
export function mineOutput(cellMaterial: number): ResourceKind | null {
  if (cellMaterial === STONE) return 'stone';
  if (cellMaterial === ORE) return 'ore';
  return null;
}

// ---------------------------------------------------------------------------
// Tool-gated assignment (GDD 6.2 - assignable only if the required tool exists
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
 * Auto-craft the WOOD-tier tool a role requires, spending from the stockpile.
 * Returns null if the role needs no tool OR the spend fails (insufficient
 * stockpile). On success the stockpile is debited and a fresh tool is returned.
 * Fresh crafts are ALWAYS wood (cheap, predictable - the free-axe bootstrap
 * stays free); the IRON tier is bought only by the player's explicit
 * re-assign upgrade in assignRole (GDD 6.2 "roles can be upgraded"), so
 * scarce ore is never spent silently.
 */
export function craftToolFor(role: RoleName): Tool | null {
  const def = ROLES[role];
  if (def.requiredTool === null) return null;
  if (!spend(def.craftCost)) return null;
  return makeTool(def.requiredTool);
}
