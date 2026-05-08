#!/usr/bin/env node
//
// snapshot-deploy.mjs — strip duplicate runtime artifacts from snapshot
// folders so each iter under web/snapshots/ is small and reuses the
// canonical web/js + web/vendor + web/node_modules served by
// `npm run snapshot:serve`.
//
// The exporter still writes index.html + a copy of the runtime tree
// alongside snapshot.json + scene.bin. That works for self-hosted
// snapshots, but when iterating against the wrapper at
// web/snapshot.html?root=snapshots/iter-N the duplicates are dead
// weight (~140 MB per iter). This script removes them.
//
// Usage:
//   node scripts/snapshot-deploy.mjs <iter-folder> [...more]
//   node scripts/snapshot-deploy.mjs --all
//   node scripts/snapshot-deploy.mjs --watch [snapshots-root]
//
// `--watch` listens for snapshot.json arrivals under web/snapshots/ and
// strips the iter folder a half-second after the export settles. Pair
// with `npm run snapshot:serve` and you get a one-keystroke loop:
// click Export Snapshot in Max → script auto-deploys → refresh tab.

import { rm, readdir, stat } from 'node:fs/promises';
import { existsSync, watch as watchSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT      = path.resolve(__dirname, '..');
const SNAPSHOTS_ROOT = path.join(REPO_ROOT, 'web', 'snapshots');

// Files / folders shipped by the exporter that duplicate web/* entries.
// Snapshot mode loads them from the served web/ root via relative URL,
// so the per-iter copies are pure overhead.
const STRIP_PATHS = [
    'index.html',          // legacy live-viewer wrapper; superseded by web/snapshot.html
    'js',                  // duplicate of web/js
    'vendor',              // duplicate of web/vendor (~29 MB)
    'node_modules',        // duplicate of web/node_modules (~110 MB)
    'package.json',
    'package-lock.json',
];

// Files we explicitly keep — listed for documentation. Anything not in
// STRIP_PATHS is left alone, so this list isn't enforced; it's just the
// expected post-deploy contents of an iter folder.
const KEEP_PATHS_DOC = [
    'snapshot.json',
    'scene.bin',
    'scene_anim.bin',
    'inlines',             // scene-local layer modules — Phase 9 imports these live
    'project.maxjs.json',
    'postfx.maxjs.json',
    'assets',              // copied texture / audio assets
];
void KEEP_PATHS_DOC;

// ─── helpers ─────────────────────────────────────────────────────────

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function dirSize(folder) {
    let total = 0;
    let entries;
    try {
        entries = await readdir(folder, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const sub = path.join(folder, entry.name);
        if (entry.isDirectory()) total += await dirSize(sub);
        else if (entry.isFile()) {
            try { total += (await stat(sub)).size; } catch {}
        }
    }
    return total;
}

async function stripIter(folder) {
    const abs = path.resolve(folder);
    if (!existsSync(abs)) {
        console.warn(`[deploy] skip: ${abs} does not exist`);
        return;
    }
    const stats = await stat(abs);
    if (!stats.isDirectory()) {
        console.warn(`[deploy] skip: ${abs} is not a directory`);
        return;
    }
    if (!existsSync(path.join(abs, 'snapshot.json'))) {
        console.warn(`[deploy] skip: ${path.relative(REPO_ROOT, abs)} has no snapshot.json (not an iter folder?)`);
        return;
    }

    let removed = 0;
    let bytes = 0;
    for (const name of STRIP_PATHS) {
        const target = path.join(abs, name);
        if (!existsSync(target)) continue;
        try {
            const tStat = await stat(target);
            const size = tStat.isDirectory() ? await dirSize(target) : tStat.size;
            await rm(target, { recursive: true, force: true });
            bytes += size;
            removed++;
        } catch (err) {
            console.warn(`[deploy] failed to remove ${target}: ${err.message}`);
        }
    }
    const rel = path.relative(REPO_ROOT, abs).replaceAll('\\', '/');
    console.log(`[deploy] ${rel} — stripped ${removed} entr${removed === 1 ? 'y' : 'ies'}, freed ${formatBytes(bytes)}`);
}

async function processAll() {
    if (!existsSync(SNAPSHOTS_ROOT)) {
        console.error(`[deploy] no snapshots folder at ${SNAPSHOTS_ROOT}`);
        process.exit(1);
    }
    const entries = await readdir(SNAPSHOTS_ROOT, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => path.join(SNAPSHOTS_ROOT, e.name));
    if (dirs.length === 0) {
        console.log('[deploy] no iter folders to deploy');
        return;
    }
    for (const dir of dirs) await stripIter(dir);
}

function watchMode(root) {
    const watchRoot = path.resolve(root || SNAPSHOTS_ROOT);
    if (!existsSync(watchRoot)) {
        console.error(`[deploy] no snapshots folder at ${watchRoot}; create it first`);
        process.exit(1);
    }
    console.log(`[deploy] watching ${path.relative(REPO_ROOT, watchRoot).replaceAll('\\', '/') || '.'}/`);
    console.log('[deploy] auto-strip on snapshot.json arrival; Ctrl-C to stop');

    // Debounce per-iter: a single export touches snapshot.json multiple times.
    const pending = new Map();

    const watcher = watchSync(watchRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const norm = filename.replaceAll('\\', '/');
        if (!norm.endsWith('snapshot.json')) return;
        const iterRel = norm.split('/')[0];
        if (!iterRel) return;
        const iter = path.join(watchRoot, iterRel);

        if (pending.has(iter)) clearTimeout(pending.get(iter));
        pending.set(iter, setTimeout(() => {
            pending.delete(iter);
            stripIter(iter).catch((err) => console.warn(`[deploy] watch error: ${err.message}`));
        }, 600));
    });

    process.on('SIGINT', () => {
        watcher.close();
        for (const t of pending.values()) clearTimeout(t);
        console.log('\n[deploy] watcher stopped');
        process.exit(0);
    });
}

// ─── main ────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage:');
        console.error('  node scripts/snapshot-deploy.mjs <iter-folder> [...more]');
        console.error('  node scripts/snapshot-deploy.mjs --all');
        console.error('  node scripts/snapshot-deploy.mjs --watch [snapshots-root]');
        process.exit(1);
    }

    if (args.includes('--watch')) {
        const i = args.indexOf('--watch');
        const root = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
        watchMode(root);
        return;
    }

    if (args.includes('--all')) {
        await processAll();
        return;
    }

    for (const arg of args) {
        if (arg.startsWith('--')) continue;
        await stripIter(arg);
    }
}

main().catch((err) => { console.error('[deploy] fatal:', err); process.exit(1); });
