# AGENTS.md — Gravegrain

Project context and working agreement for all Pi agents on this repo. Read this first, every session.

> **Two source-of-truth docs live alongside this file:**
> - `PLAN.md` — the **build order**: phases, tasks, *Done when* tests, config seeds, and which GDD sections each phase implements.
> - `GraveGrain_GDD.md` — the **behaviour spec**: how every system should work. When PLAN says *“Implements: §x”*, that GDD section is authoritative for behaviour.

Gravegrain is a browser falling-sand survival game: a Lemmings-style colony of pixel survivors defended against zombie hordes in a fully simulated, destructible cellular world. Characters use a **hybrid model** (rigged pixel sprites that shed real cells when damaged — GDD §5.1).

---

## Golden rules (non-negotiable)

1. **THE GATE.** Phases 0–4 prove the core illusion (a pixel body that reads as cellular automata and sheds real cells when hit — GDD §5.1, §14 Milestone 0). **No Phase 5+ work is authorized until Phase 4's gate test passes.** The orchestrator enforces this (with the planner refusing to plan past the gate).
2. **One phase at a time, in order.** Don't start a phase until the previous phase's *Done when* passes. Commit at every phase boundary.
3. **Stay inside MVP scope (GDD §14).** Do not build vertical-slice or “Beyond” features (Diggers/Fisherman/Builder roles, iron tier, weather/warmth, herd dynamics, dual-edge spawns, day/night, etc.). If a task drifts out of scope, stop and flag it.
4. **Data-oriented.** Cells live in flat typed arrays (`Uint8Array`), never per-cell objects (GDD §13). This is the entire performance story.
5. **All magic numbers go in `config.ts`.** Gravity, fire spread, hunger rate, wave size, integrity — one file, so balancing is a one-file job.
6. **Mobile is a first-class target.** Input is **pointer-first** (one path for mouse + touch); the camera exists from Phase 0 (world is wider than the screen — GDD §12.1). Test against a mid-range phone budget (GDD §12.4, §13).
7. **A task isn't done until its *Done when* passes.** Run it, report the result. No green check on a claim alone.
8. **Source files stay ASCII-only.** Code files under `src/` (comments included) must contain **no non-ASCII characters** — no section glyphs, em/en dashes, curly quotes, arrows, or math symbols (use `-`, `"`, `->`, `<=`, etc.; where a glyph must reach the runtime, use a `\u` escape such as `'\u2600'`). These chars are visual look-alikes of ASCII: a coder building an exact-match `Edit` anchor types the ASCII version, the match fails, and the agent loops forever on failed edits with **zero disk writes** (the classic "editing... forever" hang that stalled VS-2 T-A). The prose docs (`PLAN.md`, `GraveGrain_GDD.md`, `PROGRESS.md`) may keep their typography — this rule is for `src/` only. To check (BusyBox-safe): `LC_ALL=C grep -rc '[^ -~\t]' src` must report 0 on every file.

---

## Stack & layout

- **TypeScript + Vite + Canvas2D** (`ImageData`/`putImageData` for the cell layer, characters drawn on top). Pointer Events for input. No engine, no framework for the MVP.
- File layout and the per-file responsibilities are defined in `PLAN.md` (“Suggested file layout” + “Core data model”). Follow it; don't reorganize without reason.
- TS strict mode. Small, single-purpose functions. Where a function implements a specific GDD behaviour, reference it in a comment (e.g. `// GDD §7.4 breaching`).

---

## The agent team

**The orchestrator is the main Pi session** (you, driving Pi at the top level). It is the only thing that **spawns subagents**. Subagents run in isolated sessions and do not spawn further subagents, so all routing and delegation happens here, at the top. The orchestrator reads `PLAN.md`/`PROGRESS.md`, optionally calls `project-planner` to decompose the current phase, then spawns the routed coder for each task and verifies the result.

| Agent | Model | Role |
|---|---|---|
| **orchestrator** (main Pi session) | — | Drives the build. Spawns coders, applies the routing policy, verifies *Done when*, maintains `PROGRESS.md`, commits at phase boundaries. The only spawner. |
| `project-planner` | (your choice — strong reasoning) | **Advisory.** Reads `PLAN.md`/GDD, decomposes the current phase into small tasks, and returns a brief + routing recommendation + *Done when* for each. Can also verify a finished task on request. **Writes no code and spawns nothing** — it hands the plan back to the orchestrator. |
| `expensive_coder` | `anthropic/claude-opus-4-8` | Hard, correctness- and architecture-critical code. |
| `cheap_coder` | `openai/gpt-5-codex` | Routine, well-specified, pattern-following code. |

### Routing policy (the orchestrator decides per task; the planner recommends)

**Send to `expensive_coder` when the task is any of:**
- **THE GATE** — Phase 3 (hybrid body locomotion) and Phase 4 (damage→cells handoff).
- **Simulation correctness** — the falling-sand update, density/fluid rules, fire spread, material interactions (Phases 1–2).
- **Algorithms with subtle edge cases** — pathfinding on mutable terrain (Phase 5), zombie AI / combat / breaching (Phase 7), chunking & LOD (Phase 11).
- Anything **architecture-defining**, flagged *make-or-break*, or whose *Done when* is subtle or perf-sensitive.

**Send to `cheap_coder` when the task is any of:**
- **Scaffolding / boilerplate** — Vite setup, project wiring, `config.ts` plumbing (Phase 0).
- **UI wiring** — HUD, toolbar, role-assign menu, minimap, touch controls (Phases 9–10).
- **Repetitive additions that mirror an existing pattern** — e.g. adding a new material that copies an established one, glue code, tests, docs.

**Escalation:** if `cheap_coder` fails the *Done when* twice, or discovers the task touches sim correctness / performance / THE GATE, the orchestrator re-spawns it on `expensive_coder`. When unsure, default to `expensive_coder` for anything inside Phases 1–7 core systems, `cheap_coder` for everything peripheral.

---

## Workflow loop (per phase)

1. **Orchestrator** reads the current phase in `PLAN.md` + the GDD sections it names (from `PROGRESS.md`); confirms the previous phase's *Done when* passed.
2. **Orchestrator** gets the phase decomposed into small, independently testable tasks (ideally one file / one cohesive change each) — either directly, or by spawning `project-planner` to produce the breakdown + routing recommendations.
3. For each task, the **orchestrator** spawns the routed coder (`expensive_coder` / `cheap_coder`) with a brief containing:
   - **Goal** (one sentence)
   - **GDD refs** (exact §s) and **PLAN phase**
   - **Files to touch**
   - **Config seeds** to add to `config.ts`
   - **Done when** (the testable outcome)
4. **Coder** reads the named sections, implements within MVP scope, **runs the Done-when**, reports pass/fail + what it did.
5. **Orchestrator** verifies (optionally re-invoking `project-planner` to check the result); on fail, re-spawns the coder with specifics or escalates; on pass, moves to the next task.
6. At phase end, the orchestrator confirms the whole phase's *Done when*, updates `PROGRESS.md`, and commits.

---

## Autonomous run & escalation protocol (set-and-forget)

The orchestrator is expected to run **unattended**: kick off a phase and keep going through the build without a human in the loop. To do that safely it tracks state in `PROGRESS.md` and follows a fixed escalation ladder so it never spins forever.

**Per-task attempt tracking.** Every task carries an attempt counter in `PROGRESS.md`: `task-id · route · attempt N/2 · pass|fail`. The orchestrator increments it on each coder return and persists it before moving on, so a restart resumes mid-task instead of redoing work.

**Timeout & loop detection (per attempt).** The escalation ladder catches a coder that *fails*; this catches one that *never returns* — spinning in a loop, re-reading the same files, or oscillating edits without converging. Every coder spawn carries a hard cap; if it trips, the orchestrator **stops the runaway coder** (don't wait for it to finish) and records the attempt as a **timed-out fail** (it counts as a strike on the ladder above).

- **Hard cap per attempt:** set `max_turns` in each coder's frontmatter as the backstop (suggested: `40` for `cheap_coder`, `60` for `expensive_coder` — tune to your tasks). This bounds a single attempt mechanically even if the orchestrator isn't watching.
- **Wall-clock cap:** if your runner exposes it, also bound an attempt to a sane wall-clock budget (suggested: ~15 min). A coder past the cap is presumed stuck.
- **Before re-spawning, check it actually looped** — don't burn a strike on a coder that was merely slow but making progress. Loop signs: the same tool call / file edit repeated with no new result, re-reading files it already read, edits that revert each other, the same failing command run again and again, or a growing turn count with no diff progress. If you see these, **stop it and treat the attempt as failed**; if it was genuinely progressing (new edits, advancing toward the *Done when*), let it finish or re-spawn once with a tighter brief.
- **A timed-out attempt feeds the ladder, it doesn't bypass it:** a stuck `cheap_coder` that trips the cap twice auto-escalates to `expensive_coder`; a stuck `expensive_coder` that trips twice is a **HARD STOP** — write a `BLOCKED:` entry noting the loop (task id, what it kept repeating) and pause for human review. Re-spawning a looping coder unchanged just reproduces the loop.

**The escalation ladder (per task):**
1. Spawn the **recommended coder** (per routing policy — usually `cheap_coder` for peripheral work).
2. Coder implements and runs the **Done-when**. The orchestrator verifies (optionally via `project-planner` Mode B, which counts the strike and returns the verdict).
3. **On fail:** re-spawn the **same** coder once more with the specific failure feedback (attempt 2/2).
4. **`cheap_coder` fails twice → auto-escalate:** the orchestrator spawns `expensive_coder` on the task, carrying both prior attempts' notes. (This is the reassignment you want — mechanically it's the orchestrator's spawn, triggered by the planner's "2 strikes, escalate" verdict.)
5. **Immediate escalation (don't wait for 2 strikes):** if any coder reports the task actually touches **sim correctness, fluid/fire rules, the hybrid body, THE GATE, pathfinding, zombie AI, or performance/chunking**, escalate to `expensive_coder` right away.
6. **`expensive_coder` fails twice → HARD STOP:** do not loop further. Write a `BLOCKED:` entry in `PROGRESS.md` (task id, what failed, both error summaries) and pause the run for human review. Burning tokens on a fourth+ attempt is never the answer.

**Sandbox note (gondolin).** Tool calls run inside a micro-VM with the repo mounted at `/workspace`. At the start of every fresh session/restart, the orchestrator must run `. scripts/gondolin-bootstrap.sh` before planning, coding, or committing. The bootstrap sets `HOME=/workspace`, installs `git` with `apk add git` if the VM image is missing it, configures `safe.directory /workspace`, and restores the pnpm wrapper if needed.

**Guardrails that still apply unattended:**
- **THE GATE holds:** never start Phase 5+ until Phase 4's gate Done-when passes. If it fails, stop and flag — the architecture is meant to change here, with a human.
- **Phase order:** one phase at a time; confirm the previous phase's Done-when before starting the next; **commit at every phase boundary** (a clean rollback point).
- **MVP scope:** silently dropping or adding scope is a failure mode — if a task drifts beyond GDD §14, stop and flag rather than build it.
- **No infinite verification:** a Done-when that can't be made to pass after the ladder above is a `BLOCKED`, not a retry loop.

## Definition of done (every task)

- Compiles under TS strict; no console errors at runtime.
- The task's **Done when** passes, verified by running it.
- New constants live in `config.ts`; no stray magic numbers.
- No scope creep beyond MVP (GDD §14); no features from later phases pulled forward.
- Brief note of what changed (for `PROGRESS.md`).

---

## Notes on this config

- **Spawning is top-level only.** This config assumes the main Pi session is the orchestrator and the only spawner; subagents (planner, coders) run in isolated sessions and don't spawn each other. Don't rely on the planner delegating — it returns a plan, you spawn the coders. (If your subagent extension *does* support nested spawning and you'd rather the planner drive, add the `Agent` tool to its `tools` list and revert the planner to a delegating role.)
- Frontmatter keys (`description`, `model`, `tools`, `thinking`, `max_turns`) follow the Pi subagent convention, but exact support varies by which subagent extension is installed — verify against yours.
- **Verify tool names resolve.** Tools are instantiated by exact name from the extension's tool-factory map; the listed `read, write, edit, bash, grep, find, ls` must match those keys (casing included — some builds expose `Read`/`Write`/`Edit`/`Grep`/`Bash` and use `Glob` instead of `find`/`ls`). Open each agent in `/agents` and confirm its resolved tool set is non-empty.
- **Model IDs to confirm against your providers:** `anthropic/claude-opus-4-8` and `openai/gpt-5-codex` (you referred to it as “gpt-codex-5” — check the exact id your OpenAI provider exposes). The resolver does fuzzy matching (e.g. `opus`) but only returns models with auth configured, so a coder whose provider isn't authed silently won't run.
- The planner's model is intentionally left for you to set in `project-planner.md` — a strong reasoning model improves decomposition and routing, but a mid-tier model keeps it cheap.
