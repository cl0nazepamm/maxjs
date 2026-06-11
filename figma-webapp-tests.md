# Figma → WebApp Animator: real-world load test & issue log

Field notes from loading a **full Figma "Make" export** (Vite 6 + React 18 + MUI 7 +
Tailwind v4 + Framer Motion) into a `WebApp Animator` node, end-to-end, in a live
Max 2027 session. Goal of this doc: hand the next agent a precise, reproducible list
of where the WebApp Animator pipeline fought us, with root causes and fixes, so the
plugin/viewer can be hardened.

> **See also `figma-webapp-playbook.md`** — the *how-to-do-it-again-fast* recipe
> (build/serve/wire steps + reusable RevealStage / serve-dist assets). This file is the
> *why* (bugs); that one is the *how* (repeatable workflow).

**TL;DR:** It works, but only after (1) building to a **single self-contained HTML
file** and (2) fighting **WebView2 disk-file caching** + an **async remount race**.
None of those are obvious to a user, and two of them required deleting/recreating the
node to recover. There is low-hanging fruit to make this a 30-second workflow.

---

## Test subject

- Path: `C:\Users\ogulc\Projects\Mullet\app_itself` (Mullet Money prototype).
- Stack: Vite 6.3.5, React 18.3.1, `@mui/material` 7, `@tailwindcss/vite` 4, `motion`
  (Framer Motion), Radix, recharts, sonner. Multi-screen mobile UI, `motion/react`
  page transitions. **Not** a single-file artifact — a real bundler project.
- Target screen for the final deliverable: `HomeScreenV2` (the "main dashboard").

## Environment

- 3ds Max **2027** (plugin deployed via `release/_staging/maxjs-2027`).
- Node 22.20, npm 10.9 (no pnpm on PATH).
- WebView2 / Edge **149**. CDP debug port **9222** was live (`MAXJS_DEBUG_PORT=9222`),
  which is the only reason most of this was diagnosable — see *Diagnostics* below.

---

## The build recipe that actually works (for context)

A Figma Make export needs three non-obvious build tweaks before it will run from a
disk path in the animator:

1. **`react` / `react-dom` are optional `peerDependencies`** in the export (Figma's
   runtime provides them). A standalone build has neither — `npm install` won't pull
   them. Must add explicitly: `npm i react@18.3.1 react-dom@18.3.1`.
2. **`base: './'`** in `vite.config.ts` — absolute `/assets/...` never resolve under
   the disk-path origin.
3. **Inline everything into one HTML file** — `vite-plugin-singlefile` +
   `build.assetsInlineLimit: 100000000` + `build.cssCodeSplit: false`. This is the
   load-bearing fix (see Issue 2/3). Result: a single `index.html`, **zero** external
   `src`/`href`. 2.2 MB for the full app, 455 KB for just the dashboard.

> `vite-plugin-singlefile` sets `inlineDynamicImports`, which rollup only allows with
> a **single input**. So you get **one page per build** — we drove the entry with a
> `BUILD_ENTRY` env var (`BUILD_ENTRY=home.html npm run build`). Relevant if the
> animator ever wants a "one node per page" workflow.

---

## Issues (ordered by how much they hurt)

### Issue 1 — Pointing at a Vite **source** `index.html` silently shows nothing
**Severity:** low (user error) · **but** the silent-failure UX is a real gap.

The node was initially pointed at the *un-built* `app_itself\index.html`, whose body
is just `<script type="module" src="/src/main.tsx">`. The browser can't execute raw
TSX and the path is dev-server-relative, so the page "loads" (the `<title>` even shows
in the CDP target list) but `#root` stays empty. **Nothing in Max or the viewer tells
the user the page failed to mount.**

**Recommendation:** when a CSS3D/texture page loads but `#root`/`body` stays empty, or
a sub-resource 404s, surface it — a panel-corner badge ("page loaded, 0 elements" /
"asset failed: …") or a console line routed to the Max listener. Right now a broken
URL and a working URL look identical (a blank panel).

---

### Issue 2 — External bundle assets fail to resolve in **CSS3D** mode  ⭐ core bug
**Severity:** high.

After a normal `vite build` (`base: './'`), the node URL
`C:\...\dist\index.html` maps to
`https://maxjs-assets.local/C%3A/Users/.../dist/index.html`. The **index.html loads
fine** (title present), but its siblings fail:

```
Failed to load resource: net::ERR_NAME_NOT_RESOLVED
  @ https://maxjs-assets.local/C%3A/Users/.../dist/assets/index-*.js
  @ https://maxjs-assets.local/C%3A/Users/.../dist/assets/index-*.css
```

So the document parses but the entry script never executes → empty `#root`. The host
serves the **navigated document** but not **sibling files referenced relatively from
it**. `ERR_NAME_NOT_RESOLVED` (a host error, not a 404) suggests the disk-path serving
is a per-navigation intercept rather than a real folder mapping that covers the whole
`dist/` tree.

**This is the single biggest blocker** for "just point it at a built web app." Every
modern bundler emits `index.html + assets/*`.

**Recommendations (pick one):**
- Map the **containing folder** of a disk-path URL as a virtual-host root (WebView2
  `SetVirtualHostNameToFolderMapping`) so `./assets/*` and `<base>`-relative requests
  resolve naturally; or
- Intercept and serve **any** file under the disk-path's directory (not just the
  index), with correct MIME types; or
- At minimum, document loudly that **only single-file HTML is supported** for disk
  paths and link the single-file build recipe.

---

### Issue 3 — Relative assets rebase to `maxjs.local` in **texture** mode
**Severity:** high (same root, different surface).

Texture mode shadow-injects the page into the `maxjs.local` document
(`html_texture.js`), so relative `./assets/...` resolve against
`https://maxjs.local/assets/...` and 404. `executeScript` for an external `src` script
just hits `fresh.onerror` and logs:

```
[maxjs html_texture] script failed: https://maxjs.local/assets/index-C7TmF87S.js
```

(`web/js/html_texture.js` ~`executeScript()` line 132, `onerror` line 163.)

**Recommendation:** when adopting a disk/`maxjs-assets.local` page into texture mode,
inject a `<base href>` pointing at the page's real origin/dir (the depth-occlude
srcdoc path already does `<base href>` per `WEBAPP_ANIMATOR.md`) **before** running
scripts, so relative asset URLs resolve. The single-file bundle sidesteps this, but a
`<base href>` would make multi-file builds work in texture mode too.

> **Net of 2 + 3:** single-file HTML is currently the *only* robust format for both
> presentations. That should either be the documented contract or be fixed so normal
> builds work.

---

### Issue 4 — WebView2 **caches the disk-file response by URL**; in-place edits don't show  ⭐
**Severity:** high (kills the iterate loop).

After rebuilding the **same** `index.html` (now single-file), a remount **re-served the
stale cached old content** — the iframe still referenced the previous build's
`assets/index-C7TmF87S.js`. Re-pointing the node at the same path does not refetch.
We only got fresh content by **writing to a new filename each rebuild**
(`mullet.html` → `home-dashboard.html` → `home-dash2.html` → `home-dash3.html`).

**Recommendation:** defeat caching for local/`maxjs-assets.local` loads — disable the
cache for that virtual host, or append an internal cache-bust token (content hash or
file mtime) to the fetched URL **after** file resolution. Without this, "edit page →
see change" requires renaming the file every time, which is unworkable for authoring.

---

### Issue 5 — `?v=N` cache-bust query on a **disk path** breaks file resolution
**Severity:** medium (and contradicts the docs).

The natural workaround for Issue 4 — append `?v=3` to bust cache — made the iframe
**fail to load entirely** (no iframe target at all). `WEBAPP_ANIMATOR.md` says query
strings are stripped before file mapping "requires a plugin build from 2026-06-11 or
later." The **running 2027 build did not strip it**, so `index.html?v=3` resolved to a
nonexistent file.

**Recommendation:** ensure the shipped build strips the query before disk-path
resolution (also needed for the documented `?maxjs-host=div` / `?maxjs-layer` flags on
disk URLs). Until then, the only cache-bust is a new filename (Issue 4).

---

### Issue 6 — Rapid presentation/URL changes **race the async remount** → orphaned `src`-less iframe  ⭐
**Severity:** high (and unrecoverable without deleting the node).

`remount()` is async (`web/js/maxjs_webapp.js` ~424): it bumps `mountVersion`, tears
down, then `await`s `buildCSS3DInstance` → `createCSS3DHost`. A guard (line ~449)
bails and tears down the freshly-built instance if `mountVersion` changed meanwhile.

Toggling `presentation = 1` then `= 0` (and/or several URL changes) in **one MAXScript
block** fired overlapping remounts. The result: an iframe element at the **correct
size (440×932)** but with **empty `src`** — a half-mounted host the guard's teardown
left behind. From there, further URL changes did **not** recover it, because:

```js
// upsertEntry(): only remounts when needsRemount(previous, entry.data) is true
if (needsRemount(previous, entry.data)) { remount(entry); return; }
```

Once the viewer's last-synced URL matched the node's URL, `needsRemount` was false, so
nothing re-mounted the dead iframe. **Only delete + recreate the node (new handle →
fresh entry) recovered it.**

**Recommendations:**
- On the `mountVersion` bail, **also remove/replace the orphaned host** so a stuck
  empty-`src` iframe can't survive; or have the superseding remount reuse/repair it.
- Make remount **idempotent / self-healing**: if an entry has instances but the host's
  `src` is empty (or load never fired), treat it as needing remount.
- Add an explicit **reload** path (see Issue 8) so recovery never requires deletion.

---

### Issue 7 — Plain MAXScript property writes don't reliably trigger a sync tick
**Severity:** medium.

Setting `n.url = ...` + `completeRedraw()` frequently did **not** post a
`webapp_update`. `DetectWebAppChanges` runs on the max.js sync tick; a pure
property/`REFMSG_CHANGE` + nitrous redraw didn't always produce one. We had to force a
full re-sync with a **time change** (`sliderTime = 5f`) or a node move before the
viewer saw the new URL.

**Recommendation:** a `REFMSG_CHANGE` on a WebApp Animator param block should mark the
node dirty and **guarantee** a webapp sync on the next tick, independent of viewport
redraw / time change. Otherwise scripted/automated panel updates are non-deterministic
(this also bites MCP-driven workflows, which is how this whole test was driven).

---

### Issue 8 — No "reload / reset panel" affordance anywhere
**Severity:** medium (forces destructive recovery).

Given Issues 4 + 6, the only way to force a clean mount was **delete + recreate** the
node. That is destructive: it drops keyed **transform animation and keyed params**
(you can't trivially clone the controllers in script). The Web Panels UI exposes
CSS3D/Canvas/Depth toggles but **no Reload**.

**Recommendation:** add a **Reload** button to the Web Panels UI and a matching message
(e.g. `webapp_set {handle, reload:true}` handled in `maxjs_panel_sync.inl`) that calls
`remount(entry)` unconditionally (bypassing `needsRemount`). This single feature would
have avoided ~half the pain in this session and removes the only destructive recovery.

---

## What worked well (keep / don't regress)

- **CSS3D + Interactive** renders the full React/MUI/Framer app crisply and is
  clickable in-viewport. Heavy stack, no problem once assets resolve.
- **Single-file bundle** is bulletproof across both presentations (no external
  requests = none of Issues 2/3).
- The **disk-path → `maxjs-assets.local`** same-origin mapping is the right idea — it
  just needs to cover sibling assets (Issue 2) and not cache stale (Issue 4).
- **CDP on 9222** made all of this diagnosable; see below.

---

## Diagnostics (how the above was found — reuse this)

CDP at `http://127.0.0.1:9222/json` lists every frame as a target. The panel page is
`https://maxjs.local/index.html`; the loaded app is a **child iframe** target at
`https://maxjs-assets.local/C%3A/.../<page>.html`.

- **Did the app mount?** `Runtime.evaluate` on the iframe target:
  `document.getElementById('root').childElementCount` + `document.body.innerText`.
- **Why is it blank?** `Network.enable` + `Page.reload {ignoreCache:true}`, collect
  `Network.loadingFailed` (full failing URL + initiator) and `Runtime.exceptionThrown`.
- **Is the host even mounted?** On the **main** page:
  `Array.from(document.querySelectorAll('iframe')).map(f => ({src:f.getAttribute('src'), w:f.offsetWidth}))`
  — this is exactly how the empty-`src` orphan (Issue 6) was caught.
- A child iframe is **not** a top-level target, so `Page.captureScreenshot` on it
  errors (`Command can only be executed on top-level targets`); evaluate the DOM
  instead, or screenshot the whole panel.
- Repo helpers exist: `test/cdp_eval.js`, `cdp_screenshot.js`, `cdp_reload.js`,
  `cdp_click.js` (they target the `maxjs.local` page; for the app iframe, pick the
  `maxjs-assets.local` target's `webSocketDebuggerUrl`).

---

## Suggested priority for the next agent

1. **Reload button + `remount`-unconditional message** (Issue 8) — cheapest, removes
   the destructive recovery and unblocks authoring iteration.
2. **Don't cache disk-file loads** (Issue 4) — makes "edit → remount → see change"
   actually work.
3. **Serve sibling assets for disk-path pages** (Issue 2) + **`<base href>` in texture
   adoption** (Issue 3) — lets normal `index.html + assets/*` builds load, so users
   don't need the single-file trick.
4. **Self-healing remount / orphan cleanup** (Issue 6) — kill the empty-`src` stuck
   state.
5. **Guarantee a sync on param `REFMSG_CHANGE`** (Issue 7) — deterministic scripted
   updates.
6. **Strip query before disk-path resolution** (Issue 5) + **blank-page diagnostics**
   (Issue 1).

---

## Reproduce in ~5 minutes

1. `cd C:\Users\ogulc\Projects\Mullet\app_itself`
2. `npm i react@18.3.1 react-dom@18.3.1` (optional peers), then `npm i -D vite-plugin-singlefile`.
3. Point a WebApp Animator at the **source** `index.html` → blank (Issue 1).
4. Plain `vite build` (with `base:'./'`), point at `dist\index.html` → loads, blank,
   `ERR_NAME_NOT_RESOLVED` on `./assets/*` (Issue 2; texture mode → Issue 3).
5. Add `viteSingleFile()` + `assetsInlineLimit:1e8`, rebuild → single file → renders.
6. Rebuild again to the **same** filename, remount → stale content (Issue 4). Try
   `?v=2` → iframe gone (Issue 5). Rename file → works.
7. Toggle `presentation` 1↔0 twice fast in one MAXScript → empty-`src` iframe that
   only delete+recreate fixes (Issue 6).

---

## Round 2 — building a render-driven UI animation (reveal + real depth)

Goal: a Figma dashboard set up purely for animation — a 0→1 `reveal` that staggers
the whole UI in, plus **real 3D layer separation** (buttons floating above the
screen). Driven by animator channels, rendered, finished in After Effects.

### Issue 9 — `layerCount > 1` breaks loading on **disk-path** URLs  ⭐
**Severity:** high (blocks the layer feature entirely for local pages).

The layer stack mounts the page N times and appends `?maxjs-layer=i&maxjs-layers=N`
to each iframe `src` (`maxjs_webapp.js` `buildCSS3DInstance` → `layerUrl`). On a
disk-path / `maxjs-assets.local` URL this build **cannot resolve the query** (same
root cause as Issue 5 — the query isn't stripped before file resolution), so **all N
instances fail to load → 0 iframes mount** (the panel just goes blank). A single-layer
disk page loads fine; flipping `layerCount` to 3 made it vanish.

**Workaround (what we shipped):** serve the built page over **`http://127.0.0.1:<port>`**
instead of a disk path. Per the docs, `http(s)://` URLs pass viewer flags through
untouched, so `...home.html?maxjs-layer=0&maxjs-layers=3` resolves (the static server
ignores the query). `http://127.0.0.1` is mixed-content-exempt, so the `https`
`maxjs.local` panel embeds it without blocking. A 20-line static server with
`Cache-Control: no-store` (`app_itself/serve-dist.cjs`) does it — and the `no-store`
**also fixes Issue 4**, so rebuilds to the same filename refetch (no more rename dance).

**Recommendation:** strip the query before disk-path file resolution (fixes Issues 5 +
9 together). Layers are unusable for local pages until then; everyone will hit this the
moment they set `layerCount > 1` on a disk URL.

### Issue 10 — CSS `translateZ` inside the iframe gives no real depth (expected, worth a doc note)
We first tried faking depth with CSS `perspective` + `translateZ` on elements inside
the page. It reads as a slight tilt but elements stay **stuck to the panel plane** — an
iframe is an atomic replaced element, so inner 3D never joins the scene's CSS3D context
(exactly the rationale for div-host / layers in `WEBAPP_ANIMATOR.md`). Real depth needs
the **layer stack** (or the `?maxjs-host=div` preserve-3d mode — also query-gated, see
Issue 9). Worth stating plainly in the doc: *in-page translateZ ≠ scene depth; use layers.*

### Cross-origin layer hiding (works, for reference)
Because the page is cross-origin (`127.0.0.1`/`maxjs-assets.local` vs `maxjs.local`), the
viewer's auto-injected per-layer stylesheet doesn't apply; the page hides non-owned
layers itself by reading `?maxjs-layer`/`?maxjs-layers` and the `{type:'maxjs:layer'}`
message, using `visibility:hidden` (keeps layout so positions align across instances)
and transparent backgrounds on front layers. This path is solid — see
`app_itself/src/pages/RevealStage.tsx`.

### Reveal channel (works well)
`reveal` 0..1 as a pure function of the param (no wall-clock) → scrub-accurate and
render-deterministic. Continuous channels are the right tool for render→AE; the stepped-
tangent trigger pattern is not needed here.

### Issue 11 — Texture mode can't run ES-module bundles (React #299 on mount)  ⭐
**Severity:** high (texture mode unusable for any Vite/bundler React app).

Switching a React/Vite single-file page to **Texture** presentation throws, repeatedly:
`Minified React error #299` (`createRoot(...)` target container is not a DOM element) —
`document.getElementById('root')` returned null.

Root cause in `web/js/html_texture.js` `executeScript()`: it shadow-injects the page and
runs scripts against a **`document` proxy** that maps to the shadow root — but ONLY for
*classic* inline scripts (`wrapInlineCode()` wraps the body in a function whose `document`
arg is the proxy). For `type="module"` scripts it sets `fresh.textContent = code` raw
(line ~158) — a module's scope can't be wrapped, so `document` is the REAL `maxjs.local`
document, which has no `#root` (that lives in the shadow). Vite emits the app as an ES
module → `createRoot(document.getElementById('root'))` mounts to null → #299. Each layer
instance retries → repeated errors.

Even past that, **MUI/emotion injects `<style>` into `document.head` at runtime** — under
the proxy `document.head` doesn't map to the shadow head, so a module-or-classic MUI app
would also render unstyled in texture mode.

**Net:** texture mode is viable for hand-authored classic-script pages (the test pages,
Diet Tracker), but NOT for a module-bundled MUI/React app. CSS3D works fine for both.

**Recommendations:**
- Document texture mode as "classic-script pages only" until fixed.
- To support bundlers: run an iframe-srcdoc in texture mode (real document, real `#root`,
  emotion head works) instead of shadow-injection + script proxy; OR detect `type=module`
  and mount the page in a same-document real subtree with its own `<head>`.
- Page-side workaround is limited: a module script can't reach its shadow `#root`, so the
  only build-side option is shipping a classic/IIFE bundle — which still hits the emotion
  `document.head` problem. Treat texture-for-bundlers as renderer work.
