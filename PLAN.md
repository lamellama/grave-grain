# GRAVEGRAIN — MVP Build Plan (PLAN.md)

A phased, vibe-codeable plan for the MVP defined in `GraveGrain_GDD.md`. Each phase ends in something **runnable and testable**, names the **GDD sections it implements**, and carries enough detail to build from without flipping back and forth.

> Pair this with the GDD. Where a phase says *“Implements: §x”*, open that section — the GDD is the source of truth for behaviour; this file is the source of truth for build order and structure.

---

## Ground rules (read once)

- **One phase = one focused session (or two).** Don't start a phase until the previous one's *Done when* passes.
- **Commit between phases.** Each phase is a clean checkpoint to roll back to.
- **THE GATE:** Phases 0–4 build and prove the core illusion (a pixel character that reads as cellular automata and sheds real cells when hit — GDD §5.1, §14 Milestone 0). **Do not build the actual game (Phase 5+) until Phase 4's illusion holds and runs smoothly.** If it doesn't, the architecture changes here, cheaply, before anything depends on it.
- **Keep it data-oriented.** Cells live in flat typed arrays, not objects (GDD §13). This is the whole performance story.
- **Tune via constants.** Put every magic number (gravity, fire spread, hunger rate, wave size) in one `config.ts` so balancing is a one-file job.
- **Mobile is a target, not an afterthought.** Build input **pointer-first** (one code path for mouse + touch) and the **camera from the start** (the world is wider than the screen — GDD §12.1). Test on a real mid-range phone early — the weakest device sets the performance budget (GDD §12.4, §13).

---

## Stack (assumed — swap if you prefer)

- **TypeScript + Vite** — instant hot reload, zero ceremony.
- **Canvas2D** with **`ImageData` / `putImageData`** for the cell layer (write material colours straight into a `Uint8ClampedArray` — the standard fast falling-sand render), with characters drawn on top. **Render only the visible window**, not the whole world.
- **Pointer Events API** for input — one unified path for mouse, touch and pen. Responsive canvas sized to the device (honour `devicePixelRatio`) while keeping cells chunky.
- No engine, no framework for the MVP. (If sprite batching gets heavy later, Pixi.js is a drop-in for the render layer.)

### Suggested file layout (let it grow into this)

```
/src
  main.ts             // bootstrap + fixed-timestep game loop
  config.ts           // ALL tunable constants (incl. WORLD_W in screens)
  input.ts            // pointer-first input (mouse + touch), gestures, tool modes
  camera.ts           // horizontal (+ optional vertical) scroll, zoom, screen↔world
  engine/
    grid.ts           // typed-array cell storage, get/set, chunks/dirty-rects
    materials.ts      // material ids + property table (density, flammable, integrity…)
    simulation.ts     // the falling-sand update (bottom-up, active chunks only)
    reactions.ts      // material interactions (water+fire→steam, etc.)
  render/
    renderer.ts       // visible-window ImageData cell layer + character layer + HUD
  characters/
    body.ts           // hybrid body: skeleton rig + pixel map (GDD §5.1)
    locomotion.ts     // walk / fall / climb over terrain
    damage.ts         // damage→cells handoff (the trick) (GDD §5.1, §7.2)
    survivor.ts       // needs, role execution (GDD §6)
    zombie.ts         // AI, herd, attack (GDD §7)
  game/
    worldgen.ts       // procedural map (GDD §5.3)
    resources.ts      // stockpile (GDD §8)
    roles.ts          // role definitions + tool gating (GDD §6.2, §6.3)
    waves.ts          // zombie wave spawner (GDD §7.1)
    state.ts          // win/lose, global game state (GDD §11)
    ui.ts             // HUD, role-assign UI, minimap, speed controls (GDD §12.2)
```

### Core data model (the shapes everything hangs off)

- **Material grid:** `Uint8Array(WORLD_W*WORLD_H)` of material ids. `idx = y*WORLD_W + x`.
- **Integrity grid:** `Uint8Array` (or `Uint16`) parallel array, only meaningful for structure materials — drives breaching (GDD §7.4, §8).
- **Material table** (`materials.ts`): per id `{ name, color, density, isFluid, flammable, permeableToBodies, hasIntegrity, baseIntegrity }`. Density drives who-displaces-who; `permeableToBodies` is true only for foliage (GDD §5.2).
- **Body** (`body.ts`): `{ x, y, rig: Bone[], alive }`. A **Bone** = `{ name: 'head'|'torso'|'lArm'|'rArm'|'lLeg'|'rLeg', offset, pixels: {dx,dy,material}[], destroyed }`. Pixels are authored at **world-cell resolution** so released pixels are indistinguishable from sim cells (GDD §5.1, §14).
- **Survivor** extends Body: `{ needs:{hunger,thirst}, role, path, carrying }` (GDD §6.1).
- **Zombie** extends Body: `{ state:'idle'|'attack', target, senseRadius }` (GDD §7.1).

---

## Phase → GDD map (quick index)

| Phase | Builds | Primary GDD refs |
|---|---|---|
| 0 | Scaffold, loop, camera, pan | §12.1, §12.3, §12.4, §13, §5.3 |
| 1 | Falling-sand core (sand/water/stone) | §5.1, §5.2, §8, §12.3 |
| 2 | Materials, fire, interactions, integrity | §5.2, §7.3, §8 |
| 3 | Hybrid body locomotion **(GATE)** | §5.1, §6.1, §14 (Milestone 0) |
| 4 | Damage→cells handoff **(GATE)** | §5.1, §7.2, §14, App. B |
| 5 | Survivors: needs + autonomy + pathing | §6.1, §13 |
| 6 | Roles, resources, wood-tier tools | §6.2, §6.3, §8, §9 |
| 7 | Zombies, combat, breaching | §7.1, §7.2, §7.3, §7.4 |
| 8 | Player building + fire-as-tool | §8, §7.3, §7.4 |
| 9 | Worldgen, waves, win/lose, UI | §5.3, §11, §12.1, §12.2 |
| 10 | Mobile & touch polish | §12.3, §12.4, §13 |
| 11 | Performance & feel pass | §13, App. B |

---

## Phase 0 — Scaffold, render loop & camera
**Implements (GDD):** §12.1 camera, §12.3–12.4 input/mobile, §5.3 wide world, §13 perf.
**Goal:** a window that draws a **world wider than the screen**, scrolls horizontally, and runs at a stable framerate.

**Build:**
- Vite + TS project; responsive full-screen canvas (honour `devicePixelRatio`); `config.ts` with `CELL_SIZE`, `WORLD_W` (e.g. 3–5 screens wide), `WORLD_H`, `SIM_HZ`.
- **Fixed-timestep** loop (e.g. 60 Hz sim) decoupled from render; accumulator pattern; pause + step-one-frame keys.
- `grid.ts`: material grid as `Uint8Array(WORLD_W*WORLD_H)`; `idx(x,y)`, `get`, `set`, `inBounds`. Add the parallel **integrity** array now (unused until Phase 2).
- `camera.ts`: horizontal scroll offset clamped to world bounds; `screenToWorld(px,py)` / `worldToScreen(x,y)`. Leave a vertical-scroll field even if pinned to 0 (GDD §15 open sub-question).
- `renderer.ts`: render **only the visible column range** of cells into an `ImageData` sized to the viewport, `putImageData`. FPS counter.
- `input.ts`: **pointer-first** drag to pan the camera (mouse *and* touch from day one).

**Config seeds:** `CELL_SIZE`, `WORLD_W`, `WORLD_H`, `SIM_HZ`, `PAN_SPEED`.

**Done when:** a world several screens wide renders at steady FPS, and you can **drag to scroll** horizontally on both desktop and a phone, with pause/step working.

> Doing the camera now (not later) means every subsequent phase is built in world coordinates — no painful retrofit.

---

## Phase 1 — Falling-sand core
**Implements (GDD):** §5.1 (physics-toy pillar), §5.2 (Air/Sand/Stone/Water rows), §8 (direct placement), §12.3 (tool modes).
**Goal:** the toy. Sand piles, water flows, stone holds.

**Build:**
- `materials.ts`: define `AIR(0)`, `SAND`, `STONE`, `WATER` with the property table from Core data model. Sand/water have `density`; stone is `static`.
- `simulation.ts`: **bottom-up** scan each tick (GDD App. B — bottom-up is mandatory or only the lowest row moves).
  - **Sand:** if cell below is empty/lighter → fall; else try down-left / down-right (random order) → gives the angle of repose (GDD §5.2).
  - **Water:** same falling, plus when blocked below, spread sideways to seek level; never piles.
  - **Density rule:** a heavier grain swaps with a lighter one below it (lets water sit under sand, air rise, etc. — the multi-density trick).
  - **Scan-direction flip** per row each frame to kill left/right bias.
- `input.ts` + tool modes: convert **screen→world** via camera; a material palette; erase. **Pan-vs-act fix (GDD §12.3):** a "Pan" mode (drag scrolls) vs. a "Paint" mode (drag places). Selecting a tool sets what a drag does. Pick one scheme (mode toggle, *or* one-finger paint / two-finger pan) and keep it.

**Config seeds:** `GRAVITY_STEPS`, `BRUSH_RADIUS`, per-material `density`.

**Done when:** switch to Paint → drop sand and watch it pile; paint water and watch it find its level; stone holds them up; switch to Pan → scroll the world — all by touch on a phone *and* mouse on desktop.

> Vibe note: don't optimise yet. Get it *correct and fun* first; chunking + active-region sim come in Phase 11.

---

## Phase 2 — Materials, fire & interactions
**Implements (GDD):** §5.2 (full material set + interactions table + permeability), §7.3 (fire vulnerability), §8 (ignite verb).
**Goal:** the world chemistry the game leans on.

**Build:**
- Add materials (GDD §5.2 table): `DIRT` (piles steeper than sand, grows plants later), `ORE` (static, in stone), `WOOD` (flammable, **hasIntegrity**), `FOLIAGE` (flammable, spreads, **permeableToBodies = true**, hasIntegrity), `FIRE`, `SMOKE`/`STEAM` (gas, rises, dissipates), `ASH` (falls light, inert).
- **Integrity** wired up: structure materials seed `baseIntegrity`; this array gets chipped in Phase 7 (§7.4).
- **Fire** (`simulation.ts`): each fire cell has a short life; spreads to flammable neighbours by chance; rises; consumes fuel → emits `SMOKE`, leaves `ASH` (GDD §5.2, §7.3).
- `reactions.ts`: a small rule table keyed on adjacency —
  - water + fire → steam + extinguish;
  - fire + (wood|foliage|flesh) → spread + ash;
  - undermined sand/dirt → collapse;
  - (optional) water + dirt → mud / faster growth.

**Config seeds:** `FIRE_LIFETIME`, `FIRE_SPREAD_CHANCE`, `SMOKE_DISSIPATE`, per-material `baseIntegrity`, `flammable`.

**Done when:** ignite a patch of wood/foliage → fire spreads and burns down to ash; dump water on it → it goes out, making steam.

---

## Phase 3 — Hybrid character: locomotion  *(START OF THE GATE)*
**Implements (GDD):** §5.1 (hybrid model), §6.1 (body = integrity, not a bar), §14 Milestone 0.
**Goal:** one chunky pixel body that moves reliably over the destructible terrain. No AI, no damage yet.

**Build:**
- `body.ts`: a single Body with a **simple skeleton rig** (head, torso, 2 arms, 2 legs) and a **pixel map per bone**, authored at **world-cell resolution** (the resolution match is what later sells the CA illusion — GDD §5.1, §14).
- `locomotion.ts` (ordinary rigged-character motion — the *cheap, reliable* kind the GDD deliberately chose over soft-body):
  - **Ground probe:** sample the cell(s) under the feet against the grid; if solid → grounded, else apply gravity and fall.
  - **Walk:** move x at `WALK_SPEED`; before stepping, check the cell ahead — if it's a 1-cell rise and within `STEP_UP_MAX`, step up the slope; if a wall taller than that, stop (GDD §7.1 "climb gentle slopes").
  - **Foliage is passable** later (Phase 6) — for now collide with all solids.
- Drive it with arrow keys *or* a script that paces it back and forth.
- `renderer.ts`: draw the body's bone pixels over the cell layer, at cell resolution, camera-transformed.

**Config seeds:** `WALK_SPEED`, `STEP_UP_MAX`, `BODY_GRAVITY`.

**Done when:** the figure walks across uneven sand/stone, falls into a dug pit, steps up gentle slopes, and never tunnels through solid ground. It should already *look* like it belongs in the cellular world.

> This is the locomotion that the GDD keeps rigged-and-cheap on purpose — if it feels solid here, the project's hardest risk (GDD §13) is behind you.

---

## Phase 4 — Damage → cells handoff  *(THE GATE — make-or-break)*
**Implements (GDD):** §5.1 (hybrid damage), §7.2 (emergent damage model), §14 (Milestone 0 success test), App. B (Vagabond death-collapse).
**Goal:** prove the core illusion. Hits turn body regions into real simulated cells.

**Build:**
- Add body materials (GDD §5.2): `FLESH` (flammable, bleeds), `BONE` (rigid, harder to destroy), `BLOOD` (thin fluid).
- `damage.ts` — on a hit to a body region:
  1. **Release pixels:** enumerate the hit bone's `pixels` and write them into the **grid** as FLESH/BONE/BLOOD cells at their world positions → they immediately fall, pile, bleed and can burn (handled by the existing sim).
  2. **Update the rig:** mark that bone `destroyed`.
  3. **Recompute capability** (the emergent effect — GDD §7.2):
     - **Leg destroyed** → disable that leg → locomotion drops to **crawl** (slower, lower stance).
     - **Head destroyed / lethal** → `alive=false` → **dissolve the whole body into falling cells** (the Vagabond collapse, App. B).
     - **Arm destroyed** → lose that side's reach (matters in Phase 7 combat).
     - **Torso** → bleed/weaken; past a threshold → full disintegration.
- **Fire on body:** when a FLESH pixel ignites, convert it to fire-fuel like any other flammable (GDD §7.3) — burning bodies just work.
- **Buried/submerged:** body reads the grid — sand above head = pinned; head underwater too long = drown → death path (GDD §5.2, §6.1).
- Temporary input: tap/click a body region to "shoot" it.

**Config seeds:** `BLOOD_PER_HIT`, `TORSO_DISINTEGRATE_THRESHOLD`, `CRAWL_SPEED`, `DROWN_TICKS`.

**Done when (the gate test — GDD §14):**
1. Shoot a leg → pixels spray and fall, the figure crawls.
2. Headshot → it collapses into an indistinguishable pile of cells.
3. Set it alight → it burns like the rest of the world.
4. Bury/submerge it → it reacts and can die.
5. **A bystander can't tell the body wasn't "real" CA, and FPS holds.**

> ✅ **If this passes, the architecture is proven — proceed.** ❌ If the handoff looks seamy or tanks FPS, fix it now (lower body resolution, release smaller regions, cap simultaneous dissolves — GDD §13) before Phase 5.

---

## Phase 5 — Survivors: needs & autonomy
**Implements (GDD):** §6.1 (needs table + auto-override), §13 (pathfinding on mutable terrain).
**Goal:** several living survivors that fend for themselves.

**Build:**
- `survivor.ts`: spawn several hybrid bodies that idle/wander near a start point.
- **Needs (MVP = Hunger + Thirst only; Warmth is vertical-slice per §14):** floats that deplete each tick; depletion faster with exertion/heat (GDD §6.1).
- **Auto-override (GDD §6.1):** crossing a need threshold drops the current behaviour to self-preserve — go to the nearest **water cell** to drink / **food source** to eat; flee fire; dig out of burial. Hitting zero → death via the Phase 4 path.
- **Pathfinding (GDD §13):** coarse navgrid sampled from terrain walkability (walkable = standable surface with headroom); greedy/A* route on the coarse grid + **local steering** via the Phase 3 locomotion; **invalidate paths only on local terrain edits near the path**, not globally.

**Config seeds:** `HUNGER_RATE`, `THIRST_RATE`, `HUNGER_THRESHOLD`, `THIRST_THRESHOLD`, `WANDER_RADIUS`, `NAV_CELL` (coarse-grid size).

**Done when:** survivors wander, go drink when thirsty / eat when hungry, and die of starvation/thirst if there's no food/water — all without you touching them.

---

## Phase 6 — Roles, resources & tools
**Implements (GDD):** §6.2 (roles — **MVP subset only**), §6.3 (tools, wood tier, durability), §8 (stockpile), §9 (foliage permeability).
**Goal:** the Lemmings layer — assign jobs, gather, craft.

**Build:**
- `resources.ts`: a stockpile `{ wood, stone, food, ore }` (GDD §8).
- `roles.ts` — **MVP roles: Miner, Lumberjack, Forager, Guard** (Diggers / Fisherman / Builder-Hauler are vertical-slice, GDD §14). Each role def = `{ requiredTool, findTarget(), work(), output }`:
  - **Lumberjack** → axe → find nearest tree → walk to it → chop (timed) → `wood`.
  - **Miner** → pickaxe → find exposed stone/ore → mine → `stone`/`ore`.
  - **Forager** → none/basket → find bush → gather → `food`.
  - **Guard** → any weapon → patrol/hold a point (combat lands in Phase 7).
- **Tool gating (GDD §6.2–6.3):** a role is assignable only if the required **wood-tier** tool exists or can be auto-crafted from stockpile. Tools have **durability** and break with use (wood is brittle).
- **Role behaviour loop:** find target → path (Phase 5) → work (consumes durability) → deposit to stockpile → repeat.
- **Wire foliage permeability (GDD §9, §5.2):** bodies now ignore `FOLIAGE` for collision — characters walk *through* trees; chopping is a separate harvest action.
- Assignment UI: tap a survivor → role menu, greyed out where no tool (full UI polish in Phase 9).

**Config seeds:** `CHOP_TICKS`, `MINE_TICKS`, `GATHER_TICKS`, `WOOD_TOOL_DURABILITY`, craft costs.

**Done when:** assign a lumberjack → he walks *through* trees to one, chops it for wood, returns it to the pile, and his axe eventually breaks.

---

## Phase 7 — Zombies & combat
**Implements (GDD):** §7.1 (spawn — **one edge for MVP**, meander, detect→attack faster), §7.2 (damage reuse), §7.3 (fire vuln), §7.4 (breaching).
**Goal:** the threat, with the emergent damage model paying off.

**Build:**
- `zombie.ts`: spawn from **one** map edge (dual-edge + herd biasing are vertical-slice, GDD §14).
  - **Idle:** meander slowly/randomly.
  - **Detect:** survivor within `senseRadius` → **attack** state → move toward target at the **slightly faster** attack speed (GDD §7.1).
- **Combat reuses Phase 4 damage** for *both* sides (GDD §7.2): a guard's hit releases the targeted zombie region's cells (aim low → leg → crawl; head → kill); a zombie's hit wounds the survivor the same way (real limb loss both ways).
- **Structure breaching (GDD §7.4):** a zombie blocked by a structure cell chips its **integrity** by a per-tick chance; integrity 0 → cell destroyed → push in. **Pressure scales with attacker count** on the same cell. Wood = low integrity (and burnable); stone = high.
- **Fire vulnerability (GDD §7.3):** flesh ignites and spreads body-to-body — already free from Phase 2/4.

**Config seeds:** `SENSE_RADIUS`, `ZOMBIE_IDLE_SPEED`, `ZOMBIE_ATTACK_SPEED`, `BREACH_CHANCE`, `ATTACK_DAMAGE`.

**Done when:** zombies wander in, lock onto a survivor, a guard can **leg the front rank** to slow them / **headshot** to kill, and a small mob **claws through a wooden fence**.

---

## Phase 8 — Player building & fire-as-tool
**Implements (GDD):** §8 (direct placement, structures, traps), §7.3/§7.4 (fire & breaching), §6.2 (stockpile-limited).
**Goal:** the falling-sand direct-control verbs in service of defense.

**Build:**
- **Place from stockpile only** (resolves GDD §15 open-Q4 toward scarcity): the place tool draws from gathered materials and decrements the stockpile.
- **Structures** with integrity (GDD §8): **Fence (wood)** = cheap, low integrity, flammable, funnels; **Wall (stone)** = high integrity, the real barrier.
- **Ignite tool** (GDD §8): set flammables alight.
- **Emergent traps:** dug pits, water moats, oil-and-spark fire, kill-zone behind a deliberately weak wall segment.

**Config seeds:** `FENCE_INTEGRITY`, `WALL_INTEGRITY`, place costs.

**Done when:** wall off a chokepoint, then bait a herd into a fire trap and watch it spread body-to-body (catching your own fence if you're careless).

---

## Phase 9 — Game loop, waves, world & UI
**Implements (GDD):** §5.3 (worldgen), §11 (win/loss), §12.1 (off-screen awareness/minimap), §12.2 (core UI).
**Goal:** a complete playable run, start to finish, across the wide map.

**Build:**
- `worldgen.ts` (GDD §5.3): seeded, **several screens wide** — surface soil/grass → dirt → sand pockets → stone with **ore veins**, an underground **water table**, woodland clusters, and a zombie edge. Spawn-zone guarantees (wood + water within reach; start away from the edge).
- `waves.ts` (GDD §7.1, §11): escalating wave size/frequency.
- `state.ts` (GDD §11): **win = survive N waves; lose = all survivors dead.**
- `ui.ts` (GDD §12.2): needs bars over survivors, stockpile readout, role-assign UI, **pause + speed controls**, clear **death-cause** message on every death.
- **Off-screen awareness (matters because the world scrolls — GDD §12.1):** edge arrows for incoming herds, alerts when a survivor is dying off-screen, and a **minimap/strip** to jump the camera.

**Config seeds:** `WAVE_INTERVAL`, `WAVE_SIZE_CURVE`, `WIN_WAVES`, worldgen knobs (ore density, water-table height, woodland coverage, map width).

**Done when:** launch a fresh seed, play the full loop across the whole wide map, win or lose with the result clearly communicated — and you always know where the threat is even off-screen.

---

## Phase 10 — Mobile & touch polish
**Implements (GDD):** §12.3 (input), §12.4 (mobile considerations), §13 (mobile perf).
**Goal:** genuinely good to play on a phone, not just functional. (Input/camera have been pointer-first since Phase 0 — this finishes the job.)

**Build:**
- **Landscape-first:** detect portrait → prompt to rotate; HUD laid out for landscape.
- **Touch-sized UI:** thumb-reachable toolbar (Pan / Place / Ignite / Assign), big hit targets, no hover dependence. Selecting one survivor in a crowd = forgiving tap area + **tap-to-cycle**.
- **Gestures:** pinch-to-zoom (overview ↔ precise placement); confirm the pan-vs-act scheme feels right under thumb; long-press = context/role menu.
- **Responsive render:** canvas sized to device + `devicePixelRatio`; cells kept chunky so the sim grid stays small.
- **Mobile perf budget (GDD §13):** profile on a real mid-range phone; cap concurrent zombies and gore debris to hold framerate there.

**Done when:** a full run is comfortably playable on a mid-range phone in landscape — pan, zoom, place, assign and fight all feel right by thumb, at a steady framerate.

---

## Phase 11 — Performance & feel pass
**Implements (GDD):** §13 (chunking, LOD, fire/perf mitigations), App. B (Noita chunking recipe).
**Goal:** run well everywhere and feel good. (Ongoing, not a wall.)

**Build:**
- **Chunked sim (GDD §13, App. B):** divide the grid into chunks with **dirty-rects** so only active chunks update; this is also what makes the wide world *and* mobile viable. Multithread later if needed.
- **Body LOD:** idle/distant bodies simulate cheaper; **fade/settle gore cells** over time so debris doesn't accumulate forever; object pooling.
- **Balance pass** on `config.ts`; **juice** (hit feedback, screen response); readability tweaks (GDD §12 UX priority).

**Done when:** target framerate holds — on desktop *and* the mid-range phone — with a full horde mid-breach and a fire going across a wide, scrolled map, and the moment-to-moment reading of the sim is clear.

---

## Playtest fixes — v0.4 testing (fold into Phase 9 + cross-cutting)

Live playtest of the Phase-8 build surfaced these. Most are the *unwired* Phase-9 worldgen/UI (land them in **9-7 integration**); a few are genuine bugs/design gaps. Each fixed before Phase 9 closes.

| # | Symptom (playtester) | Root cause | Fix / where |
|---|---|---|---|
| 1 | **Not obvious why survivors die** (e.g. of thirst) | death-cause only `console.log`'d; no needs bars on the live build | **9-7**: wire `ui.drawNeedsBars` + `drawToasts` (from 9-5) + `state.deathLog` each frame so every death shows an on-screen cause; needs bars make depletion visible. Add a brief low-need warning tint/icon when a survivor crosses its threshold. |
| 2 | **Survivors/zombies can't pass the tiniest bump; should climb a little** | `STEP_UP_MAX = 1` is too low; rolling-hill worldgen (amplitude 6) has >1-cell surface deltas → they get stuck | **Config + locomotion:** raise `STEP_UP_MAX` to **2–3** (locomotion already loops `h∈[1..STEP_UP_MAX]`, so it just works). Re-verify no-tunnel + the Phase-3/4 step/wall/pit tests. Tune so a gentle slope is climbable but a real wall still stops them. |
| 3 | **Survivors forage only player-placed foliage, not existing/natural foliage** | suspected: seek-food/forager `findTarget` picks the nearest FOLIAGE but the *standable adjacent cell* of a natural bush may be unreachable on the navgrid, or the bush is outside scan radius / the nearest-pick beats a reachable one | **9-7 (verify+fix):** confirm foragers + auto-eat target worldgen/seeded foliage; make resource targeting prefer a **reachable** adjacent cell (skip targets with no walkable neighbour / no path) rather than blindly nearest. Headless test: a survivor eats a worldgen bush. |
| 4 | **Worldgen is a single flat line; looks like stone, not dirt** | `main.ts` still hand-seeds the flat Phase-5/6/7 scene; `worldgen.ts` (9-2) isn't wired in; surface should be a DIRT/grass band | **9-7:** replace the hand-seeded scenes with `generateWorld()` (layered surface DIRT → dirt → stone w/ ore veins, water table, woodland, rolling surface) + `rebuildNavgrid()` after. Surface reads as dirt/grass, not a stone line. |
| 5 | **No ore encountered** | ore veins are at depth in stone (must be mined to); current flat scene has only a tiny outcrop | **9-7 (worldgen):** ore veins exist at depth (9-2). Ensure at least some **shallow/exposed** ore near the spawn zone so a Miner can reach it without deep digging; confirm Miner `findTarget` reaches it. |
| 6 | **Placing stone/wood doesn't deplete gathered resources; it should** | the free raw-material **Paint** tool places WOOD/STONE unlimited & free (a Phase-1 sandbox toy); only Fence/Wall (Build) draw from the stockpile | **Gate placement to the stockpile (GDD §8/§15-Q4 scarcity):** remove (or debug-flag) the free **Wood** and **Stone** paint buttons — the player places those via **Fence (wood)** and **Wall (stone)** which already cost. Keep Sand/Water/Dirt/Erase as free terraforming (no resource backs them) for emergent traps. |
| 7 | **Stone wall is impassable → game too easy; zombies should break stone & wood** | player placed **raw STONE** (id 2, *no integrity* → not breachable) via free Paint, instead of a **WALL** (id 14, integrity, breachable) | Same root as #6. Once raw wood/stone aren't free-placeable, the player's barriers are **WALL/WOOD** which `resolveBreaching` already chips → a mob breaks through (slowly for stone, fast for wood). Re-verify a mob breaches a player-placed WALL in-game. Optionally also let **fire** weaken structures. |

**Routing:** #2 (locomotion/config) and #3 (autonomy targeting) and #6/#7 (placement gating + sim consequence) are correctness → **expensive_coder** or careful orchestrator fixes; #1/#4/#5 land inside the **9-7** integration (expensive). Add a **9-8 “playtest fixes”** pass if cleaner than overloading 9-7. **Re-run the Phase 3/4 locomotion + Phase 5/6/7 regression suites** after #2 and #3.

### Playtest round 2 (v0.4b) — post-Phase-9 patches (all DONE, committed)
- **Viewport corner on hi-DPI:** render in CSS px (canvas backing = floor(rect.w/h), no dpr scale) so ImageData == backing store.
- **Blank view / empty sky:** world taller than viewport → frame camera vertically on the surface (clampCamera no longer pins y=0); center camera horizontally on the colony at startup.
- **Zombies don't move:** idle zombies now DRIFT toward the colony (opposite spawn edge); ZOMBIE_IDLE_SPEED 0.12→0.2.
- **Zombies stuck/buried at edge:** spawn INSET from the edge + on the actual rolling surface of the spawn column (not a fixed y), so they're never buried.
- **Sand/dirt stratify like liquids:** a faller only displaces AIR or fluids, never another powder → powders pile, still sink through water.

### Playtest round 3 (v0.5) — combat/feel feedback (planned, not yet built)

| # | Ask (playtester) | Status / root | Fix → where |
|---|---|---|---|
| A | **Zombies climb over each other** — a clump should use each other like a ladder to climb over walls/obstacles | NEW mechanic. Today a wall taller than STEP_UP_MAX hard-stops a zombie until it breaches. | Locomotion/AI: treat a stacked zombie body as standable ground — i.e. when a zombie is blocked by a too-tall obstacle AND another (alive) zombie body is directly ahead/below it, allow stepping up onto that body (raise effective step-up when a ally-body is the riser). Pile naturally when crowded at a wall. **expensive_coder** (zombie AI + locomotion + no-tunnel). Sits as a **Phase 7 follow-up**; schedule after Phase 10. Cap to keep it cheap (GDD §13). |
| B | **Player starts with limited bullets** so they can't just shoot every zombie | The **Shoot** tool is currently unlimited (a Phase-4 debug verb). GDD §6.3/§13 flag guns/ammo as a power spike to gate via scarce ammo. | Add an **ammo** count (config `STARTING_AMMO`, e.g. 12–20); each Shoot tap decrements it; at 0 the Shoot tool no-ops + greys (mirror build-button greying) + a toast. Optional: ammo as a rare pickup/craft later. **cheap_coder** (UI/input + a counter); **Phase 9-style HUD** addition. Do in the **Phase 11 balance pass** or as a small patch. |
| C | **Zombies should break things, shown to the player; more zombies = faster; stone > wood** | **Already implemented** (Phase 7 `resolveBreaching`: chips integrity by chance, pressure scales with attacker count, WALL 200 > WOOD 60). The MISSING part is **visual/feedback** so the player can see it. | **Render/UI only:** show breaching — e.g. darken/crack a structure cell as its integrity drops (tint by integrity ratio in the renderer), a small hit flash/particle when chipped, and/or an edge-arrow/toast when a structure is under attack off-screen. **cheap_coder** (renderer tint by integrity + a hit cue). Land alongside the Phase 11 juice pass (or sooner as a patch). NB: integrity is already stored per-cell, so the renderer can read it. |
| D | **Waves are too close together** | `WAVE_INTERVAL = 1200` ticks (≈20s) + the curve decays it toward `WAVE_INTERVAL_MIN = 600`. Too tight given the long approach. | Balance: raise `WAVE_INTERVAL` (e.g. →2400) and/or `WAVE_INTERVAL_MIN`; re-tune the decay so early waves breathe. **Config-only**, do in the Phase 11 balance pass (or a quick patch). |

**Routing/sequencing:** C-visual + B-ammo + D-pacing are light (cheap/config) — fold into the **Phase 11 feel/balance pass** (or quick patches between phases). A (zombie-ladder climbing) is a real **expensive** AI/locomotion mechanic — schedule as a **Phase 7 follow-up after Phase 10**, with no-tunnel + a perf cap re-verified.

### Playtest round 4 (v0.6) — readability/control/ecology (planned)

| # | Ask (playtester) | Scope / root | Fix → where |
|---|---|---|---|
| E | **Different outfits per role** so you can see who is who (Miner/Lumberjack/Forager/Guard/idle) | Readability (GDD §12 UX priority). Today all survivors render identically; the renderer only has `bodies`, not roles. | **Render:** give the renderer per-body role info (or a per-body tint/uniform colour) and tint the body sprite by role — e.g. recolour the torso/‘cloth’ pixels per role, plus a distinct guard look. Pass `survivors` (or a `{body, tint}` list) to the renderer like the zombie green-tint path. **cheap_coder** (render-only). Land in the **Phase 11 readability/juice pass** (or a small patch). |
| F | **Right-click a character opens the Assign menu** | Desktop convenience — the same role menu as long-press (10-6) / the Assign tool. | **Input:** add a `contextmenu` listener (`e.preventDefault()`) that picks the survivor under the cursor and calls `showRoleMenu` — the desktop twin of the **long-press** role menu. **Fold into task 10-6** (cheap_coder), since it shares the exact picking + menu code. |
| G | **Plant foliage like a seed; it grows by itself** (replace the instant Foliage paint) | NEW mechanic = **tree/plant growth + reproduction**, which GDD §9 + §14 list as **vertical-slice/Beyond** (not MVP). | **Deferred to the vertical-slice tier** (see below). MVP-light option if pulled forward: a `SAPLING` material the player plants that, over `GROW_TICKS`, converts upward into FOLIAGE on suitable soil (DIRT) — a small sim rule + a “Plant” tool replacing the free Foliage paint. **expensive_coder** (new sim behaviour) IF authorised; otherwise it stays in the deferred list. |

**Routing/sequencing:** F (right-click menu) → **fold into 10-6**. E (role outfits) → **Phase 11 readability**, render-only, easy. G (seed/growth) → **deferred vertical slice** unless you explicitly authorise the MVP-light SAPLING version.

### Playtest round 5 (v0.7) — death-model revision (planned)

Today **every** death runs the same path: the whole body dissolves into falling cells (the Vagabond death-collapse — GDD §5.1, §7.2, §14, glossary). That's too uniform and too explosive. This revision makes **how you die read in how you fall**, and adds **infection/turning** as a new threat.

> **GDD divergence — reconcile when adopted:** the GDD currently states death *always* dissolves into cells (§5.1 "fully dissolves… when it dies", §7.2 "Head → body fully dissolves", §14 Milestone 0, Appendix A "Death-collapse"). This round **narrows** that to *extreme* deaths only and **adds a corpse state + zombie infection/turning**. Update those GDD sections (and add a Warmth/needs ↔ corpse note in §6.1, a bite/turning note in §7) when this is accepted. The MVP **Gate test** (Phase 4 *Done when* #2 "headshot → indistinguishable pile") still holds — a headshot is exactly the extreme case that keeps the dissolve.

**The new model — three death outcomes, selected by *cause*:**

| # | Ask (you) | Outcome / rule | Where it lands |
|---|---|---|---|
| H | **Only *extreme* deaths explode into elements** (not every death) | Reserve the **full cell-dissolve** for **violent/extreme** deaths: **headshot**, explosion/blast, **torso disintegration past threshold**, crushed by collapse, or burned to completion. Everything else takes the new **corpse** path (below). Requires tagging each lethal event with a **death cause/type**, then branching the death handler on it instead of always dissolving. | **Phase 4 revision** (`damage.ts`): the existing dissolve becomes the *extreme* branch; add a `dropToCorpse()` branch. Keep limb-loss→crawl unchanged. |
| I | **Bitten survivor → drops *prone*, then *turns into a zombie*** | A zombie melee hit is a **bite** (infecting), not a dismembering hit. On a bite: set `infected=true` + start a **turn timer**; the survivor keeps acting briefly, then **drops to a prone/downed state** (can't work/fight, may twitch/crawl), then **reanimates as a zombie** — reuse the same body, **swap the controller to zombie AI**, recolour (green-tint path). **Counterplay:** an **extreme** hit on the infected/prone body **before** it turns kills it for good (it explodes via #H instead of rising) — so the player races the timer. | **Phase 7 revision** (`zombie.ts` + `survivor.ts`): add a **bite** attack distinct from generic damage; add `infected`/`turnTimer`; add the **prone** state to `locomotion.ts`/render; reanimation reuses the Body, switches AI. |
| J | **Starvation / thirst death → just *lay down dead*** (no explosion) | Non-violent needs deaths (**hunger, thirst**, and by extension **freezing** from VS-2, quiet **bleed-out** from minor wounds, **drowning**) take the **corpse** path: the rig plays a **lie-down/settle**, leaving a **prone corpse body** — *not* a cell spray. Corpses **settle, are buryable/burnable** (a burning corpse can still ignite → then it may dissolve), and **decay/fade over time** under body-LOD so debris doesn't accumulate (GDD §13). A starvation corpse is **inert** (does not turn — only **bites** infect, per #I). | **Phase 5 revision** (`survivor.ts`): needs-zero death calls `dropToCorpse()` not dissolve. Same for VS-2 freeze/drown. |

**Shared new machinery (the corpse + turning state):**
- **Death cause enum** threaded into the kill path: `EXTREME` (headshot/blast/disintegrate/crush/full-burn) → dissolve; `NEEDS`/`QUIET` (hunger/thirst/freeze/drown/bleed-out) → corpse; `BITE` → infected → prone → zombie.
- **Body lifecycle states:** `alive → (infected) → prone/downed → {corpse | reanimated-zombie | dissolved}`. Prone is a real locomotion/render state (low stance, no role work, optional slow crawl).
- **Corpse handling:** corpses are settled Bodies (cheap, LOD'd, poolable) that can be **buried, ignited (→ may then dissolve), or decayed/faded** over `CORPSE_DECAY_TICKS`. Distinct from loose gore cells.
- **Reanimation:** turning reuses the existing Body + the Phase-7 zombie controller (no new spawn), so a colony that loses a fight **grows the horde** — a strong new pressure and a reason to **clear/burn your dead**.

**Config seeds:** `TURN_TICKS` (bite → zombie), `PRONE_AFTER_BITE_TICKS`, `CORPSE_DECAY_TICKS`, `EXTREME_DEATH_CAUSES` (the dissolve set), `BLEEDOUT_THRESHOLD` (quiet bleed vs. violent disintegration), `BITE_INFECT_CHANCE` (optional: not every bite infects).

**Routing/sequencing:** this is a **core model change**, not polish — schedule it as a deliberate pass, **not** the Phase 11 juice pass. Land #H (corpse-vs-dissolve branch) and #J (needs→corpse) together as a **Phase 4 + Phase 5 revision** (shares the corpse machinery); #I (bite→prone→turn) as a **Phase 7 revision** on top. **expensive_coder** (new states + AI handoff + death-cause plumbing). **Re-run the Phase 4 Gate test** (headshot still dissolves) and Phase 7 combat regressions after. Pairs naturally with the **VS-2 freeze** death (also a corpse) — sequence after VS-2 if you want freeze handled in the same pass.

### Playtest round 6 (v0.8) — vertical-slice (weather / warmth / camp) feedback (planned)

Live playtest of the post-VS-1/VS-2 build (dynamic weather + warmth + campfire). Two are UX/readability papercuts on role assignment; one is a weather-balance/sim gap that makes the snow phase unplayable.

| # | Ask (playtester) | Scope / root | Fix → where |
|---|---|---|---|
| K | **Can't select a survivor while it's moving** / **the selection box doesn't follow the sprite** | Control + readability (GDD §12.3/§12.4). `showRoleMenu` ([input.ts](src/input.ts)) just shows a FIXED, centred `#role-menu` overlay (`display:block`) — there is **no per-survivor selection indicator** that tracks the chosen body, and **nothing marks who is selected**. Picking is `pickCycling` at the tap's world point with `SELECT_TAP_RADIUS = 6` (config) — a small radius, so a drifting sprite is easy to miss, and once the menu is open the survivor keeps walking away from it. | **(a)** Draw a **selection highlight ring/box that tracks `selectedSurvivor` every frame** via `worldToScreen` (render-time, so it follows the moving sprite). **(b)** Either **freeze the selected survivor's movement while its menu is open**, or **anchor the menu beside the sprite and reposition it each frame**. **(c)** Make picking more forgiving — enlarge `SELECT_TAP_RADIUS` and/or snap to the nearest survivor within a generous radius regardless of motion. **cheap_coder** (input + a render-time highlight). Land as a VS-3 polish pass or a quick patch. |
| L | **Role colours have no legend** — colour-match the Assign-menu buttons to each role's sprite tint | Readability (GDD §12). `ROLE_TINT` ([roles.ts](src/game/roles.ts)) already tints bodies by role (11-5), but the `#role-menu` buttons ([index.html](index.html)) are plain text, so the player can't map a tint to a role. | **Colour each role button** (swatch / left-border / background) to its `ROLE_TINT`: miner slate-grey `[110,120,135]`, lumberjack brown `[150,90,40]`, forager green `[60,140,60]`, guard steel-blue `[70,110,170]`, builder amber (`BUILDER_TINT`); Unassign/none neutral. **Derive the swatch from `ROLE_TINT`** (single source of truth) so menu and sprite never drift apart. **cheap_coder** (UI/CSS + a tiny wire from `ROLE_TINT` to the buttons). |
| M | **Snow is unbalanced — it buries everything; you can't build a shelter before it falls.** Wants: snow falls in **drips and drabs across the map** (not everywhere at once), with **light→heavy weights**, and **melts depending on temperature** | Weather-balance + a sim gap. `applyWeather()` ([simulation.ts](src/engine/simulation.ts)) seeds the **ENTIRE sky row every tick** (per-cell `SNOW_SPAWN_CHANCE = 0.02` over `WORLD_W = 1280` ≈ **26 flakes/tick across the full width**) for the whole 1200–3000-tick snow phase → a uniform curtain that accumulates and **buries terrain + structures fast**. There is **one** SNOW material with **one** fall behaviour (no light/heavy). Melt only happens **adjacent to FIRE** (`meltSnow`/`SNOW_MELT_CHANCE`, [reactions.ts](src/engine/reactions.ts)) — **no ambient-temperature melt** (the VS-1 "slow ambient melt above freezing" line was never implemented), so accumulated snow never recedes when it warms. | **(1) Drips and drabs:** drop `SNOW_SPAWN_CHANCE` sharply and/or spawn in **spatial clusters / drifting flurries** (a few moving snow patches, not the whole row) so squalls cross the map instead of a uniform sheet — keep it deterministic (`simRand`) and chunk-safe. **(2) Variable weight:** a **light→heavy intensity** on the snow state that scales spawn rate / cluster size (and optionally a per-column accumulation cap) so light flurries *dust* rather than *bury*. **(3) Ambient melt:** implement the deferred melt — when `getTemperature()` is above a melt point, SNOW melts to WATER over time (deterministic per-cell roll), so snow recedes as it warms; keep the fast fire-adjacent melt. **Config:** lower `SNOW_SPAWN_CHANCE`, new `SNOW_INTENSITY`/`SNOW_CLUSTER_*`, `SNOW_AMBIENT_MELT_CHANCE` + `SNOW_MELT_TEMP`. **expensive_coder** (sim-correctness — spawn pattern + melt rule must keep chunk byte-equivalence + no-tunnel). |

**Routing/sequencing:** K + L are light **cheap_coder** UX/render fixes — fold into a VS-3 polish pass or land as quick patches. M is **sim-correctness (expensive_coder)** — it touches `applyWeather`/snow spawn + a new ambient-melt rule, so **re-run `p11-chunk-equiv` + `weather-sim`/`weather-state` + the warmth suites** after. M is the priority: the snow phase is currently unplayable for the camp/shelter loop, so it should land before (or alongside) VS-3's cooperative shelter build.

> **✅ M DONE** (orchestrator direct): snow now falls in drifting **flurry bands** of light→heavy intensity (`SNOW_BAND_WIDTH`/`SNOW_BAND_GAP`/`SNOW_DRIFT`/`SNOW_INTENSITY_*`, in-band rate `SNOW_SPAWN_CHANCE`) instead of a whole-row curtain, and a snowpack **melts above `SNOW_MELT_TEMP`** at `SNOW_AMBIENT_MELT_CHANCE`/tick (chunk-safe via a warm-up edge that wakes settled snow). Verified `test/weather-snow.test.ts` (bands/sparse/drift + melt + **byte-identical chunked-vs-full melt**); `weather-sim`/`weather-state`/`p11-chunk-equiv` still green.
>
> **M round 2** (playtest: snow STILL buried players + zombies before it melted): `SNOW_SPAWN_CHANCE` cut **10x** (0.06 -> 0.006) so accumulation is a light dusting; and **no extreme weather early** - a "snow" transition before `WEATHER_SNOW_EARLIEST_TICK` (12000) is redirected to mild rain (`weather.ts`), so a shelterless early colony is never buried/frozen. `weather-sim` snow accumulation dropped ~10x (t500 4802 -> 469); new `weather-state` gate check (no snow pre-12000, snow after).

> **✅ K DONE** (cheap, orchestrator direct): a dashed **selection box now tracks the selected survivor each frame** (`ui.drawSelectionHighlight` via `worldToScreen`, fed by `input.getSelectedSurvivor()`, drawn in the main render loop), so you can see who the floating role-menu applies to even while they move; clears if the survivor dies. `SELECT_TAP_RADIUS` widened 6 -> 12 so a MOVING sprite is easy to grab. Verified `test/k-select-highlight.test.ts` (box tracks body, none for null/dead, radius widened).

> **✅ L DONE** (cheap, orchestrator direct): each Assign-menu role button gets a left-edge colour swatch derived from `ROLE_TINT` (new `roles.roleTintCss`, applied in `input.ts` at wire time; Unassign = neutral grey), so the menu legend matches the on-screen body tint and can't drift. Verified `test/l-role-legend.test.ts` (swatches == ROLE_TINT, distinct, Unassign neutral). **All v0.8 playtest items (K, L, M) now done.**

---

## Vertical slice (post-MVP — prove the *feel*)  *(GDD §14 "Vertical slice")*

These phases start **only after the MVP (Phases 0–11) is complete and fun.** They came out of the playtester ask for survivors to **cooperatively build a camp — shelter, water, and a fire to keep warm** — and fold in the GDD's weather/warmth tier (GDD §10, §6.1). Same rules as the MVP phases: each ends in something **runnable and testable**, names the **GDD sections it implements**, and tunes via `config.ts`.

> **Build order matters:** VS-1 (weather makes it cold/wet) → VS-2 (cold/wet hurts survivors, fire/shelter relieve it) → VS-3 (survivors *build* that shelter themselves, in groups). Don't start VS-2 until VS-1's temperature drives a number you can read; don't start VS-3 until VS-2 gives survivors a reason to want shelter.

### Vertical-slice phase → GDD map

| Phase | Builds | Primary GDD refs |
|---|---|---|
| VS-1 | Weather + temperature (rain, snow) | §10, §5.2 (Ice/Snow), §12.2 |
| VS-2 | Warmth need: cold & wet → fire & shelter | §6.1 (Warmth + auto-override), §8 (shelter, campfire) |
| VS-3 | Survivor-driven **cooperative** base-building + group/shelter logic | §6.2 (Builder/Hauler), §8, §6.1 |

### New files this tier grows into

```
/src
  game/
    weather.ts        // VS-1: weather state machine, ambient temperature, precip emit
    groups.ts         // VS-3: proximity/line-of-sight clustering of survivors into groups
    shelter.ts        // VS-3: shelter blueprint, site selection, enclosure/roof test
  characters/
    survivor.ts       // extend needs: + warmth, + wetness (VS-2)
```

---

## Phase VS-1 — Weather & temperature (rain + snow)
**Implements (GDD):** §10 (weather states, rain, snow, temperature), §5.2 (Ice/Snow material), §12.2 (weather/temperature indicator).
**Goal:** the sky becomes a system. Weather cycles, rain falls and pools, snow accumulates, and a single readable **ambient temperature** comes out the other side for VS-2 to consume.

**Build:**
- `weather.ts` — a **weather state machine**: `CLEAR → RAIN → SNOW` (and back) with seeded, timed transitions (GDD §10). Expose `currentWeather` and a scalar **`ambientTemp`** (warm in clear, cooler in rain, sharply colder in snow). Keep temperature a **single global scalar**, not a per-cell grid — survivors sample *local* modifiers in VS-2; a temp grid is too expensive (GDD §13).
- **Rain (GDD §10):** emit a sparse scatter of `WATER` cells along the **top of the active/visible columns** each tick (a few drops per tick, not a full curtain — cheap). Rain therefore **douses fire** and **pools/floods/erodes loose grains for free** via the existing water sim + `reactions.ts`; it also **accelerates plant growth** (hook for the ecology slice). Optional **wind**: bias precip + smoke + fire-spread x-drift by `WIND_DIR`.
- **Snow (GDD §5.2, §10):** add a `SNOW` material to `materials.ts` — a **light powder** (low density, piles like sand but softer) that **accumulates as cells** and **melts** (reaction: `SNOW + FIRE → WATER`, and a slow ambient melt above freezing → WATER). Snow contact is what makes a survivor "cold/wet" in VS-2; snow can **bury/insulate** like any powder.
- `reactions.ts` additions: `snow + fire → water`; rain-over-fire → steam+extinguish (already exists from Phase 2). 
- **HUD (GDD §12.2):** a weather + temperature indicator (icon for clear/rain/snow + the ambient-temp readout) so the player can **telegraph and prepare** (GDD §13 difficulty legibility).

**Config seeds:** `WEATHER_CYCLE_TICKS`, `WEATHER_TRANSITION_TICKS`, `RAIN_DROPS_PER_TICK`, `SNOW_FLAKES_PER_TICK`, `SNOW_MELT_TICKS`, `AMBIENT_TEMP_CLEAR`, `AMBIENT_TEMP_RAIN`, `AMBIENT_TEMP_SNOW`, `FREEZE_POINT`, `WIND_DIR`.

**Done when:** weather visibly cycles; rain fills puddles and **puts out a fire**; snow **accumulates into drifts** and **melts when a fire is lit beside it**; the HUD always shows the current weather and temperature. (No survivor effects yet — that's VS-2.)

---

## Phase VS-2 — Warmth need: cold & wet survivors, fire & shelter as relief
**Implements (GDD):** §6.1 (Warmth need + auto-override + freeze death), §8 (shelter as warmth/retreat, campfire as warmth source).
**Goal:** weather now *bites*. Survivors get cold and wet, must reach **fire or enclosed shelter**, and **freeze to death** if they can't.

**Build:**
- **Warmth need (GDD §6.1):** add `warmth` to the survivor needs floats (the Phase-5 needs system). It **drains when local temperature is below `FREEZE_POINT`** (faster the colder it is, faster at night if day/night exists) and **refills near fire or inside shelter**. Hitting zero → **freeze → death** via the Phase-4 death path, with a clear on-screen death-cause (GDD §13).
- **Wetness (the "wet" half of cold-and-wet):** a per-survivor `wetness` float that **rises in rain and on contact with `WATER`/`SNOW`** and **dries slowly** (much faster near fire). **Wet survivors lose warmth faster** (`WET_WARMTH_MULT`) — so being caught in rain/snow without shelter is the threat, exactly as asked.
- **Local effective temperature** (sampled per survivor, cheaply, on an interval): `ambientTemp` (from VS-1) **+ nearby-FIRE bonus** (any FIRE/campfire within `FIRE_WARMTH_RADIUS`) **+ shelter-enclosure bonus** **− wetness penalty** **− snow/water-contact penalty**. This single number drives the warmth drain/refill.
- **Shelter / enclosure test** (`shelter.ts`): a survivor counts as **sheltered** when its cell is **roofed** (solid cells overhead within `ROOF_SCAN_H`) inside a **mostly-enclosed air pocket** (cheap flood-fill from the cell, bounded; cache the verdict per region and refresh on an interval / on local terrain edits — same invalidation discipline as the navgrid). This is the rule VS-3's built shelters must satisfy.
- **Campfire (GDD §8):** a placeable/buildable **contained fire** that **burns long for warmth + light without eating your structures** (a managed fuel source, distinct from raw spreading `FIRE`). Player can place one now; VS-3 survivors will build one.
- **Auto-override (GDD §6.1):** `warmth < WARMTH_THRESHOLD` drops the survivor's role and sends it to the **nearest heat source or enclosed shelter** to recover; if **neither exists**, that's the unmet need VS-3 resolves (build one). Generalises the GDD's "retreat to shelter when too cold."
- **HUD:** a third needs bar (warmth) over survivors, a **wet icon**, and a freeze death-cause toast.

**Config seeds:** `WARMTH_RATE`, `WARMTH_THRESHOLD`, `WET_WARMTH_MULT`, `DRY_RATE`, `FIRE_WARMTH_RADIUS`, `SHELTER_WARMTH_BONUS`, `SNOW_CONTACT_PENALTY`, `WARMTH_SAMPLE_TICKS`, `CAMPFIRE_FUEL`, `FREEZE_TICKS`.

**Done when:** in snow/cold a survivor's warmth visibly drains — **faster while it's wet or standing in snow** — it **auto-overrides to huddle by a campfire or step into a roofed shelter** and recovers, and with **no heat and no shelter it freezes to death** with a clear cause. (Survivors don't yet *build* the shelter — they only use existing ones. That's VS-3.)

---

## Phase VS-3 — Survivor-driven cooperative base-building + group/shelter logic
**Implements (GDD):** §6.2 (Builder/Hauler role), §8 (shelter structure), §6.1 (shelter-seeking auto-override).
**Goal:** the headline ask. Co-located survivors **work together to raise one shared shelter**; a survivor that wanders **out of sight** of the others **splits into its own group** and builds **its own** shelter where it is.

**Build:**
- **Builder/Hauler role (GDD §6.2):** the vertical-slice role — **hauls a material from the stockpile, paths to a build cell, places it** (decrement stockpile, consume `BUILD_PLACE_TICKS`), repeat. Reuses Phase-5 pathing, Phase-6 role loop, Phase-8 stockpile-gated placement.
- **Grouping by sight (`groups.ts`) — the core of the ask:** on an interval (`GROUP_RECHECK_TICKS`, **not every tick**), partition survivors into **groups** by mutual visibility — two survivors share a group if within `SIGHT_RADIUS` **with line-of-sight** (no solid wall between; reuse the zombie sense/LOS idea from §7.1). Use union-find / simple clustering.
  - **Split:** a survivor (or sub-cluster) **out of sight of its group for longer than `SPLIT_DEBOUNCE_TICKS`** becomes its **own group** — so "over the hill, out of sight" really does fork them, as specified. The debounce stops flicker when someone briefly dips behind terrain.
  - **Merge:** groups that come **back into mutual sight** for `MERGE_DEBOUNCE_TICKS` rejoin.
- **One shelter project per group (`shelter.ts`):** each group owns at most **one** shelter **project** = a **blueprint** (an enclosed `WALL`/`WOOD` box with a **roof + doorway**, sized by member count via `SHELTER_PER_SURVIVOR_AREA`) at a **site picked near the group's centroid** on suitable, defensible ground (near water/heat if possible). The project's enclosure must satisfy VS-2's **shelter test** when complete.
  - **Cooperative build:** the group's Builders **divide the remaining blueprint cells** — each **claims/reserves** a cell so two builders don't target the same one — and haul+place until the shell **encloses**. Then a survivor builds a **campfire** (VS-2) inside. Non-builders in the group may still **shelter** there.
  - **Split → own shelter:** a freshly-split cold group **starts its own project at its own location** — it does **not** trudge back across the map to the original shelter (the whole point of the fork). VS-2's shelter-seek auto-override targets **this group's** shelter / build-site.
  - **Merge → consolidate:** when groups remerge, keep the **more complete** project and **abandon the redundant one** (its claimed cells release; members join the survivor project). Log it so it reads as intentional, not a glitch (GDD §13).
- **Ownership & cost discipline (GDD §13):** groups, projects and cell-claims live in `groups.ts`/`shelter.ts`; recompute clustering on an interval; **cap concurrent build-claims**; release claims on builder death/reassignment so projects can't deadlock.

**Config seeds:** `SIGHT_RADIUS`, `GROUP_RECHECK_TICKS`, `SPLIT_DEBOUNCE_TICKS`, `MERGE_DEBOUNCE_TICKS`, `SHELTER_PER_SURVIVOR_AREA`, `SHELTER_MIN_SIZE`, `BUILD_PLACE_TICKS`, `HAUL_CAPACITY`, `MAX_BUILD_CLAIMS`.

**Done when:**
1. A **co-located** group of survivors, when cold, **collectively hauls wood/stone and raises one shared roofed shelter**, lights a campfire inside, and huddles to recover warmth (VS-2).
2. Lead **one survivor away over a hill, out of sight** — after the split debounce it **forms its own group and builds a second, separate shelter** where it is.
3. Bring them back together — the groups **remerge** and the **redundant project is abandoned** cleanly (no orphaned half-builds, no deadlocked claims).

---

### Vertical slice — AUTHORIZED (do after Phase 11 / MVP) — GDD §14 (user greenlit; sequenced in PROGRESS.md Authorized backlog)
- **Plant/tree growth + reproduction (plant-a-seed foliage)** (GDD §9 ecology) — vertical-slice; MVP-light SAPLING→FOLIAGE grow rule possible if authorised (playtest v0.6 #G).
- **In-scope sliver (do in the Phase 11 balance pass, not deferred):** make survivors react EARLIER to hunger/thirst (bigger buffer) so they “go get it rather than just dying,” and keep the on-screen death-cause prominent.

---

## How to vibe this

1. Paste **one phase** at a time into your coding agent, plus the **GDD sections it names**. Smaller, targeted context = better output.
2. End every phase by running the **Done when** test yourself before moving on.
3. When something feels off, fix it *in that phase* — don't pile the next phase on a wobbly base.
4. Treat **Phase 4** as a true go/no-go. Everything after it assumes the illusion works.

> Stretch (post-MVP, do not block on — GDD §14 "Beyond" / "Vertical slice"): Diggers/Fisherman/Builder roles, iron-tier tools + upgrades, Warmth + weather, herd dynamics, dual-edge spawns, tree growth/reproduction, day/night, campaign levels, and the full cellular soft-body locomotion experiment (Lenia-style, GDD §5.1 + App. B).
