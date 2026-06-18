# GRAVEGRAIN — Game Design Document

> **Working title:** *Gravegrain* (placeholder — alternatives: *Ashfall*, *Dust & Dead*, *The Last Grains*, *Sandlost*)
> **Version:** 0.4 (concept draft) — *v0.4: world is wider than the viewport and scrolls horizontally; mobile is now a first-class target (pointer-first input, pan-vs-act tool modes, touch UI, mobile performance budget). v0.3: hybrid character model for MVP + pixel-style mandate + prior-art appendix. v0.2: characters cellular; zombies breach structures; characters pass through trees.*
> **Document owner:** [you]
> **Status:** Pre-production / concept

---

## 1. High Concept

A falling-sand physics sandbox where you save autonomous survivors from incoming zombie hordes by assigning them jobs — *Lemmings*-style — rather than controlling them directly. The world is a fully simulated, destructible grid of sand, water, ore, stone and woodland. Survivors gather, build and fight; zombies meander in from the edges and swarm when they sense the living. Terrain collapses, water floods, trees grow, and fire spreads — and all of it is a weapon or a hazard depending on how you use it.

**One-line pitch:** *Lemmings meets a falling-sand toy, wrapped in a zombie-survival colony sim.*

---

## 2. Pillars

These are the load-bearing ideas. Every feature should serve at least one. If a feature serves none, cut it.

1. **The world is a physics toy first.** Everything is made of simulated grains. Digging, flooding, collapsing and burning are core verbs, not set dressing.
2. **You direct, you don't puppet.** You assign roles and place materials; survivors act autonomously. The fun is in *indirect* control under pressure.
3. **Emergent crises.** The interesting moments come from systems colliding — a flood that drowns your own diggers, a fire that clears a horde but torches your fences, a dig that buries a worker.
4. **Scarcity drives decisions.** Tools, food, water and warmth are always slightly short. Every assignment costs something.

---

## 3. Genre & Influences

- **Falling-sand / powder games** (*Powder Toy*, *Noita*, *Sandspiel*) — cellular material simulation, emergent interactions.
- **Lemmings** — indirect control, role/ability assignment, the unit as a semi-autonomous problem to be steered.
- **Colony / survival sims** (*RimWorld*, *Oxygen Not Included*, *Don't Starve*) — needs (food/water/warmth), jobs, base-building, defense waves.
- **Tower-defense pacing** — escalating zombie waves from the map edges.

---

## 4. Core Gameplay Loop

**Macro loop (a "run"):**
1. Survivors spawn together with a small resource cache and no infrastructure.
2. Player assigns roles → survivors gather wood, stone, water, food, ore.
3. Resources → tools → unlock more/better roles → faster gathering and stronger defense.
4. Build shelter, walls, fences, fire; manage food/water/warmth needs.
5. Zombies arrive in escalating waves; player defends by combat, terrain manipulation, traps and fire.
6. Survive long enough / reach an objective → win. Lose all survivors → fail.

**Micro loop (moment-to-moment):**
- Watch the simulation, spot a threat or opportunity → re-assign a survivor or place/ignite/dig a material → watch the physics resolve → react again.

```
        ┌─────────────┐
        │  Observe sim │◄────────────┐
        └──────┬──────┘             │
               ▼                    │
        ┌─────────────┐      ┌──────┴───────┐
        │ Assign role  │      │  Physics &    │
        │ or place/dig │─────►│  AI resolve   │
        └─────────────┘      └──────────────┘
```

---

## 5. The World & Simulation Engine

### 5.1 Architecture decision: cellular bodies, built the pragmatic way

**The fantasy:** survivors and zombies should look and behave as if they are made of the same cellular stuff as the world — they burn, bleed, lose limbs, get buried, and fall apart into grains. **The build path:** we deliver that fantasy with a **hybrid model**, not by simulating every body as a free soft-body of cells (which is the project's biggest risk — see §13 and the prior-art lessons in Appendix B).

#### The hybrid model (this is what the MVP builds)

A character is a **chunky pixel-art body rigged to a simple skeleton while alive, that sheds real cells when damaged and fully dissolves into the cellular sim when it dies.** Three things make this read as "made of CA" while staying cheap and controllable:

1. **Rendered at the world's cell resolution.** The body is drawn in coarse, low-res pixels that are *the same size as world cells*. A character's pixels and a pile of loose sand grains look like the same material at the same grain — so the eye reads the character as part of the cellular world. (This pixel style is mandatory, not cosmetic — it's what sells the illusion.)
2. **Alive = sprite + simple skeleton.** A small rig (head, torso, two arms, two legs) drives a procedural/animated walk cycle. Locomotion and pathfinding are the *solved, cheap* rigged-character kind — not deformable-blob physics. This sidesteps the hardest risk entirely.
3. **Damaged/dead = real cells.** This is the key trick (borrowed from Vagabond — see Appendix B). When a body region takes damage, its pixels are **released into the live cellular simulation** as body cells (flesh/bone/blood) that fall, pile, bleed and burn:
   - **Lose a leg:** that limb's pixels detach and drop as cells; the rig disables the limb → the character collapses to a **crawl**. Real limb loss, no soft-body solver.
   - **Headshot / death:** the whole body disintegrates into falling cells (the Vagabond death-collapse).
   - **Fire:** flesh pixels convert to flammable cells and ignite/spread like any other fuel.
   - **Buried/drowned:** the rigged body reads the world (sand above, water over head) and reacts; on death it dissolves into the sim like everything else.

So the **damage model is still emergent and cellular** (§7) — gore, severing, burning and burial all happen in the real sim — while **locomotion stays a cheap, reliable rigged sprite**. Best of both: the look and the limb-loss of cellular bodies, without the locomotion nightmare.

#### Full cellular soft-body locomotion = post-MVP stretch

Truly simulating a living body as cells bound by constraints that *walks* (Lenia-style emergent locomotion, see Appendix B) stays a **research stretch goal**, prototyped only after the hybrid game is fun. The hybrid is designed so this can be swapped in later for individual creature types without redesigning the rest of the game.

> **Net effect on risk:** the hybrid moves the project's hardest problem (deformable-body locomotion over destructible terrain) out of the critical path, while keeping the emergent damage/death that made "everything is cells" worth doing.

### 5.2 Cellular materials (starting set)

Every material has, among its properties, a **collision mask** that defines what it's solid to. This is how trees can be walked through while still burning, and how bodies can be buried by sand but pass through foliage (see notes below).

| Material | Behaviour | Notes |
|---|---|---|
| **Air** | empty | default |
| **Sand** | falls, piles at angle of repose | collapses when undermined; solid to bodies (can bury/pin) |
| **Dirt** | falls, piles steeper than sand | grows grass/plants on top; solid to bodies |
| **Stone / Rock** | static, must be mined | structural; solid to everything |
| **Ore** | static, mined → iron resource | embedded in stone veins |
| **Water** | flows, seeks level, evaporates slowly | drowns bodies (head submerged too long), grows plants, douses fire |
| **Wood** (placed) | static, flammable, has integrity | structures; solid; **can be broken/burned through** (see §8) |
| **Plant / Foliage** | static, flammable, spreads, has integrity | trees, bushes, grass; **permeable to bodies** (characters pass through) but solid to fluids/fire-fuel; provides concealment |
| **Flesh** (body) | flammable, bleeds when damaged | character body matter; falls when severed |
| **Bone** (body) | rigid, anchors the skeleton | harder to destroy than flesh; structural for the body |
| **Blood** (body) | flows like thin fluid, stains, slippery | emergent damage indicator; douses nothing |
| **Fire** | spreads to flammable neighbours, rises | consumes fuel, makes smoke; ignites flesh and foliage |
| **Smoke / Steam** | gas, rises, dissipates | steam from water+fire; blocks vision/detection (optional) |
| **Ash** | falls lightly, inert | residue of burned material/bodies |
| **Ice / Snow** | snow piles; ice is solid; melts near fire | weather-driven; slippery (optional) |

**Permeability rule of thumb:** *foliage* is the one material solid bodies ignore for collision (so survivors and zombies move freely through woodland), while it still blocks/holds fluids and acts as fire fuel. Everything else solid (sand, dirt, stone, wood structures) collides with bodies normally.

**Material interactions (examples):** water + fire → steam + extinguish; fire + wood/plant/flesh → fire spreads + ash; flesh damaged → blood cells; water + dirt → (optional) mud/faster plant growth; undermined sand/dirt → collapse (can bury bodies).

### 5.3 World generation

Largely procedural, seeded for replayability.

- **Wide world:** the map is **several viewports wide** and scrolls horizontally (§12.1). The survivor start zone sits away from the zombie edge(s) so there's travel distance between spawn and the colony.
- **Layered terrain:** surface soil/grass → dirt → mixed sand pockets → stone with **ore veins** at depth, with **water tables / underground pools**.
- **Surface features:** woodland clusters (trees + bushes), rock outcrops, ponds/rivers, sand dunes.
- **Spawn guarantees:** survivor start zone is reasonably safe, with at least a minimum guaranteed wood + water source within reach.
- **Edge zones:** zombie spawn lanes on one or both horizontal map edges (configurable per level).
- **Tunable knobs:** ore density, water table height, woodland coverage, surface flatness, **map width (in screens)**, zombie-edge count.

---

## 6. Survivors

### 6.1 Behaviour model

Each survivor is a **hybrid pixel body** (§5.1) driven by a controller: needs + an assigned **role**. Without a role they idle/wander near base or flee threats. With a role, the controller drives the body across the simulated terrain to do the job. Because the body is made of cells, its **Health is not an abstract bar — it's body integrity**: damage removes cells, severing limbs degrades movement, and destroying the head cluster is death.

**Needs (deplete over time):**

| Need | Depletes from | Replenished by | Failure state |
|---|---|---|---|
| **Hunger** | time, exertion | eating food | starves → death |
| **Thirst** | time, heat | drinking water | dehydrates → death |
| **Warmth** | cold weather, night, water/snow exposure | shelter, fire, clothing(?) | freezes → death |
| **Body integrity** | lost cells from hits, fire, drowning, falls, burial | partial regen over time/food(?); lost limbs don't regrow | death when head/core destroyed |

> A survivor whose need crosses a threshold **auto-overrides** their assigned role to self-preserve (seek food/water/shelter, flee fire, dig out of burial). This is the "they retreat to a shelter when too cold" behaviour generalized — it keeps the player from micromanaging survival basics and makes the colony feel alive.

### 6.2 Roles (the "Lemmings" assignment layer)

The player assigns roles to **individual** survivors. Unlike Lemmings, the constraint isn't a fixed ability count — it's **resources and tools**. You can assign a role to anyone, provided the colony has the required tool (or can craft it).

| Role | Job | Requires (tool) | Output |
|---|---|---|---|
| **Digger (down-diagonal)** | tunnels diagonally down a set distance *or* until hitting ore/stone | shovel (wood→iron) | access to depth, exposes ore |
| **Digger (up-diagonal)** | tunnels diagonally up | shovel | ramps, escape routes |
| **Miner** | mines stone & ore | pickaxe (wood→iron) | stone, ore/iron |
| **Lumberjack** | fells trees | axe (wood→iron) | wood |
| **Fisherman** | fishes at water | fishing rod / spear | food |
| **Forager** | gathers from bushes/plants | none / basket | food |
| **Builder / Hauler** | places & carries materials, builds structures | hammer(?) | structures |
| **Guard** | patrols/holds a point, fights zombies | any weapon | defense |

**Assignment rules:**
- A role is only assignable if the required tool exists or can be auto-crafted from stockpile (player can also pre-queue craft → assign).
- Digging changes the **grid** in real time, so sand/water can pour into a fresh tunnel — diggers can flood or bury themselves or others. This is intended emergent risk.
- Roles can be **upgraded** once iron is available (wood tool → iron tool → faster work, more durability, stronger combat).

### 6.3 Tools & crafting

- Tools are **breakable** and have durability; wooden tools are brittle, iron tools are durable.
- **Tiers:** Wood (cheap, weak, brittle) → Iron (expensive, strong, durable). *(Optional middle tier: stone tools.)*
- **Weapons** are tools too: spear, axe (doubles as weapon), club, and at iron tier potentially **guns** (limited ammo from iron/ore?). Wooden weapons shatter quickly; iron weapons last.
- **Crafting** consumes resources and (optionally) requires a workstation built from wood/stone.

> **Open design question:** guns are a big power spike and change the feel. Consider gating them behind a rare resource or making ammo scarce so melee stays relevant. See §13.

---

## 7. Zombies

### 7.1 Spawning & movement

- Spawn from **one or both map edges** in **waves** of escalating size/frequency (tower-defense pacing). Optionally a day/night cycle where nights are worse.
- **Idle state:** meander randomly, slow. **Herd behaviour:** a zombie near others biases its drift toward the herd → natural clumping and "follow the crowd."
- **Detection:** when a survivor enters a zombie's sense radius (sight/sound), the zombie enters **attack state** → moves toward the target, **slightly faster** than idle.
- Zombies path over the simulated terrain (climb gentle slopes, fall, get funneled). Walls and fences **slow** them but don't stop them — they breach (§7.4). They **pass through trees/foliage** like all characters (§9), so woodland is concealment, not a barrier.

### 7.2 Damage model (emergent, cellular)

Under the hybrid model (§5.1), a hit doesn't subtract from a hit-table — it **releases that body region's pixels into the live cellular sim** and tells the rig what it just lost. The body then responds to what's left:

| What's destroyed | Emergent effect |
|---|---|
| **Head** region | body fully dissolves into falling cells → death |
| **Leg** region | leg pixels drop as cells, rig disables that limb → crawls (much slower) or topples |
| **Arm** region | arm pixels drop, loses that arm's reach → can't attack from that side |
| **Torso** region | bleeds, weakens; enough loss triggers full disintegration |

- Weapon choice and positioning matter for real: a guard with a spear at a chokepoint can aim low and **leg the front rank** to slow a herd, or a gun can pop heads at range.
- **Severed parts are just loose body cells** — they fall, settle, bleed, and can burn. Gore is emergent and effectively free; keep body resolution low so it stays cheap.
- The same model applies to **survivors** — they can lose limbs too, which raises the stakes of every fight.

### 7.3 Vulnerabilities

- **Fire:** flesh is flammable — ignite the ground/oil under a herd and it spreads body-to-body. Burning zombies ignite others *and* your structures. High-risk, high-reward crowd control.
- **Terrain:** buried by collapsing sand, drowned in water (head submerged), dropped down a dug pit, crushed.
- **Structures as attrition:** walls and fences don't stop zombies forever — they **gnaw and smash through** (see §7.4). Defenses buy *time*, not safety.

### 7.4 Breaking through structures

Because solid structure cells have **integrity** (§8), a zombie blocked by a wall or fence attacks it instead of stopping:

- Each tick a blocked zombie has a chance to **chip integrity** from the cell in front of it; when integrity hits zero the cell is destroyed and the body pushes in.
- **Pressure scales with numbers:** the more zombies piling on one spot, the faster it falls — hordes naturally concentrate on weak points and breach them.
- **Material matters:** wooden fences have low integrity (and can simply be *burned* through); stone walls have high integrity and take a long, loud time to breach — long enough to mount a defense.
- **Emergent trap:** a horde clawing at a wall built over an undermined sand pocket can collapse the ground out from under itself.

---

## 8. Building & Player Direct Manipulation

Two ways the player shapes the world:

1. **Indirect (via roles):** survivors gather and build assigned structures over time.
2. **Direct (falling-sand style):** the player can **drop / place** gathered materials directly into the grid (sand, stone, wood, water) and **ignite** flammables. This is the "powder game" toy verb — instant terraforming and trap-laying, limited by stockpile.

**Structures** (every solid structure cell has an **integrity** value that zombies, fire and erosion chip away — see §7.4):
- **Fences (wood):** cheap, low integrity, flammable. Slow zombies briefly; quickly smashed or burned through. Good for funneling, not for holding.
- **Walls (stone):** high integrity, slow to breach, can't be passed until broken — but stone is slower to gather. The backbone of a real defense.
- **Shelter:** enclosed space that provides warmth and a retreat point; required to survive cold weather/night. Also needs to actually *hold* against breaching.
- **Fire / campfire:** warmth source + light + weapon ingredient; must manage spread (it'll happily eat your own wooden walls).
- **Traps (emergent):** dug pits, water moats, sand-collapse triggers, oil-and-spark fire traps, kill-zones behind a deliberately weak wall segment.

---

## 9. Ecology (Trees, Bushes, Growth)

- **Characters pass through trees and foliage.** Plant material is permeable to bodies (§5.2) — survivors and zombies walk straight through woodland. Trees are **concealment and fuel, not cover**: they can break a zombie's line of sight (hide survivors in the woods) and they burn fiercely.
- **Trees & bushes grow over time** and **reproduce** (drop seeds → new saplings on suitable soil).
- **Water accelerates growth**; drought/snow slows or kills plants.
- This creates a **renewable but manageable** wood/food supply — clear-cutting a forest has consequences; tending it pays off.
- Foragers harvest bushes; lumberjacks fell trees (passing through them to chop is fine — collision and harvesting are separate). Soft pressure toward not stripping the forest to zero.

> **Design lever (open):** trees are permeable to *all* characters by default. Making them permeable to **survivors only** would turn woodland into an escape route the horde can't follow — a strong asymmetric mechanic. Flagged in §15.

---

## 10. Weather & Temperature

- **Weather states:** clear, rain, snow (and transitions). Possibly wind affecting fire/smoke direction.
- **Rain:** fills water, grows plants, **douses fire**, can cause flooding/erosion of loose grains.
- **Snow:** accumulates as snow cells, drops temperature sharply, can bury/insulate.
- **Temperature** drives the **Warmth** need. Below a threshold, exposed survivors lose warmth → seek shelter/fire → freeze if neither available.
- **Day/night** (optional but recommended): nights are colder and zombie-heavier, giving a natural rhythm of "prepare by day, survive by night."

---

## 11. Win / Loss & Modes

**Loss:** all survivors dead.

**Win conditions (pick per level/mode):**
- **Survive N waves / N days.**
- **Reach a population / infrastructure milestone** (e.g., build a fortified shelter, mine X iron).
- **Escort/extraction:** guide survivors to an exit point (most Lemmings-like).

**Modes:**
- **Campaign / handcrafted levels** with set objectives and escalating mechanics (good for teaching systems one at a time).
- **Sandbox / endless** with rising difficulty, for the toy-physics crowd.
- **Challenge seeds** with modifiers (harsh winter, dual hordes, scarce water).

---

## 12. UI / UX, Camera & Controls

### 12.1 Camera — the world is wider than the screen

The world is **larger than the viewport and scrolls horizontally** (this resolves the old "map scale" open question in favour of a wide, scrolling world). The player **freely pans** left/right across the map — this is not a follow-cam, since survivors and threats are spread across the width.

- **Horizontal scroll is the primary navigation.** The world width is several screens wide.
- **Vertical:** depth (digging down to ore, the water table) should fit the viewport height where possible; if the world is taller than the screen, the camera also scrolls vertically — the camera is written generically so this is a free addition (see §15).
- **Zoom (optional):** pinch / scroll-wheel zoom out for an overview, in for precise placement.
- **Off-screen awareness:** because the zombie edge and parts of the colony are often off-screen, **edge indicators** (incoming herd this way →) and a small **minimap/strip** are important, not optional polish.

### 12.2 Core UI

- **Role-assignment UI:** select a survivor → menu of available roles (greyed out if no tool). Lemmings-style toolbar of role "stamps" is an alternative.
- **Material/place tools:** a palette of stockpiled materials to drop/place/ignite (falling-sand toolbox), quantity tied to stockpile.
- **Information overlays:** needs bars over survivors, threat/edge indicators, stockpile readout, temperature/weather indicator.
- **Speed controls:** pause + speed-up are essential given the simulation; pausing to assign roles is expected.

### 12.3 Input — desktop and touch (mobile is a first-class target)

Input is built **pointer-first** (unified mouse/touch/pen) so the same UI works on both. The core design tension on touch is **pan vs. act** — dragging must not both scroll the camera *and* paint sand. Resolution:

- **Tool/mode system:** a "Pan" mode (drag scrolls) vs. action modes (Place / Ignite / Assign). The currently selected tool defines what a drag does. A persistent, thumb-reachable toolbar switches modes.
- **Alternative gesture split:** one-finger drag = act with current tool; **two-finger drag = pan; pinch = zoom.** (Pick one scheme and stay consistent.)
- **Tap** = select survivor / assign / place a single cell. **Long-press** = context menu (e.g. role list).
- Desktop keeps mouse paint + keyboard shortcuts + edge/WASD scroll as conveniences over the same actions.

### 12.4 Mobile considerations

- **Landscape-first.** A horizontally-scrolling world wants landscape; prompt to rotate in portrait.
- **Touch-sized targets.** Big, thumb-reachable controls; don't rely on hover or pixel-precise clicks. Selecting a single survivor in a crowd needs a forgiving hit area / tap-to-cycle.
- **Responsive canvas** sized to the device, honouring `devicePixelRatio` — but keep **cells chunky** so the simulated grid stays small and cheap regardless of screen density.
- **Performance budget is set by the weakest target phone, not the dev machine** — see §13. This is the main reason chunked simulation and capped horde sizes matter.

> **UX priority:** the player must *read* the simulation at a glance — what's flooding, burning, collapsing, where the herd is, and what's happening off-screen. Clarity beats fidelity, especially on a small screen.

---

## 13. Technical Considerations & Risks

| Area | Risk | Mitigation |
|---|---|---|
| **Character locomotion** | Walking reliably over jagged, destructible terrain. | **Largely de-risked by the hybrid (§5.1):** alive bodies are rigged pixel sprites using standard, cheap character locomotion — not deformable soft-bodies. Free-form cellular-body locomotion is pushed to a post-MVP stretch, off the critical path. |
| **Damage→cells handoff** | The moment of releasing a body region's pixels into the live sim (and disabling the rig) must look seamless and stay cheap. | Bodies rendered at world-cell resolution so released pixels are visually identical to sim cells; release only the affected region, not the whole body, except on death; cap simultaneous death-dissolves. |
| **Body simulation cost** | Many bodies, plus their released-cell debris, every tick. | **Low-resolution chunky bodies** (also the art style); cap concurrent zombies; LOD for distant/idle bodies; fade/settle gore cells over time so debris doesn't accumulate forever; pooling. |
| **Pathfinding on mutable terrain** | Paths invalidate constantly as terrain changes. | Coarse navgrid for routing + local steering; invalidate paths only on *local* edits near the path, not globally; rigged bodies path as points, which is far simpler than soft bodies. |
| **Cellular sim performance (world)** | Cellular automata over a large grid is heavy. | Chunked/active-region updates (only simulate dirty chunks), multithreading, cap grid resolution (this is the proven Noita approach — see Appendix B). |
| **Mobile performance** | The sim must hit framerate on a mid-range phone, not just the dev machine. | Keep cells chunky (small grid); only ever simulate **active chunks** and only render the **visible window**; cap concurrent zombies and gore debris; budget against a real low-end target device early. |
| **Fire runaway** | Fire trivially burns everything — flesh, foliage, and your own base. | Tunable spread/fuel, rain/water counters, fire as a deliberate risk the player learns to respect. |
| **Gun power spike** | Iron-tier guns trivialize combat | Scarce ammo, accuracy/jam mechanics, or cut/gate guns; keep melee + terrain central. |
| **Difficulty legibility** | Emergent systems can feel unfair/random | Telegraph waves, weather, and hazards; pause-friendly; clear feedback for every death cause. |

**Suggested tech stack candidates:** the cellular world sim wants custom, data-oriented code (C++/Rust, or a heavily data-oriented Godot/Unity setup), per-cell and per-tick, with chunked multithreading. The hybrid characters can ride on the engine's normal sprite/skeletal animation, only touching the sim at the damage→cells handoff — which keeps them far cheaper than fully simulated bodies. *(First prototype = Milestone 0 below.)*

---

## 14. Scope & Roadmap

### MVP (prove the fun)
The smallest build that tests whether the core loop is fun. **The MVP uses the hybrid character model (§5.1), not full cellular soft-bodies.**

- **Milestone 0 (make-or-break) — one hybrid survivor:** a chunky **pixel-art body rigged to a simple skeleton**, drawn at the *same pixel resolution as world cells* so it reads as part of the cellular world. It must:
  - walk, climb gentle slopes, and fall using ordinary rigged-character locomotion (cheap, reliable);
  - take a hit and **release that region's pixels into the live cellular sim** as flesh/bone/blood cells that fall, pile and bleed;
  - **lose a leg → collapse to a crawl** (limb pixels drop, rig disables the limb);
  - **catch fire** (flesh pixels become flammable cells and spread) and **dissolve fully into cells on death** (the Vagabond death-collapse, Appendix B);
  - react to being buried by sand / submerged in water.
  - *Success test:* the handoff from "sprite" to "loose cells" is seamless and cheap, and players can't tell the body wasn't "real" CA. If this illusion holds and runs fast, the architecture is proven.
- **Art direction is load-bearing here:** all characters use a **very coarse pixel style at world-cell resolution** — this is what makes rigged sprites read as cellular automata (the illusion described in §5.1). It is a design requirement, not polish.
- Cellular world with: sand, dirt, stone, ore, water, wood (with integrity), foliage (permeable), fire.
- Survivors with Hunger + Thirst needs and 3 roles: **Miner, Lumberjack, Forager** + **Guard**.
- Wood-tier tools only; one weapon.
- Zombies: spawn from one edge, meander + detect + attack, **emergent cellular damage** (head/leg via the pixel-release model), fire-vulnerable, **breach a wooden fence**.
- Player can drop/place materials and ignite fire.
- Win = survive N waves; loss = all dead.
- One procedurally generated map.

### Vertical slice (prove the feel)
- Add Diggers (up/down), Fisherman, Builder/Hauler.
- Iron tier + tool upgrades; durability.
- Shelter + Warmth need + basic weather (rain).
- Herd behaviour; dual-edge spawns.
- Ecology: tree growth + reproduction.

### Beyond
- Snow/full weather + day/night, campaign levels, guns (if kept), challenge seeds, polish/audio/art pass.

---

## 15. Open Questions

1. **Body resolution & locomotion model:** how chunky are bodies (fewer cells = cheaper, more readable, easier to control)? And how structured is the skeleton — a simple few-bone rig (recommended, tractable) vs. a freer soft-body blob (more emergent, much riskier)?
2. **Trees permeable to whom?** All characters (default), or **survivors only** — making woodland an escape route the horde can't follow? Strong asymmetric lever (§9).
3. **Guns:** in or out? If in, how scarce is ammo and what's the fantasy?
4. **Direct placement vs. earned resources:** can the player place *any* material freely, or only what survivors have stockpiled? (Recommend: only stockpiled, to keep scarcity meaningful.)
5. **Map scale:** ✅ *Resolved — wide, horizontally-scrolling world (§12.1), mobile-friendly.* Remaining sub-question: does the world also **scroll vertically** (deeper digging, taller worlds), or is depth capped to fit the viewport height?
6. **Permadeath of named survivors** with personalities (RimWorld-style attachment), or anonymous interchangeable units (Lemmings-style)? Losing a limb-damaged-but-alive survivor is a strong emotional beat either way.
7. **Failure cascades:** how punishing should one bad decision be? Where's the line between "emergent drama" and "feels unfair"?

---

## Appendix A — Glossary

- **Cell / grain:** one unit of the cellular world — the stuff the world (and character debris) is made of.
- **Hybrid body:** a survivor or zombie — a rigged pixel-art sprite while alive that releases real cells when damaged and dissolves into the sim on death (§5.1). The MVP model.
- **Damage→cells handoff:** the moment a hit converts a body region's pixels into live simulated cells.
- **Death-collapse:** a dead body disintegrating into falling cells (the Vagabond trick, Appendix B).
- **Cellular soft-body:** the post-MVP stretch where a living body is itself simulated cells bound by constraints (Lenia-style, Appendix B).
- **Skeleton / rig:** the bones that drive a hybrid body's animation and locomotion.
- **Integrity:** a structure cell's resistance to being broken (by zombies, fire, erosion).
- **Permeable:** a material bodies can pass through (foliage), even though it still blocks fluids/acts as fuel.
- **Role / job:** a behaviour assigned to a survivor by the player.
- **Tier:** tool quality level (Wood → Iron).
- **Wave:** a timed batch of incoming zombies.
- **Herd:** a clustered group of zombies moving together.

---

## Appendix B — Prior Art & References

How other projects have handled "characters made of cellular automata," and what each teaches this design.

### Games — CA world, characters ride on top (the pragmatic camp)

- **Noita** / *Falling Everything* engine (Nolla Games). Every pixel of the world is a simulated material — the developer calls it essentially complex cellular automata — but characters and loose objects are **rigid bodies (Box2D)**, with outlines extracted from the pixels via marching squares. The world is updated bottom-up in 64×64 chunks with dirty-rects and a checkerboard multithreading pattern. **Most relevant lesson:** co-founder Petri Purho's *original* dream was literally ours — ragdoll zombies you shoot the legs off and watch crawl toward you — but he later cautioned that fully physically-simulated (IK) choppable limbs become cumbersome in practice (enemies stumbling over each other): fun to watch, weak as opponents. This is the single strongest argument for our **hybrid** over full soft-bodies.
  - https://noitagame.com/ · https://en.wikipedia.org/wiki/Noita_(video_game) · https://www.gamedeveloper.com/game-platforms/road-to-the-igf-nolla-games-i-noita-i- · https://80.lv/articles/noita-a-game-based-on-falling-sand-simulation
- **The Powder Toy** — a falling-sand sim with a controllable **stickman (STKM)** that walks inside the powder. Like Noita, a figure *interacting with* cells, not built from them. https://powdertoy.co.uk/

### Hybrid — sprite alive, CA on death (the trick we're using)

- **Vagabond** (pvigier) — monsters are normal sprites in life; on death their **non-transparent pixels are treated as falling-sand grains** and collapse into a pile (a small 3D-layered automaton for nicer depth). This is the exact "release pixels into the sim on damage/death" mechanic our Milestone 0 is built around. https://pvigier.github.io/2020/12/12/procedural-death-animation-with-falling-sand-automata.html

### Artificial life — creatures that genuinely ARE cells (the stretch-goal camp)

- **Lenia** (Bert Wang-Chak Chan) — a continuous generalization of Conway's Game of Life whose emergent patterns are catalogued as 400+ "lifeform" species showing locomotion, self-organization and self-repair. Proves cell-made creatures *can* move and heal — but they're not directable, which is why this is our post-MVP research stretch, not the MVP. Live demo: https://chakazul.github.io/Lenia/JavaScript/Lenia.html · paper: https://arxiv.org/abs/1812.05433
- **Flow-Lenia** (2022–2025) — a mass-conservative extension where creatures' mass constantly drains and they must **eat food to avoid vanishing**, and where multiple species with different rules can coexist in one world. A striking parallel to our hunger system, emerging straight from the automaton. https://arxiv.org/abs/2212.07906 · https://sites.google.com/view/flowlenia/
- **Conway's Game of Life** — gliders/spaceships are the original "characters made of cells," and the ancestor Lenia smooths out.

### One-line takeaways

1. Simulate the **world** as CA (Noita's chunked, multithreaded approach is the proven recipe).
2. Keep **living characters** rigged and cheap; only touch the sim at the **damage→cells handoff** (Vagabond).
3. Render bodies at **world-cell resolution** so the seams between sprite and cells disappear.
4. Treat **fully cellular creatures** (Lenia) as a research stretch, never an MVP dependency.
