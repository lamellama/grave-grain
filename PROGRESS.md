# PROGRESS.md — Gravegrain build log

State pointer for the autonomous run. The **orchestrator** (main Pi session) owns this file: it records the current phase, per-task attempt counts, what passed, and any blockers. On restart, resume from here.

See `AGENTS.md` → *Autonomous run & escalation protocol* for the rules this log enforces.

---

## Current state

- **Current phase:** Phase 2 — Materials, fire, interactions, integrity
- **Status:** not started (Phase 1 complete & committed)
- **Last passed Done-when:** Phase 1 — sand piles, water seeks level, stone holds, density swap (sand sinks through water), pan-vs-paint toolbar, pause/step; planner-verified PASS, TS-strict build + dev server (HTTP 200) green
- **Carry-forward (Phase 10):** renderer builds a CSS-px ImageData while main.ts does ctx.scale(dpr); putImageData ignores the transform, so on dpr>1 the world draws into a corner. Fix in Phase 10 (devicePixelRatio render path).
- **THE GATE:** not reached (locked — Phases 0–4 must pass before any Phase 5+ work)
- **Run mode:** unattended / set-and-forget

---

## Phase checklist

- [x] Phase 0 — Scaffold, render loop & camera
- [x] Phase 1 — Falling-sand core
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
- [ ] Phase 11 — Performance & feel pass

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

---

## Blockers

_(none)_

---

## Commit log (phase boundaries)

Phase 0 — commit 8972036.
Phase 1 — see commit below (includes toolchain recovery: pnpm + TOOLING.md).
