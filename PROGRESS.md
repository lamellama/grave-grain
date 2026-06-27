# PROGRESS.md — Gravegrain build log

State pointer for the autonomous run. The **orchestrator** (main Pi session) owns this file: it records the current phase, per-task attempt counts, what passed, and any blockers. On restart, resume from here.

See `AGENTS.md` → *Autonomous run & escalation protocol* for the rules this log enforces.

---

## Current state

- **🎉 THE MVP IS COMPLETE** (Phases 0–11 all done, planner-verified). Phase 11: 11-1 deterministic RNG, 11-2 chunked/dirty-rect sim (byte-identical), 11-3 LOD+gore settle, 11-4 breach feedback, 11-5 role outfits, 11-6 react-earlier-needs, 11-7 balance+juice — all ✅ & committed.
- **Current work:** post-MVP **Authorized backlog** (user greenlit). ✅ DONE so far: (a) revised death model (extreme→dissolve / quiet→corpse / bite→turn); (b) zombie ladder-climb; (c) plant-a-seed foliage growth (deterministic/chunk-safe); (d) **Warmth + camp vertical slice** (warmth need + roof-based open shelter + fire-warmth + cold-start camp; survivors warm under a roof, leave for water, freeze→corpse if stranded); (e) **✅ Cooperative base-building (Builder/Hauler, GDD §6.2/§8) — COMPLETE & playable end-to-end.** BQ-1 queue module + BQ-2 builder role/hammer/menu + BQ-3 builder construction loop (claim→walk→build→atomic stockpile spend, 6/6) + CB-4 Plan tool (tap-queue/cancel, drag add-only, 9/9) + CB-5 blueprint overlay render (translucent ghosts, reserved=opaque, ctx-only invariant-safe, 9/9) + CB-6 live-loop integration (resetQueue on world init, e2e plan→assign→build through main path, 16/16). MVP simplification: no physical material-hauling sim — atomic stockpile spend satisfies §6.2 for this slice. **NEXT: GDD §14 Beyond** (Diggers/Fisherman roles, iron tier, herd dynamics, dual-edge spawns, tree reproduction, day/night, weather — prioritize with user). All invariants (GATE, chunk byte-equivalence, win/lose, no-tunnel, ImageData==backing) green throughout.
- **Stale-test fixed this session:** `test/p4-t5.test.ts` (GATE point 4) asserted the PRE-revision drowning behaviour (full cell-dissolve). The authorized death-model revision deliberately made drowning a QUIET death → prone corpse (`layDownCorpse`, GDD §5.1; bones stay whole). Refreshed the assertion to `corpse===true && !allBonesDestroyed` — ALL PASS. (Confirmed not a CB regression: test passed at MVP-complete d7a8be9, broke only after death-model 461c3cd+.) Commit 86ed400.
- **USER AUTHORIZATION (this session):** after the MVP, **continue with ALL deferred + added tasks** (the vertical-slice tier is now greenlit). See “Authorized backlog” below and the PLAN.md “Deferred” + playtest sections.
- **NOTE:** GDD was revised externally (commit 6af1cbf — death model: extreme→dissolve, quiet→corpse, bite→turn). Re-read GDD §5.1/§7 before building the death/turn work; it may add a ‘bitten survivor turns into a zombie’ mechanic to the backlog.

## GDD §14 Beyond — user-chosen order (this session)

Tackle in THIS order (user-prioritized): **1. Weather (§10) → 2. Tree reproduction (§9) → 3. Herd dynamics (§7.1) → 4. Diggers/Fisherman roles (§6.2) → 5. Iron tools (§6.3) → 6. Dual-edge spawns (§7.1).** Same loop per item: planner decomposes → route per policy → verify Done-when → commit per item. Re-read the named GDD § each item. Keep all invariants green (GATE, chunk byte-equivalence, win/lose, no-tunnel, ImageData==backing).

- **Weather context for the planner:** the Warmth slice already ships a WARMTH need driven by a GLOBAL `AMBIENT_COLD=true` flag (always cold). config.ts comments explicitly DEFER "§10 ambient temperature fields + day/night cycles" to "a later warmth task" — weather is that task. Weather should make ambient temperature/conditions DYNAMIC (clear/rain/snow), add rain (fills water, douses fire, grows plants), snow (accumulation cells, sharper cold), and feed the existing WARMTH need — NOT rebuild warmth. New SNOW material + rain/fire/plant interactions = sim-correctness → expensive_coder for the core.

## Authorized backlog (post-MVP — do after Phase 11, in roughly this order)

1. **Finish Phase 11:** 11-5 role outfits, 11-6 react-earlier needs, 11-7 balance/juice. (cheap)
2. **Bite-to-turn death model (NEW, GDD 6af1cbf):** re-read revised GDD §5.1/§7; implement extreme-damage→dissolve / quiet-death→corpse / bite→survivor turns zombie. (expensive — touches damage/zombie/survivor.)
3. **Zombie ladder-climb (v0.5 #A):** crowded zombies use each other as standable ground to climb walls; keep no-tunnel + perf cap. (expensive — zombie AI/locomotion, Phase-7 follow-up.)
4. **Plant-a-seed foliage growth (v0.6 #G):** SAPLING material the player plants → grows into FOLIAGE over GROW_TICKS on soil; replace free Foliage paint with a Plant tool. (expensive — new sim rule.)
5. **Vertical slice — Warmth + camp (deferred):** Warmth need + temperature + fire-as-warmth + Shelter structure (GDD §6.1/§10/§8). (expensive, multi-task.)
6. **Vertical slice — cooperative base-building:** survivor-driven construction / Builder-Hauler role (GDD §6.2). (expensive, multi-task.)
7. **Further vertical-slice/Beyond (GDD §14):** Diggers/Fisherman roles, iron tool tier + upgrades, herd dynamics, dual-edge spawns, tree reproduction, day/night, weather — prioritize with the user.

_Process for the backlog: same loop — planner decomposes each item into testable tasks; route per policy; verify Done-when; commit per item. Re-read the (revised) GDD sections each item names. THE GATE stays cleared; keep regression suites + smoke green._
- **Last passed Done-when:** Phase 10 — landscape prompt + touch-sized UI + pinch/wheel zoom (correct screen↔world, no hi-DPI regression) + tap/drag/long-press + long-press/right-click role menu + tap-to-cycle + responsive resize + gore/zombie perf caps. Planner-verified PASS; Phases 3–9 not regressed. MANUAL on-device framerate check still recommended.
- **Phase 11 should fold in the deferred playtest items:** v0.5 #C breach VISUAL feedback (crack/darken cells by integrity), v0.5 #D wave pacing (done), v0.6 #E role outfits (tint body by role for readability), v0.5 #B ammo (done), in-scope 'react earlier to needs' sliver, plus chunking/LOD/juice/balance. Deferred vertical-slice (camp/shelter/warmth, cooperative building, plant-a-seed growth) stays OUT unless authorised.
- **v0.4b playtest patches (committed, between Phase 9 and 10):** hi-DPI viewport corner FIXED (render CSS px); blank-view/empty-sky FIXED (vertical surface framing + horizontal center on colony); zombies-don't-move FIXED (idle drift toward colony, idle speed 0.12→0.2); zombies-buried-at-edge FIXED (spawn inset + on actual surface); sand/dirt-stratify FIXED (powders only displace AIR/fluid). Commits e777873, eabd9b1, 6371130, 590931e, d0b1bf3.
- **SCOPE DECISION (user):** continue per PLAN (finish MVP). Camp/shelter/Warmth/fire-warmth/cooperative-building DEFERRED to post-MVP vertical slice (logged in PLAN.md). In-scope 'react earlier to needs' sliver → Phase 11 balance.
- **Last passed Done-when:** Phase 9 — fresh seed plays the full loop on a layered procedural world; survivors forage/drink natural resources; escalating waves from one edge; win (survive 5 waves) / lose (all dead) with end screen; off-screen awareness (death-cause toasts w/ ←→, edge arrows, minimap, speed toggle). Planner-verified PASS, incl. all 7 v0.4 playtest fixes. Phases 3–8 not regressed.
- **GATE:** cleared. **Phase 10 carry-forwards / balance:** (a) ~~dpr putImageData corner bug~~ FIXED + ~~camera framed empty sky (world taller than viewport)~~ FIXED (both user-reported): render in CSS px (canvas backing=floor(rect.w/h), no dpr) so ImageData==backing; and clampCamera no longer pins y=0 — main frames camera vertically on the surface (spawnY ~30% down) after worldgen + on resize. Verified headless: ImageData fills canvas, 63% terrain in-frame. Later refinement: crisp-retina device-px render; optional vertical scroll input to view deep ore. (b) Balance: zombie spawn edge ~920 cells from colony → sparse early combat. (c) miner targets any exposed STONE/WALL — fine in worldgen (DIRT surface).
- **Playtest v0.4 fixes (all landed in Phase 9):** #1 death toasts+needs bars, #2 STEP_UP_MAX=2, #3 nearest-REACHABLE resource targeting, #4 generateWorld wired, #5 reachable ore, #6/#7 removed free Wood/Stone paint (build via costed/breachable Fence/Wall).
- **Last passed Done-when:** Phase 7 — zombies wander in from one edge, lock onto survivors, a guard legs the front rank then headshots crawlers, and a mob claws through a wooden fence (pursuit-driven breach in 155 ticks; pressure scales 2.25×). Damage uses the GATE handoff (real cells, no HP). Planner-verified (1 retry: fixed a breach mis-aim where the body's overhanging arm probed past a short fence). Build + smoke + dev green.
- **GATE:** cleared. Routing = normal policy.
- **Phase 8 note:** breaching is generic over hasIntegrity — stone WALLS placed in Phase 8 (with integrity) will be breachable by the same code unchanged. Keep walls tall enough OR rely on the per-row breach probe (now robust to short structures).
- **Stale-test note:** test/p7-t2.test.ts R2/R3 assertions are stale (written when updateZombie was movement-only; the now-wired adjacent-strike skews its pursuit-speed/monotonicity numbers). Not a production defect; refresh opportunistically.
- **Last passed Done-when:** Phase 6 — assign a lumberjack → walks THROUGH trees, chops for wood, returns to pile, axe breaks @5 chops; assignment gated by tool/stockpile. Planner-verified PASS; Phase 3/4/5 regression intact. (Also fixed a runtime bootstrap init-order bug + added a DOM-stub smoke-test guard.)
- **GATE:** cleared. Routing = normal policy. Phase 7 (zombie AI / combat / breaching) is core sim → expensive_coder.
- **Lesson:** HTTP-200 ≠ the page runs. Runtime DOM bootstrap is now guarded by test/main-smoke.test.ts — keep it passing; have coders run it when they touch main.ts/renderer/input.
- **Last passed Done-when:** Phase 5 — autonomous survivors wander, drink/eat at need thresholds (path adjacent to water/foliage, never into them), die via Phase-4 dissolve when no resource; A* on coarse navgrid + local-only path invalidation; no tunnelling. Planner-verified PASS. (Fixed a latent locomotion infinite-loop: horizontal flush now whole-cell threshold 1.)
- **GATE:** cleared (Phases 0–4). Routing = normal policy.
- **Phase 6 note:** wire FOLIAGE permeableToBodies (bodies walk THROUGH foliage; chopping is a separate harvest) — and fix the now-stale 'foliage is permeable' comment in main.ts/survivor.ts that currently contradicts the collide-and-path-adjacent behaviour.
- **Carry-forward (Phase 10):** renderer builds a CSS-px ImageData while main.ts does ctx.scale(dpr); putImageData ignores the transform, so on dpr>1 the world draws into a corner. Fix in Phase 10 (devicePixelRatio render path).
- **THE GATE:** not reached (locked — Phases 0–4 must pass before any Phase 5+ work)
- **Run mode:** unattended / set-and-forget

---

## Phase checklist

- [x] Phase 0 — Scaffold, render loop & camera
- [x] Phase 1 — Falling-sand core
- [x] Phase 2 — Materials, fire, interactions, integrity
- [x] Phase 3 — Hybrid body locomotion **(GATE part 1)**
- [x] Phase 4 — Damage→cells handoff **(GATE CLEARED ✅)**
- [x] Phase 5 — Survivors: needs + autonomy + pathing
- [x] Phase 6 — Roles, resources, wood-tier tools
- [x] Phase 7 — Zombies, combat, breaching
- [x] Phase 8 — Player building + fire-as-tool
- [x] Phase 9 — Worldgen, waves, win/lose, UI
- [x] Phase 10 — Mobile & touch polish
- [ ] Phase 1 — Falling-sand core
- [ ] Phase 2 — Materials, fire, interactions, integrity
- [ ] Phase 3 — Hybrid body locomotion **(GATE)**
- [ ] Phase 4 — Damage→cells handoff **(GATE)** ← prove the illusion before anything below
- [ ] Phase 5 — Survivors: needs + autonomy + pathing
- [ ] Phase 6 — Roles, resources, wood-tier tools
- [ ] Phase 7 — Zombies, combat, breaching
- [ ] Phase 8 — Player building + fire-as-tool
- [ ] Phase 9 — Worldgen, waves, win/lose, UI
- [ ] Phase 10 — Mobile & touch polish
- [x] Phase 11 — Performance & feel pass  — **MVP COMPLETE 🎉**

---

## Task log

Append one row per coder return. Format:

`<phase> · <task-id> · <route> · attempt N/2 · pass|fail · <one-line note>`

Escalations: when `cheap_coder` fails 2/2 (or a task is revealed to touch sim/GATE/perf), the orchestrator re-spawns on `expensive_coder` and continues the count there. After `expensive_coder` fails 2/2, write a `BLOCKED:` row and pause for review.

Phase 0 · planner · decomposed into p0-t1 (scaffold, gates all), t2 config, t3 grid, t4 camera, t5 renderer, t6 main loop, t7 input/pan — all routed cheap_coder.
ENV NOTE · cheap_coder's configured model `openai/gpt-5-codex` is NOT authed in this sandbox (spawns return 0 tool uses, no output — silent no-op, as KICKOFF warned). The per-spawn model override does NOT apply to custom agents (frontmatter wins), so I edited `.pi/agents/cheap_coder.md` to repoint its model to `anthropic/claude-haiku-4-5` (confirmed authed — Explore uses it). expensive_coder (opus) and planner (opus) work. Also: git absent from base VM image → installed via apk; git needs `export HOME=/workspace` (global config lives there).

Phase 0 · p0-t1 · cheap_coder(haiku) · attempt 1/1 · pass · Vite+TS-strict scaffold; npm build green.
Phase 0 · p0-t2..t7 · cheap_coder(haiku) · attempt 1/1 · pass · config, grid (2x Uint8Array), camera (clamp+round-trip), visible-window renderer (FPS,dpr), fixed-timestep loop (pause P, step ./]), pointer-first drag-pan (touch-action:none). Orchestrator fixed a pan-runaway bug in input.ts (anchor not reset on move). Build + dev-server (HTTP 200) verified.

ENV RECOVERY (mid-Phase-1) · A coder's `npm install` triggered the VM's broken global npm (truncated filenames in @sigstore, dropped rollup/esbuild musl binaries) — dev server crashed. Fix: installed standalone **pnpm** (persisted at `/workspace/.tooling/pnpm`, wrapper `/usr/local/bin/pnpm`), reinstalled deps with correct musl rollup/esbuild. Mount has no exec bit → rewrote package.json scripts to call binaries via `node ./node_modules/<pkg>/...`. Documented in `TOOLING.md`; added "never npm install" warnings to both coder agents. `npm run build`/`dev` work again.

Phase 1 · p1-t1 · cheap_coder(haiku) · 1/1 · pass · materials.ts (AIR/SAND/STONE/WATER table+helpers) + config densities/BRUSH_RADIUS/GRAVITY_STEPS.
Phase 1 · p1-t2 · cheap_coder(haiku) · 1/1 · pass · renderer palette from MATERIALS, pre-parsed RGB.
Phase 1 · p1-t3 · expensive_coder(opus) · 1/1 · pass · sand sim: bottom-up scan, scan-flip, angle of repose; headless 10/10 (mass-conserved, no tunnel, stable pile, no bias).
Phase 1 · p1-t4 · expensive_coder(opus) · 1/1 · pass · water seek-level + general density swap + explicit moved-guard; headless verified (water flattens, sand sinks, masses conserved, single-cell moves, 0.88ms/tick).
Phase 1 · p1-t5 · cheap_coder(haiku) · 1/1 · pass · pan-vs-paint toolbar (Pan/Sand/Stone/Water/Erase), brush disc, single Pointer-Events path. (Agent returned no summary but work landed; orchestrator verified.)
Phase 1 · VERIFY · planner · PASS · sim correctness + mode coherence + MVP scope confirmed; flagged dpr putImageData issue for Phase 10.

Phase 2 · p2-t1 · cheap_coder(haiku) · 1/1 · pass · MATERIALS extended to 11 (DIRT/ORE/WOOD/FOLIAGE/FIRE/SMOKE/ASH) + config densities/integrity; 11/11 headless.
Phase 2 · p2-t2 · cheap_coder(haiku) · 1/1 · pass · grid.placeMaterial seeds baseIntegrity; paint routed through it; 4/4 headless.
Phase 2 · p2-t3 · expensive_coder(opus) · 1/1 · pass · updateDirt (steeper via DIRT_SPILL_CHANCE) + updateAsh (inert powder); dirt footprint 77 < sand 79, mass conserved, no tunnel.
Phase 2 · p2-t4 · expensive_coder(opus) · 1/1 · pass · updateGas: SMOKE rises (meanY 229→169), ceiling blocks, dissipates in 176 ticks, no double-move (moved-guard for upward motion).
Phase 2 · p2-t5 · expensive_coder(opus) · 1/1 · pass · updateFire: lifetime in integrity slot, spread, →ash/smoke, full burnout (peak 396, ash 274, out by tick91).
Phase 2 · p2-t6 · expensive_coder(opus) · 1/1 · pass · reactions.ts water+fire→steam (watered dies in 1 tick vs 60); collapse via existing fall rule; shared ignite() helper. (Left a test/ harness — isolated, doesn't affect build.)
Phase 2 · p2-t7 · cheap_coder(haiku) · 1/1 · pass · toolbar Dirt/Wood/Foliage + Ignite tool via tryIgnite→ignite (flammable-only); 9/9 unit.
Phase 2 · VERIFY · planner · PASS · end-to-end burn+douse over real modules; MVP scope clean (no FLESH/BONE/BLOOD, no breaching/zombies, no Ice/Snow).

Phase 3 (GATE pt1) · p3-t1 · expensive_coder(opus) · 1/1 · pass · body.ts: Body/Bone/BodyPixel + createBody (52-px 6×12 humanoid, 6 bones, feet-centre anchor, unique cells); config seeds.
Phase 3 · p3-t2 · expensive_coder(opus) · 1/1 · pass · locomotion.ts ground-probe + swept fall + isSolidForBody; rests on floor/pit, no-tunnel every tick.
Phase 3 · p3-t3 · expensive_coder(opus) · 1/1 · pass · walk + step-up(≤STEP_UP_MAX) + wall-stop via xRemainder; climbs 1-cell step, stops at 3-cell wall, falls into pit; no-tunnel.
Phase 3 · p3-t4 · cheap_coder(haiku) · 1/1 · pass · renderer setBody + draw bone pixels at cell resolution; worldToScreen alignment === cell layer (pixel-perfect, camera-locked).
Phase 3 · p3-t5 · cheap_coder(haiku) · 1/1 · pass · main.ts wires createBody+setBody+updateBody (after sim.step); arrow driver + stall-flip pacer; test terrain (step+pit). (Agent returned no summary; work landed, orchestrator verified build+dev.)
Phase 3 · VERIFY · planner · PASS · full Done-when over real modules; no-tunnel held ~1500 ticks; alignment/illusion confirmed; MVP scope clean. THE GATE part 1 met.

Phase 4 (THE GATE) · p4-t1 · expensive_coder(opus) · 1/1 · pass · FLESH/BONE/BLOOD materials + BodyPixel.material; pixel colour from material; reactions key on WATER (blood douses nothing); 37 FLESH/15 BONE.
Phase 4 · p4-t2 · expensive_coder(opus) · 1/1 · pass · sim rules for FLESH/BONE (powderFall) + BLOOD (water-like); damage.ts releaseBone (floor never overwritten, cells fall/pile, idempotent).
Phase 4 · p4-t3 · expensive_coder(opus) · 1/1 · pass · applyDamage dispatch + dissolveBody; head→52/52 pile; leg/arm flags; torso threshold; displaceable narrowed to AIR|fluid (terrain never deleted).
Phase 4 · p4-t4 · expensive_coder(opus) · 1/1 · pass · crawl @CRAWL_SPEED (ratio 0.40), dead-body guard, no-tunnel 500t.
Phase 4 · p4-t5 · expensive_coder(opus) · 1/1 · pass · drown @DROWN_TICKS=180 (died tick179) + sand/dirt head-pin (0 vs 18); reactToEnvironment.
Phase 4 · p4-t6 · expensive_coder(opus) · attempt1 no-op (interrupted), attempt2/2 pass · FLESH burns like wood; living body catches fire (checkFire) & dissolves; no spurious ignition.
Phase 4 · p4-t7 · expensive_coder(opus) · 1/1 · pass · Shoot tool + pick.ts pickBone (DOM-free, unit-tested); setTargetBody; gate hand-runnable.
Phase 4 · VERIFY (THE GATE) · planner · PASS · all 5 points over real modules; zero illusion seam; 1.41ms/tick worst-case. ARCHITECTURE PROVEN — Phase 5 unlocked.

Phase 5 · p5-t1 · cheap_coder(haiku) · 1/1 · pass · 17 config seeds (needs/wander/nav).
Phase 5 · p5-t2 · expensive_coder(opus) · 1/1 · pass · navgrid.ts + pathfinding.ts: coarse A*, walkability w/ headroom, local-only isPathStale (on-path edit→stale, far edit→not).
Phase 5 · p5-t3 · expensive_coder(opus) · 1/1 · pass · survivor.ts needs deplete (exertion/heat) + bounded wander + death via dissolveBody. (Agent result lost on cleanup; orchestrator headless-verified: idle drop 6/9, wander maxDist 30, dies thirst@~6667.) ORCHESTRATOR FIX: diagnosed+fixed locomotion.ts horizontal-flush infinite loop (threshold 0.5 + whole-unit decrement oscillated at ±0.5 → changed to whole-cell threshold 1); Phase 3/4 regression re-run clean.
Phase 5 · p5-t4 · expensive_coder(opus) · 1/1 · pass · auto-override: fleeFire>seekWater>seekFood>wander; A* path adjacent to resource + local steering; restore on arrival (eat consumes foliage+markTerrainEdit); repaths on isPathStale. 5/5 incl. no-foliage-overlap, no-resource death, repath-on-edit.
Phase 5 · p5-t5 · cheap_coder(haiku) · 1/1 · pass · multi-body renderer (setBodies); main spawns 4 survivors, rebuildNavgrid at startup, updateSurvivor each; pacer retired. 4 survivors recover needs independently, no tunnel.
Phase 5 · VERIFY · planner · PASS · 17/17 end-to-end (wander/drink/eat/die + path locality + no-tunnel + dev no-hang); MVP scope clean; flagged stale foliage-permeable comment for Phase 6.

Phase 6 · p6-t1 · expensive_coder(opus) · 1/1 · pass · isSolidForBody honours permeableToBodies (bodies walk THROUGH foliage; fall through foliage-only columns); full Phase 2–5 suite regression green; fixed stale comments.
Phase 6 · p6-t2 · cheap_coder(haiku) · 1/1 · pass · resources.ts global stockpile {wood,stone,food,ore} add/canAfford/spend(atomic)/stockpilePoint; 24 assertions.
Phase 6 · p6-t3 · expensive_coder(opus) · 1/1 · pass · roles.ts: 4 roles, wood tools+durability(5)/break, canAssign/craftToolFor gating, findTarget (miner picks EXPOSED rock, skips buried); config seeds.
Phase 6 · p6-t4 · expensive_coder(opus) · 1/1 · pass · survivor.ts role loop find→path→work→deposit→repeat; needs override preempts then resumes; tool break→idle; lumberjack deposits wood, axe breaks @5 chops, miner mines stone; no-tunnel.
FIX · orchestrator · main.ts bootstrap init-order bug (user-reported blank screen + dead buttons + 'Renderer not initialized'): resizeCanvas()/getRenderer() ran before initRenderer()/initInput(). Reordered init before first resize. Added test/main-smoke.test.ts (DOM-stub) as a permanent runtime-bootstrap regression guard — catches the class of error HTTP-200/headless-module checks miss. Build+dev(HTTP 200) verified.
Phase 6 · p6-t5 · cheap_coder(haiku) · 1/1 · pass · Assign tool: tap survivor→role menu (greyed via canAssign), assignRole; stockpile HUD; main seeds forest + exposed stone/ORE + STARTING_WOOD + setStockpilePoint/setSurvivors. Smoke test still passes (init order intact).
Phase 6 · VERIFY · planner · PASS · end-to-end over real modules: gating both ways, walk-through-foliage (no STONE tunnel), chop→deposit (first @tick229), axe breaks @5 chops→idle; MVP scope clean; Phase 3/4/5 regression intact.

Phase 7 · p7-t1 · cheap_coder(haiku) · 1/1 · pass · 16 config seeds (sense/speeds/attack/breach/waves), emergent-damage note (no HP).
Phase 7 · p7-t2 · expensive_coder(opus) · 1/1 · pass · zombie.ts idle meander + detect→attack pursuit via navgrid + sub-cell speed gate; idle bounded, gap closes, no tunnel. (attack speed caps at WALK_SPEED — locomotion step fixed; acceptable.)
Phase 7 · p7-t3 · expensive_coder(opus) · 1/1 · pass · combat.ts (bodiesAdjacent/pickAttackRegion/meleeAttack→applyDamage); zombie strike releases real cells, cooldown respected, death via dissolve.
Phase 7 · p7-t4 · expensive_coder(opus) · 1/1 · pass · guard combat: legs intact zombie (@26)→crawl, headshots crawler (@71)→death; needs/fire override preempts; non-guards don't attack.
Phase 7 · p7-t5 · expensive_coder(opus) · attempt2/2 · pass · breaching.ts integrity chip + crowd pressure; FIXED breach mis-aim (per-row leading-edge probe vs overhanging arm) — pursuit mob breaches 4-tall fence @155t, n=4 2.25× faster, stone never chipped.
Phase 7 · p7-t6 · cheap_coder(haiku) · 1/1 · pass · waves.ts one-edge escalating staggered spawner (3→5), MAX_ZOMBIES cap.
Phase 7 · p7-t7 · expensive_coder(opus) · 1/1 · pass · main integration (step→updateZombie→updateSurvivor(zombies)→resolveBreaching→updateWaves), green-tint zombies, Shoot-hits-zombies, fence+guard scene; smoke test green.
Phase 7 · VERIFY · planner · FAIL·retry (breach mis-aim) → fixed → PASS · all 5 clauses over real modules (wander→lock, leg+headshot, fence breach pursuit-driven, GATE damage, no-tunnel); MVP scope clean; Phases 3–6 not regressed.

Phase 8 · 8-1 · expensive_coder(opus) · 1/1 · pass · WALL material (id14, integrity200, solid, non-flammable) + config (WALL/FENCE_INTEGRITY, costs, STARTING_STONE); raw STONE stays non-breachable.
Phase 8 · 8-2 · expensive_coder(opus) · 1/1 · pass · building.ts placeStructure (atomic inBounds→spend→placeMaterial→markTerrainEdit), canPlace/structureCost; scarcity + navgrid-bump verified.
Phase 8 · 8-3 · cheap_coder(haiku) · 1/1 · pass · toolbar Fence/Wall + input Build mode (single-cell drag = line); smoke test green.
Phase 8 · 8-4 · cheap_coder(haiku) · 1/1 · pass · main seeds STARTING_STONE; refreshBuildButtons greys unaffordable each frame (stub-safe); smoke green.
Phase 8 · 8-5 · cheap_coder(haiku) · 1/1 · pass · test/phase8-building.test.ts: scarcity, WALL chips vs raw STONE immune, fence breaches 3.14× faster than wall, fire spreads fence-to-fence. All 4 PASS.
Phase 8 · VERIFY · planner · PASS · wall-off chokepoint (path→null), fire trap catches herd body-to-body (3 zombies @staggered ticks, 1 died to fire), fence catches/wall doesn't, scarcity enforced; MVP clean; Phases 4–7 not regressed.

Phase 9 · 9-1 · cheap(haiku) · pass · 22 config seeds (worldgen/wave/win/speed).
Phase 9 · 9-2 · expensive(opus) · pass · worldgen.ts deterministic layered map + spawn-zone guarantees (mulberry32; foliage418/water234 near spawn, 920 from edge).
Phase 9 · 9-3 · cheap(haiku) · pass · waves curve (5 waves, sizes 3→11, intervals 1200→800) + allWavesCleared.
Phase 9 · 9-4 · cheap(haiku) · pass · state.ts win/lose latch + per-death cause watcher.
Phase 9 · 9-5 · cheap(haiku) · pass · ui.ts needs bars, death toasts, end screen, 1×/2×/3× speed.
Phase 9 · 9-6 · cheap(haiku) · pass · ui edge arrows + minimap + camera.jumpCameraTo + minimap-click jump (round-trip+clamp verified).
Phase 9 · PLAYTEST · orchestrator direct · #2 STEP_UP_MAX 1→2 (regressions pass); #6/#7 removed free Wood/Stone paint buttons (smoke green).
Phase 9 · 9-8 · expensive(opus) · pass · #3/#5 nearest-REACHABLE targeting (forage worldgen bush @65t, drink reachable pond not sealed, miner reaches ore); p5-t4/p6 regressions pass.
Phase 9 · 9-7 · expensive(opus) · pass · main integration: generateWorld+rebuildNavgrid, gameState loop (freeze on end), UI overlays, speed loop, direction death toasts; 4 survivors live 3000t, loss state reached; smoke+dev green.
Phase 9 · VERIFY · planner · PASS · full-loop win/lose + off-screen awareness + all 7 playtest fixes over real modules (layered world, forage/drink reachable, miner ore, climb-2/stop-4, WALL breached vs raw STONE immune, no free wood/stone paint); MVP clean; Phases 3–8 intact.

v0.4b/v0.5/v0.6 playtest patches (between phases, committed): hi-DPI corner; blank-view vertical framing + center-on-colony; zombies idle-drift + spawn-on-surface; sand/dirt no-stratify; limited ammo (STARTING_AMMO=15); wave pacing 1200→2400; Wood/Stone button relabel.
Phase 10 · 10-1/2 · cheap(haiku) · pass · landscape rotate prompt + touch-sized (≥44px) hover-free responsive toolbar.
Phase 10 · 10-3 · expensive(opus) · pass · camera.zoom (effectiveCellPx) + setZoom-about-anchor wired through screen↔world+renderer; ImageData==backing invariant kept; 95/0.
Phase 10 · 10-4 · cheap(haiku) · pass · pointer registry + classifyGesture (tap/drag/longpress); Shoot/Assign on tap; 6/6.
Phase 10 · 10-5 · cheap(haiku) · pass · pinch + wheel zoom; 2-finger suppresses tools; 12/12.
Phase 10 · 10-6 + #F · cheap(haiku) · pass · long-press + right-click role menu; pickCycling tap-to-cycle; 12/12.
Phase 10 · 10-7 · cheap(haiku) · pass · orientationchange resize; canvas==viewport invariant 20/20.
Phase 10 · 10-8 · expensive(opus) · pass · sweepGore caps loose debris @MAX_GORE_CELLS (never terrain); MAX_ZOMBIES=24; gore 10460→1500, p4 regressions pass.
Phase 10 · VERIFY · planner · PASS · all 6 p10 suites green; zoom/render-invariant/pinch/gore/ammo/tap-vs-hold confirmed; Phases 3–9 intact; on-device framerate = manual check.

---

Backlog · BQ-3 · expensive · pass · builder construction loop (claim→walk→build→placeStructure spend); resumed uncommitted WIP, 6/6 Done-when green. commit 048ef47.
Backlog · CB-4 · cheap · pass · Plan tool — tap queue/cancel blueprint, drag add-only (fixed toggle-flicker bug); 9/9 + bq3 regression. commit 8711b13.
Backlog · CB-5 · cheap · pass · blueprint overlay render (translucent ghosts, reserved=opaque, ctx-only after putImageData); 9/9 + all p10 render/smoke green. commit 1fd0721.
Backlog · CB-6 · expensive · pass · live-loop integration (resetQueue on world init; overlay+builder confirmed ticking); e2e plan→assign→build→spend via main path 16/16 + regressions. commit a576e25.
Backlog · CB-VERIFY · orchestrator · pass · cooperative base-building playable end-to-end; refreshed stale GATE test p4-t5 (death-model drowning→corpse), GATE green. commit 86ed400.

VS-1 Weather (GDD §10) · T1 · expensive · pass · SNOW material (id16) + §10 config seeds (states/temps/spawn rates); 40/40 + p2-t6. commit 284a7c2.
VS-1 Weather · T2 · expensive · pass · deterministic weather state machine (clear/rain/snow) + ambient temperature; seeded weatherRand, 30k-tick replay identical. commit e3674b0.
VS-1 Weather · T3 · expensive · pass · sky-spawn (rain→WATER/snow→SNOW) + fire douse/snow-melt; chunk byte-equiv held, rain douses 33×, snow no-tunnel. commit e882fb9.
VS-1 Weather · T4 · orchestrator direct · pass · wired warmth need + plant growth onto DYNAMIC weather: survivor cold gate AMBIENT_COLD→isAmbientColdNow() (engine/weather), sapling growth gains GROW_RAIN_SPEEDUP under rain (chunk-safe, global state). Refreshed 2 stale always-cold suites (p12-warmth, p12-seekwarmth) to pin SNOW via __setWeatherForTest. tsc strict clean; 9 suites green (weather ×3, p12-warmth/seekwarmth/warmthbar/grow, p11-chunk-equiv, p2-t6); seekwarmth 20/20 stable.

VS-1 Weather · T5 · orchestrator direct · pass · weather/temperature HUD readout (always-on top-right icon·label·N°) + config-driven precipitation overlay (sky-darken wash + rain streaks / drifting snow flecks via RAIN_STREAK_COLOR/SNOW_FLECK_COLOR/WEATHER_OVERLAY_DENSITY/WEATHER_SKY_DARKEN_*). Wall-clock animated, draw-time only (no sim/RNG/grid touch). tsc strict clean; weather-config/p9-ui/main-smoke/p11-chunk-equiv green; vite build OK. commit 7f9efb4. NOTE: resumed after prior cheap_coder stalled — 7 turns / 12 tool uses but 0 disk changes (looping failed edits).

## Blockers

_(none)_

---

## Commit log (phase boundaries)

Phase 0 — commit 8972036.
Phase 1 — commit de42b5c (includes toolchain recovery: pnpm + TOOLING.md).
Phase 2 — commit aca1595.
Phase 3 — commit fc9cd1e.
Phase 4 (THE GATE) — commit b798001.
Phase 5 — commit 9cc4ff2.
Phase 6 t1–t4 + bootstrap fix — commit 6c1d980.
Phase 6 (complete) — commit 611b814.
Phase 7 t1–t7 WIP — commit 8767e9a.
Phase 7 (complete) — commit 90f15c2.
Phase 8 (complete) — commit 1631561.
Phase 9 WIP — commit a0ae3ba; playtest #2/#6/#7 + PLAN — commit 644e32e.
Phase 9 (complete) — commit 8998254 (+ v0.4b/v0.5/v0.6 patches).
Phase 10 (complete) — see commit below.
VS-1 (Weather, complete) — T1–T5 pass; commit 7f9efb4 (T5). Weather cycles, rain douses fire, snow piles/melts, HUD shows weather+temp.
