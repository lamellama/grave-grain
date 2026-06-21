# TOOLING.md — sandbox environment notes (read before touching deps)

This repo runs inside the **gondolin** micro-VM (Alpine, aarch64/musl) with the repo
mounted at `/workspace`. The base image has two defects the build had to work around.
**If you are a coder agent: do NOT run `npm install`.** Read this first.

## 1. The global `npm` is corrupted — never use it to install

The VM image's global npm (`/usr/lib/node_modules/npm`) has **truncated filenames**
(e.g. `@sigstore/.../google/protobuf/timestamp.js` → `ti`, `spdx-expression-parse` → …).
Any `npm install` / `npm ci` fails with `Cannot find module './google/protobuf/timestamp'`
and, worse, npm's flaky optional-deps handling drops the native rollup/esbuild binaries,
which breaks `vite`.

**Use `pnpm` instead** (installed at `/usr/local/bin/pnpm`, backed by
`/workspace/.tooling/pnpm`). It resolves the musl rollup/esbuild binaries correctly and
keeps a `pnpm-lock.yaml`. If you must add a dependency: `pnpm add -D <pkg>` then rebuild.

If the `pnpm` wrapper is missing (e.g. after a VM restart), recreate it:
```sh
printf '#!/bin/sh\nexec node /workspace/.tooling/pnpm/bin/pnpm.cjs "$@"\n' > /usr/local/bin/pnpm
chmod +x /usr/local/bin/pnpm   # (chmod is a no-op on the mount but harmless)
```
Run pnpm with `HOME=/workspace`.

## 2. The mount does not honor the executable bit

`chmod +x` is a silent no-op on the `/workspace` mount, so pnpm's `node_modules/.bin/*`
shell-script shims are **not executable**. Therefore the `package.json` scripts call the
JS entrypoints through `node` directly (not the `.bin` shims):
```
"dev":     "node ./node_modules/vite/bin/vite.js",
"build":   "node ./node_modules/typescript/bin/tsc && node ./node_modules/vite/bin/vite.js build",
"preview": "node ./node_modules/vite/bin/vite.js preview"
```
`npm run build` / `npm run dev` work (npm's *script runner* is fine — only its *installer*
is broken). Keep this pattern for any new script; don't rely on bare `tsc`/`vite` on PATH.

## 3. Session bootstrap: git + HOME + pnpm

At the start of each fresh gondolin session, run:

```sh
. scripts/gondolin-bootstrap.sh
```

This sets `HOME=/workspace`, installs `git` with `apk add git` if the VM image is
missing it, configures `safe.directory /workspace`, and recreates the pnpm wrapper
if it disappeared after a VM restart.

Why this exists: git is not in the base image, and the mounted repo needs
`safe.directory /workspace` before commits. Agents should use the bootstrap instead
of repeatedly diagnosing/reinstalling git by hand.

## TL;DR for coders
- Start fresh sessions with **`. scripts/gondolin-bootstrap.sh`**.
- Verify with **`npm run build`** and **`npm run dev`** — these work.
- **Never `npm install`.** If deps change, use **`pnpm install`** / `pnpm add`.
- New npm scripts must invoke binaries via `node ./node_modules/<pkg>/...`, not `.bin` shims.
