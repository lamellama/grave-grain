/**
 * resources.ts — Global colony stockpile (GDD §8)
 *
 * A pure data store: no sim logic, no hauling logistics, no per-tile piles.
 * MVP scope (GDD §14): { wood, stone, food, ore } only.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ResourceKind = 'wood' | 'stone' | 'food' | 'ore';

// ---------------------------------------------------------------------------
// Module-level stockpile (all start at 0)
// ---------------------------------------------------------------------------
const stockpile: { wood: number; stone: number; food: number; ore: number } = {
  wood: 0,
  stone: 0,
  food: 0,
  ore: 0,
};

/** Returns the live stockpile object (read-only intent; t5 reads it for the HUD). */
export function getStockpile(): { wood: number; stone: number; food: number; ore: number } {
  return stockpile;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Add n units of the given kind (n must be ≥ 0). */
export function addResource(kind: ResourceKind, n: number): void {
  stockpile[kind] += n;
}

/** True if every listed kind has ≥ its cost. */
export function canAfford(cost: Partial<Record<ResourceKind, number>>): boolean {
  for (const k of Object.keys(cost) as ResourceKind[]) {
    const required = cost[k] ?? 0;
    if (stockpile[k] < required) return false;
  }
  return true;
}

/**
 * ATOMIC spend: if canAfford(cost), deducts all and returns true.
 * If any kind falls short, deducts NOTHING and returns false.
 */
export function spend(cost: Partial<Record<ResourceKind, number>>): boolean {
  if (!canAfford(cost)) return false;
  for (const k of Object.keys(cost) as ResourceKind[]) {
    stockpile[k] -= cost[k] ?? 0;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deposit location (used for the "return to pile" leg — GDD §8)
// ---------------------------------------------------------------------------

/** The world-cell coordinate where survivors drop harvested resources. */
export const stockpilePoint = { x: 0, y: 0 };

/** Update the deposit spot (called from main once the survivor home is known). */
export function setStockpilePoint(x: number, y: number): void {
  stockpilePoint.x = x;
  stockpilePoint.y = y;
}

// ---------------------------------------------------------------------------
// Player ammo for the Shoot tool (playtest: limited bullets). Separate from the
// {wood,stone,food,ore} stockpile. main seeds it to STARTING_AMMO at startup.
// ---------------------------------------------------------------------------

let ammo = 0;

/** Current bullets remaining for the Shoot tool. */
export function getAmmo(): number {
  return ammo;
}

/** Set the ammo count (clamped ≥ 0). */
export function setAmmo(n: number): void {
  ammo = Math.max(0, Math.floor(n));
}

/** Add (or remove) ammo, clamped ≥ 0 (for later pickups/crafting). */
export function addAmmo(n: number): void {
  ammo = Math.max(0, ammo + n);
}

/** Consume one bullet; returns false (and spends nothing) if out of ammo. */
export function spendAmmo(): boolean {
  if (ammo <= 0) return false;
  ammo--;
  return true;
}

// ---------------------------------------------------------------------------
// Test / reset helper (not part of runtime behaviour)
// ---------------------------------------------------------------------------

/** Resets all stockpile quantities to 0 and the deposit point to (0,0). */
export function resetStockpile(): void {
  stockpile.wood = 0;
  stockpile.stone = 0;
  stockpile.food = 0;
  stockpile.ore = 0;
  stockpilePoint.x = 0;
  stockpilePoint.y = 0;
}
