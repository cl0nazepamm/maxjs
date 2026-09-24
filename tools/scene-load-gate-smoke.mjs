#!/usr/bin/env node
// Scene load gate smoke: the pieces that make a big scene sync safe —
// the time-slice policy, the deferred packet queue, the gate state machine
// (with a stub document), the long-task monitor — plus source contracts for
// how scene_sync, render_loop and boot wire them together.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    SCENE_APPLY_SLICE_DEFAULTS,
    createDeferredPacketQueue,
    createSceneLoadGate,
    shouldTimeSliceSceneApply,
    yieldToEventLoop,
} from '../web/js/editor/scene_load_gate.js';
import { createLongTaskMonitor } from '../web/js/long_task_monitor.js';

// ── time-slice policy ────────────────────────────────────────────────
{
    const geo = (n) => ({ h: n, geo: { vOff: 0, vN: 3 } });
    const cached = (n) => ({ h: n });
    const helper = (n) => ({ h: n, helper: true, geo: { vOff: 0, vN: 3 } });
    const small = { nodes: Array.from({ length: 10 }, (_, i) => geo(i)) };
    assert.equal(shouldTimeSliceSceneApply(small, 1024), false, 'a few geometries stay synchronous');
    const many = { nodes: Array.from({ length: SCENE_APPLY_SLICE_DEFAULTS.minGeometryNodes }, (_, i) => geo(i)) };
    assert.equal(shouldTimeSliceSceneApply(many, 1024), true, 'many fresh geometries slice');
    const cachedOnly = { nodes: Array.from({ length: 500 }, (_, i) => cached(i)) };
    assert.equal(shouldTimeSliceSceneApply(cachedOnly, 1024), false, 'a material-only resync of cached nodes stays synchronous');
    const helpersOnly = { nodes: Array.from({ length: 500 }, (_, i) => helper(i)) };
    assert.equal(shouldTimeSliceSceneApply(helpersOnly, 1024), false, 'helpers never count as geometry');
    assert.equal(shouldTimeSliceSceneApply(small, SCENE_APPLY_SLICE_DEFAULTS.minBytes), true, 'a large buffer slices regardless of node count');
    assert.equal(shouldTimeSliceSceneApply(null, 1e9), false);
    assert.equal(shouldTimeSliceSceneApply({ nodes: 'nope' }, 1e9), false);
}

// ── deferred packet queue ────────────────────────────────────────────
{
    const q = createDeferredPacketQueue();
    const ran = [];
    assert.equal(q.defer(() => ran.push('early'), 'early'), false, 'nothing is deferred before begin(): the caller runs it');
    assert.deepEqual(ran, [], 'defer() never runs a packet itself');
    ran.push('early');
    q.begin();
    assert.equal(q.deferring, true);
    assert.equal(q.defer(() => ran.push('a'), 'a'), true);
    assert.equal(q.defer(() => { throw new Error('boom'); }, 'b'), true);
    assert.equal(q.defer(() => ran.push('c'), 'c'), true);
    assert.equal(q.size, 3);
    assert.deepEqual(ran, ['early'], 'deferred packets do not run yet');
    const errors = [];
    const replayed = q.flush((error, label) => errors.push(`${label}:${error.message}`));
    assert.equal(replayed, 2, 'a throwing packet does not stop the others');
    assert.deepEqual(ran, ['early', 'a', 'c'], 'arrival order is preserved');
    assert.deepEqual(errors, ['b:boom']);
    assert.equal(q.deferring, false);
    assert.equal(q.size, 0);
    q.begin();
    q.defer(() => ran.push('dropped'));
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(q.deferring, false);
    assert.deepEqual(ran, ['early', 'a', 'c']);
}

// ── yield helper ─────────────────────────────────────────────────────
{
    let order = [];
    const p = yieldToEventLoop().then(() => order.push('yielded'));
    queueMicrotask(() => order.push('microtask'));
    await p;
    assert.deepEqual(order, ['microtask', 'yielded'], 'yield is a macrotask, not a microtask');
}

// ── gate state machine with a stub document ──────────────────────────
{
    function stubElement() {
        const el = {
            id: '', textContent: '', attrs: {}, children: [], classes: new Set(),
            style: {}, _html: '',
            setAttribute(k, v) { el.attrs[k] = v; },
            appendChild(child) { el.children.push(child); return child; },
            get classList() {
                return {
                    add: (c) => el.classes.add(c),
                    remove: (c) => el.classes.delete(c),
                    toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
                    contains: (c) => el.classes.has(c),
                };
            },
            set innerHTML(v) { el._html = v; },
            get innerHTML() { return el._html; },
            querySelector(sel) {
                const key = sel.replace(/^\./, '');
                return (el.parts ??= {})[key] ??= stubElement();
            },
        };
        return el;
    }
    const body = stubElement();
    const doc = { body, createElement: () => stubElement() };
    const events = [];
    const gate = createSceneLoadGate({
        document: doc,
        fadeMs: 0,
        onBegin: (e) => events.push(['begin', e.generation]),
        onEnd: (e) => events.push(['end', e.generation, e.reason]),
    });
    assert.equal(gate.active, false);
    assert.equal(gate.isBlockingRender(), false);
    assert.equal(gate.isFirstFrame(), false);

    const gen1 = gate.begin({ label: 'Loading scene', total: 100 });
    assert.equal(gen1, 1);
    assert.equal(gate.state, 'apply');
    assert.equal(gate.isBlockingRender(), true, 'apply blocks rendering');
    const root = body.children[0];
    assert.equal(root.id, 'sceneLoadGate');
    assert.ok(root.classes.has('active'), 'overlay shown');
    const title = root.querySelector('.scene-load-title');
    const phase = root.querySelector('.scene-load-phase');
    const bar = root.querySelector('.scene-load-bar');
    const fill = root.querySelector('.scene-load-bar-fill');
    assert.equal(title.textContent, 'Loading scene');
    assert.equal(phase.textContent, 'Applying scene 0 / 100');
    gate.progress(25, 100);
    assert.equal(fill.style.width, '25%');
    assert.equal(phase.textContent, 'Applying scene 25 / 100');
    assert.equal(bar.classes.has('indeterminate'), false);

    gate.setState('compile');
    assert.equal(gate.isBlockingRender(), true, 'compile blocks rendering');
    assert.equal(phase.textContent, 'Compiling shaders');
    assert.ok(bar.classes.has('indeterminate'), 'compile has no known total');
    gate.progress(50, 100);
    assert.equal(phase.textContent, 'Compiling shaders', 'progress is ignored outside apply');

    gate.setState('firstFrame');
    assert.equal(gate.isBlockingRender(), false, 'first frame renders');
    assert.equal(gate.isFirstFrame(), true);
    assert.ok(root.classes.has('active'), 'overlay still up during the first frame');
    gate.setState('bogus');
    assert.equal(gate.state, 'firstFrame', 'unknown states are ignored');

    gate.end('rendered');
    assert.equal(gate.state, 'idle');
    assert.equal(root.classes.has('active'), false, 'overlay hidden');
    gate.end('rendered');
    assert.deepEqual(events, [['begin', 1], ['end', 1, 'rendered']], 'end is idempotent');

    // A newer load supersedes: same overlay, new generation.
    const gen2 = gate.begin({ total: 10 });
    const gen3 = gate.begin({ total: 20 });
    assert.equal(gen3, gen2 + 1);
    assert.equal(gate.isCurrent(gen2), false);
    assert.equal(gate.isCurrent(gen3), true);
    assert.equal(body.children.length, 1, 'one overlay element for the page');
    gate.end('superseded');
    assert.equal(gate.isCurrent(gen3), false);

    // setState before begin is a no-op; a document-less gate never throws.
    gate.setState('compile');
    assert.equal(gate.state, 'idle');
    const headless = createSceneLoadGate({ document: null });
    headless.begin({ total: 3 });
    headless.progress(1, 3);
    headless.setState('compile');
    headless.setState('firstFrame');
    assert.equal(headless.isFirstFrame(), true);
    headless.end();
    assert.equal(headless.active, false);
}

// ── long-task monitor ────────────────────────────────────────────────
{
    const logged = [];
    let enabled = false;
    const monitor = createLongTaskMonitor({ isLogEnabled: () => enabled, log: (m) => logged.push(m) });
    assert.equal(monitor.phase, 'idle');
    monitor.setPhase('scene:apply');
    monitor.record(120, 10);
    monitor.setPhase('');
    assert.equal(monitor.phase, 'idle', 'empty phase falls back to idle');
    enabled = true;
    monitor.record(75, 200);
    assert.deepEqual(logged, ['[max.js longtask] 75 ms during "idle"']);
    const entries = monitor.getEntries();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { phase: 'scene:apply', durationMs: 120, startTime: 10, name: 'longtask' });
    const totals = monitor.getTotals();
    assert.deepEqual(totals['scene:apply'], { count: 1, totalMs: 120, maxMs: 120 });
    assert.deepEqual(totals.idle, { count: 1, totalMs: 75, maxMs: 75 });
    // withPhase restores across sync, throw, and async.
    monitor.withPhase('sync:delta', () => assert.equal(monitor.phase, 'sync:delta'));
    assert.equal(monitor.phase, 'idle');
    assert.throws(() => monitor.withPhase('x', () => { throw new Error('nope'); }), /nope/);
    assert.equal(monitor.phase, 'idle');
    await monitor.withPhase('scene:compile', async () => {
        await Promise.resolve();
        assert.equal(monitor.phase, 'scene:compile');
    });
    assert.equal(monitor.phase, 'idle');
    for (let i = 0; i < 150; i++) monitor.record(51, i);
    assert.equal(monitor.getEntries().length, 100, 'entries are bounded');
    monitor.clear();
    assert.equal(monitor.getEntries().length, 0);
    assert.deepEqual(monitor.getTotals(), {});
    // Node has no longtask observer: start() reports that instead of throwing.
    assert.equal(typeof monitor.supported, 'boolean');
    if (!monitor.supported) assert.equal(monitor.start(), false);
    monitor.stop();
}

// ── source contracts ─────────────────────────────────────────────────
{
    const sceneSync = readFileSync(new URL('../web/js/editor/scene_sync.js', import.meta.url), 'utf8');
    const renderLoop = readFileSync(new URL('../web/js/editor/render_loop.js', import.meta.url), 'utf8');
    const boot = readFileSync(new URL('../web/js/editor/boot.js', import.meta.url), 'utf8');
    const fx = readFileSync(new URL('../web/js/maxjs_fx.js', import.meta.url), 'utf8');
    const textures = readFileSync(new URL('../web/js/editor/texture_pipeline.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../web/css/index.css', import.meta.url), 'utf8');

    // Big syncs copy the shared buffer and go through the sliced path; small
    // ones keep the synchronous path inside the host event.
    assert.match(sceneSync, /if \(gate && shouldTimeSliceSceneApply\(meta, buffer\.byteLength\)\) \{\s*\n[\s\S]*?const owned = buffer\.slice\(0\);\s*\n\s*void runSlicedSceneApply\(owned, meta, gate\);/);
    assert.match(sceneSync, /void applyBinaryScene\(buffer, meta, null\);/);
    // The chunk check must stay synchronous on the fast path: a per-node
    // await would let a second scene_bin interleave with this apply.
    assert.match(sceneSync, /const keepGoing = slicer\.maybeYield\(nodeIndex, nodeTotal\);\s*\n\s*if \(keepGoing !== true && !\(await keepGoing\)\) return 'superseded';/);
    assert.match(sceneSync, /maybeYield\(done, total\) \{\s*\n\s*if \(performance\.now\(\) - this\.chunkStart < this\.budgetMs\) return true;/);
    assert.doesNotMatch(sceneSync, /async maybeYield/);
    assert.match(sceneSync, /return 'applied';\s*\n\s*\}\s*\n\s*function handleBinaryDelta/);
    // Every node-level packet type defers while a sliced apply is in flight,
    // and binary payloads are copied before the host releases them.
    assert.match(sceneSync, /deferredPackets\.defer\(\(\) => handleBinaryDelta\(copy, meta\), 'delta_bin'\)/);
    assert.match(sceneSync, /deferredPackets\.defer\(\(\) => handleGeoFastBinary\(copy, meta\), 'geo_fast'\)/);
    assert.match(sceneSync, /deps\.bridge\.on\('geo_fast', msg => deferWhileApplying\('geo_fast_json', \(\) => handleGeoFastJson\(msg\)\)\);/);
    assert.match(sceneSync, /deps\.bridge\.on\('xform', msg => deferWhileApplying\('xform', \(\) => handleXformJson\(msg\)\)\);/);
    // The apply → compile → firstFrame hand-off, superseded loads leave the
    // gate to their successor, and the deferred queue flushes exactly once.
    assert.match(sceneSync, /gate\.setState\('compile'\);\s*\n\s*setSyncPhase\('scene:compile'\);\s*\n\s*await warmupScenePipelines\(\);/);
    assert.match(sceneSync, /if \(outcome === 'superseded'\) \{[\s\S]*?return;\s*\n\s*\}\s*\n\s*slicedSceneApplyInFlight = false;\s*\n\s*const replayed = deferredPackets\.flush\(/);
    assert.match(sceneSync, /gate\.setState\('firstFrame'\);/);
    // compileAsync targets the post-FX scene pass render target + MRT and is
    // capped so a slow driver cannot hold the overlay forever.
    assert.match(sceneSync, /renderer\.setRenderTarget\(passTarget\);\s*\n\s*if \(typeof renderer\.setMRT === 'function'\) renderer\.setMRT\(scenePass\.getMRT\?\.\(\) \?\? null\);/);
    assert.match(sceneSync, /renderer\.compileAsync\(deps\.scene, camera\),\s*\n\s*new Promise\(\(resolve\) => \{ timer = setTimeout\(resolve, SCENE_APPLY_SLICE_DEFAULTS\.compileTimeoutMs\); \}\),/);
    assert.match(fx, /getScenePass\(\) \{\s*\n\s*return core\.ctx\?\.scenePass \?\? null;/);
    // Render loop: blocked while applying/compiling, ends the gate after the
    // first rendered frame, attributes long tasks.
    assert.match(renderLoop, /if \(sceneLoadGate\?\.isBlockingRender\?\.\(\)\) return;/);
    assert.match(renderLoop, /if \(gateFirstFrame\) sceneLoadGate\.end\('rendered'\);/);
    assert.match(renderLoop, /deps\.longTaskMonitor\?\.setPhase\?\.\(gateFirstFrame \? 'scene:first-frame' : 'render'\);/);
    // Boot owns one gate and one monitor and hands them to both consumers;
    // Speedball's rest window restarts when the gate ends.
    assert.match(boot, /const sceneLoadGate = createSceneLoadGate\(\{\s*\n\s*onEnd: \(\{ reason, elapsedMs \}\) => \{\s*\n\s*speedballGiLastInteractionMs = performance\.now\(\);/);
    assert.match(boot, /const longTaskMonitor = createLongTaskMonitor\(\{ isLogEnabled: \(\) => debugMode \}\);\s*\n\s*longTaskMonitor\.start\(\);/);
    assert.equal((boot.match(/get sceneLoadGate\(\) \{ return sceneLoadGate; \},/g) || []).length, 2, 'gate reaches scene sync and the render loop');
    assert.match(boot, /get camera\(\) \{ return camera; \},\s*\n\s*get sceneLoadGate\(\)/);
    // Textures decode off the main thread before the GPU upload sees them.
    assert.match(textures, /image\.decode\(\)\.then\(attach, attach\);/);
    assert.match(textures, /const tex = loadDecodedImageTexture\(/);
    assert.doesNotMatch(textures, /const tex = deps\.textureLoader\.load\(/);
    // Overlay styling exists for both themes.
    assert.match(css, /#sceneLoadGate\.active \{ opacity: 1; pointer-events: auto;/);
    assert.match(css, /body\.light-mode \.scene-load-card \{/);
}

console.log('scene-load-gate-smoke: PASS');
