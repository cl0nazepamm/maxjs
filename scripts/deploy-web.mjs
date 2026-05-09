#!/usr/bin/env node
//
// deploy-web.mjs — mirror this repo's `web/` runtime into clone-llc.
//
// clone-llc is a maxjs working folder (MAXJS_WEB_DIR points there at
// launch). Whenever `web/js/*`, `web/snapshot.html`, `web/index.html`,
// `web/vendor/*` etc. change in this repo, clone-llc needs the same
// bytes for the live Max viewer (and `snapshot.html`) to pick them up.
//
// Usage:
//   node scripts/deploy-web.mjs               # one-shot sync, no deletes
//   node scripts/deploy-web.mjs --watch       # continuous, debounced
//   node scripts/deploy-web.mjs --target=PATH # override destination
//   node scripts/deploy-web.mjs --paths=js,snapshot.html  # only those
//
// Behavior:
//   - Files in web/* that are newer (or missing in dst) are copied.
//   - Files only in clone-llc that don't exist in web/ are LEFT ALONE.
//     This is critical: clone-llc has its own `.max` files, AGENTS.md,
//     CLAUDE.md, launch-max.bat, _concepts/, project.maxjs.json,
//     inlines/, geo/, ref/, sfx/ — none of which live in web/. The
//     deploy script must never touch them.
//   - node_modules/ and vendor/ are huge but rarely change; we still
//     stat-check them so a vendor bump propagates. First sync of these
//     is the slow one.

import { stat, mkdir, readdir, copyFile } from 'node:fs/promises';
import { existsSync, watch as watchSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const SRC_DEFAULT = path.join(REPO_ROOT, 'web');
const DST_DEFAULT = path.resolve(REPO_ROOT, '..', 'clone-llc');

// Subpaths under web/ that are generated runtime data and should never be
// mirrored into a project folder.
const ARTIFACT_SUBPATHS = new Set(['snapshots']);

// Subpaths under web/ that are huge but worth syncing the first time.
// Watch mode skips these by default unless --include-vendor is passed,
// since they don't change during normal iteration.
const HEAVY_SUBPATHS = new Set(['vendor', 'node_modules']);

function parseArgs(argv) {
    const args = {
        watch: false,
        target: DST_DEFAULT,
        paths: null,
        includeVendor: false,
    };
    for (const a of argv) {
        if (a === '--watch') args.watch = true;
        else if (a === '--include-vendor') args.includeVendor = true;
        else if (a.startsWith('--target=')) args.target = path.resolve(a.slice('--target='.length));
        else if (a.startsWith('--paths=')) args.paths = a.slice('--paths='.length).split(',').map(s => s.trim()).filter(Boolean);
    }
    return args;
}

async function ensureDir(dir) {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function maybeCopy(src, dst, stats) {
    let dstStats = null;
    if (existsSync(dst)) {
        try { dstStats = await stat(dst); } catch {}
    }
    if (
        dstStats &&
        dstStats.size === stats.size &&
        Math.floor(dstStats.mtimeMs) >= Math.floor(stats.mtimeMs)
    ) {
        return false; // up to date
    }
    await ensureDir(path.dirname(dst));
    await copyFile(src, dst);
    return true;
}

async function syncDir(srcDir, dstDir, opts, accum) {
    const entries = await readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const subSrc = path.join(srcDir, entry.name);
        const subDst = path.join(dstDir, entry.name);

        if (entry.isDirectory()) {
            await syncDir(subSrc, subDst, opts, accum);
        } else if (entry.isFile()) {
            const stats = await stat(subSrc);
            const copied = await maybeCopy(subSrc, subDst, stats);
            if (copied) {
                accum.copied++;
                accum.bytes += stats.size;
            } else {
                accum.skipped++;
            }
        }
    }
}

async function syncOnce({ src, dst, paths, skipHeavy }) {
    if (!existsSync(src)) {
        console.error(`[deploy-web] source missing: ${src}`);
        process.exit(1);
    }
    if (!existsSync(dst)) {
        console.error(`[deploy-web] target missing: ${dst}`);
        console.error('[deploy-web] refusing to create — point at an existing folder.');
        process.exit(1);
    }

    const accum = { copied: 0, skipped: 0, bytes: 0 };
    const tStart = performance.now();

    const targets = paths && paths.length
        ? paths
        : (await readdir(src, { withFileTypes: true })).map(e => e.name);

    for (const name of targets) {
        if (ARTIFACT_SUBPATHS.has(name)) continue;
        if (skipHeavy && HEAVY_SUBPATHS.has(name)) continue;
        const subSrc = path.join(src, name);
        const subDst = path.join(dst, name);
        if (!existsSync(subSrc)) {
            console.warn(`[deploy-web] skip (missing in src): ${name}`);
            continue;
        }
        const sStat = await stat(subSrc);
        if (sStat.isDirectory()) {
            await syncDir(subSrc, subDst, { skipHeavy }, accum);
        } else if (sStat.isFile()) {
            const copied = await maybeCopy(subSrc, subDst, sStat);
            if (copied) { accum.copied++; accum.bytes += sStat.size; }
            else accum.skipped++;
        }
    }

    const ms = performance.now() - tStart;
    const fmt = (n) => n < 1024 ? `${n} B`
        : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
        : n < 1024 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
        : `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    console.log(
        `[deploy-web] ${accum.copied} copied, ${accum.skipped} skipped, ` +
        `${fmt(accum.bytes)} in ${ms.toFixed(0)} ms` +
        (skipHeavy ? '  (skipped vendor/, node_modules/)' : ''),
    );
    return accum;
}

function watchMode({ src, dst, paths }) {
    if (!existsSync(src)) {
        console.error(`[deploy-web] source missing: ${src}`);
        process.exit(1);
    }
    if (!existsSync(dst)) {
        console.error(`[deploy-web] target missing: ${dst}`);
        process.exit(1);
    }

    console.log(`[deploy-web] watching ${path.relative(REPO_ROOT, src) || '.'}/`);
    console.log(`[deploy-web] target ${dst}`);
    console.log(`[deploy-web] vendor/ + node_modules/ skipped in watch mode (use --include-vendor to include)`);

    let pending = null;

    const watcher = watchSync(src, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const norm = filename.replaceAll('\\', '/');
        // Skip heavy subtrees in watch mode entirely.
        const top = norm.split('/')[0];
        if (ARTIFACT_SUBPATHS.has(top)) return;
        if (HEAVY_SUBPATHS.has(top)) return;

        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
            pending = null;
            syncOnce({ src, dst, paths, skipHeavy: true })
                .catch((err) => console.warn(`[deploy-web] sync error: ${err.message}`));
        }, 200);
    });

    process.on('SIGINT', () => {
        watcher.close();
        if (pending) clearTimeout(pending);
        console.log('\n[deploy-web] watcher stopped');
        process.exit(0);
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.watch) {
        // Initial sync (skip heavy unless explicitly included).
        await syncOnce({
            src: SRC_DEFAULT,
            dst: args.target,
            paths: args.paths,
            skipHeavy: !args.includeVendor,
        });
        watchMode({ src: SRC_DEFAULT, dst: args.target, paths: args.paths });
        return;
    }

    await syncOnce({
        src: SRC_DEFAULT,
        dst: args.target,
        paths: args.paths,
        skipHeavy: !args.includeVendor,
    });
}

main().catch((err) => { console.error('[deploy-web] fatal:', err); process.exit(1); });
