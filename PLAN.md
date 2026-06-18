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

## How to vibe this

1. Paste **one phase** at a time into your coding agent, plus the **GDD sections it names**. Smaller, targeted context = better output.
2. End every phase by running the **Done when** test yourself before moving on.
3. When something feels off, fix it *in that phase* — don't pile the next phase on a wobbly base.
4. Treat **Phase 4** as a true go/no-go. Everything after it assumes the illusion works.

> Stretch (post-MVP, do not block on — GDD §14 "Beyond" / "Vertical slice"): Diggers/Fisherman/Builder roles, iron-tier tools + upgrades, Warmth + weather, herd dynamics, dual-edge spawns, tree growth/reproduction, day/night, campaign levels, and the full cellular soft-body locomotion experiment (Lenia-style, GDD §5.1 + App. B).
