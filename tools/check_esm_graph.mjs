#!/usr/bin/env node
// check_esm_graph.mjs — split-safety tripwire for the web/ module graph.
//
// `node --check` only catches syntax errors; a module that imports a name its
// target never exports parses fine and dies at load time in the viewer. This
// walks every local (relative) import in web/index.html, web/snapshot*.html and
// web/js/** and verifies:
//   1. the target file exists,
//   2. every named import resolves to a real export (following re-exports and
//      export * chains),
//   3. dynamic import('./x.js') literals point at real files.
// Bare specifiers (three, three-std, speedball-gi, CDN URLs) are importmap
// territory and are skipped.
//
// Usage: node tools/check_esm_graph.mjs   (exit 1 on any failure)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const SKIP_DIRS = new Set(['vendor', 'node_modules']);

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (!SKIP_DIRS.has(name)) walkJs(full, out);
        } else if (name.endsWith('.js') || name.endsWith('.mjs')) {
            out.push(full);
        }
    }
    return out;
}

function moduleScripts(htmlPath) {
    const html = readFileSync(htmlPath, 'utf8');
    const scripts = [];
    const re = /<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) if (m[1].trim()) scripts.push(m[1]);
    return scripts;
}

function isLocal(spec) {
    return spec.startsWith('./') || spec.startsWith('../');
}

// --- import extraction (regex tripwire, not a parser: imports at line start) ---
function parseImports(source) {
    const imports = []; // {spec, names:[...], hasDefault, hasStar, dynamic}
    const stmtRe = /^[ \t]*import\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm;
    let m;
    while ((m = stmtRe.exec(source))) {
        const clause = m[1];
        const entry = { spec: m[2], names: [], hasDefault: false, hasStar: false };
        const named = clause.match(/\{([\s\S]*?)\}/);
        if (named) {
            for (const part of named[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (name) entry.names.push(name);
            }
        }
        const outside = clause.replace(/\{[\s\S]*?\}/, '');
        if (/\*\s*as\s+[\w$]+/.test(outside)) entry.hasStar = true;
        if (/(^|,)\s*[\w$]+\s*(,|$)/.test(outside)) entry.hasDefault = true;
        imports.push(entry);
    }
    const sideRe = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
    while ((m = sideRe.exec(source))) {
        imports.push({ spec: m[1], names: [], hasDefault: false, hasStar: false });
    }
    const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynRe.exec(source))) {
        imports.push({ spec: m[1], names: [], hasDefault: false, hasStar: false, dynamic: true });
    }
    return imports;
}

// --- export extraction, following re-export / export * chains ---
const exportCache = new Map();
function exportsOf(file, seen = new Set()) {
    if (exportCache.has(file)) return exportCache.get(file);
    if (seen.has(file)) return new Set();
    seen.add(file);
    const names = new Set();
    let src;
    try { src = readFileSync(file, 'utf8'); }
    catch { exportCache.set(file, names); return names; }

    let m;
    const decl = /^[ \t]*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/gm;
    while ((m = decl.exec(src))) names.add(m[1]);
    const destr = /^[ \t]*export\s+(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/gm;
    while ((m = destr.exec(src))) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/[:=]/)[0].trim();
            if (/^[\w$]+$/.test(name)) names.add(name);
        }
    }
    if (/^[ \t]*export\s+default\b/m.test(src)) names.add('default');
    const block = /^[ \t]*export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm;
    while ((m = block.exec(src))) {
        for (const part of m[1].split(',')) {
            const bits = part.trim().split(/\s+as\s+/);
            const name = (bits[1] || bits[0]).trim();
            if (name) names.add(name);
        }
    }
    const star = /^[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm;
    while ((m = star.exec(src))) {
        if (isLocal(m[1])) {
            for (const n of exportsOf(resolve(dirname(file), m[1]), seen)) names.add(n);
        }
    }
    exportCache.set(file, names);
    return names;
}

// --- run ---
const failures = [];
const sources = []; // {label, baseDir, source}

for (const html of ['index.html', 'snapshot.html', 'snapshot_webgpu.html']) {
    const p = join(WEB, html);
    if (!existsSync(p)) continue;
    moduleScripts(p).forEach((s, i) =>
        sources.push({ label: `web/${html}#module${i}`, baseDir: WEB, source: s }));
}
for (const file of walkJs(join(WEB, 'js'))) {
    sources.push({
        label: relative(ROOT, file).split(sep).join('/'),
        baseDir: dirname(file),
        source: readFileSync(file, 'utf8'),
    });
}

let importCount = 0;
for (const { label, baseDir, source } of sources) {
    for (const imp of parseImports(source)) {
        if (!isLocal(imp.spec)) continue;
        importCount++;
        // browsers allow ?cache-buster / #hash suffixes on module URLs
        const target = resolve(baseDir, imp.spec.replace(/[?#].*$/, ''));
        if (!existsSync(target)) {
            failures.push(`${label}: ${imp.dynamic ? 'import()' : 'import'} '${imp.spec}' — file not found`);
            continue;
        }
        if (imp.dynamic || (!imp.names.length && !imp.hasDefault)) continue;
        const avail = exportsOf(target);
        for (const name of imp.names) {
            if (!avail.has(name)) {
                failures.push(`${label}: '${name}' not exported by '${imp.spec}'`);
            }
        }
        if (imp.hasDefault && !avail.has('default')) {
            failures.push(`${label}: default import but '${imp.spec}' has no default export`);
        }
    }
}

if (failures.length) {
    console.error(`check_esm_graph: ${failures.length} FAILURE(S) (${importCount} local imports checked)`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}
console.log(`check_esm_graph: OK — ${importCount} local imports across ${sources.length} modules resolve.`);
