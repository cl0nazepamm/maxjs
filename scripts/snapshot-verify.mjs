#!/usr/bin/env node
//
// snapshot-verify.mjs — offline regression gate for MaxJS exports.
//
// Proves that snapshot.json + scene.bin did NOT change accidentally across a
// refactor, WITHOUT a running 3ds Max. Compares two already-exported snapshot
// folders (an expected/golden folder and an actual/candidate folder).
//
// Per the project's determinism analysis, raw byte-compare is NOT a valid gate:
//   - vertex/uv/normal/transform floats re-evaluate to bit-different values
//     (FP non-associativity + threaded reductions) for an unchanged scene;
//   - ForestPack/RailClone/tyFlow forestInstances[].src/.key are
//     reinterpret_cast<uintptr_t>(Mesh*) and differ every process run;
//   - asset URLs embed absolute paths / FNV1a(abspath) hashes (machine-dependent);
//   - top-level camera / node selection / animation current-time are editor state.
// So this harness is TIERED + SEMANTIC:
//   BYTE_IDENTICAL  > SEMANTICALLY_IDENTICAL (PASS)
//                   > DRIFT (PASS+warn: only ptr keys / handles / editor state /
//                            sub-tolerance float jitter differ)
//                   > MISMATCH (FAIL: structural — node/material count, topology,
//                            index buffers, material values, animation track set,
//                            or a material texture-key SET change).
//
// Usage:
//   node scripts/snapshot-verify.mjs <expectedDir> <actualDir> [options]
// See --help for options. Exit: 0 PASS, 1 MISMATCH/strict-drift, 2 usage error.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ───────────────────────────── arg parsing ──────────────────────────────────

function parseArgs(argv) {
    const out = {
        expected: null, actual: null, tol: 1e-4, builderCrosscheck: null,
        json: false, strictDrift: false, selftest: false, help: false,
    };
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') out.help = true;
        else if (a === '--json') out.json = true;
        else if (a === '--strict-drift') out.strictDrift = true;
        else if (a === '--selftest') out.selftest = true;
        else if (a === '--tol') out.tol = Number(argv[++i]);
        else if (a === '--builder-crosscheck') out.builderCrosscheck = argv[++i];
        else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        else pos.push(a);
    }
    out.expected = pos[0] ?? null;
    out.actual = pos[1] ?? null;
    return out;
}

const HELP = `snapshot-verify.mjs — offline MaxJS snapshot regression gate

  node scripts/snapshot-verify.mjs <expectedDir> <actualDir> [options]

  <expectedDir>   golden snapshot folder (snapshot.json [+ scene.bin])
  <actualDir>     candidate snapshot folder to validate

Options:
  --tol <rel>                 float relative tolerance (default 1e-4)
  --builder-crosscheck <path> material_builder.js to scan for reader keys
  --json                      machine-readable JSON report on stdout
  --strict-drift              treat DRIFT as failure (exit 1)
  --selftest                  run built-in canonicalizer checks and exit
  -h | --help                 this help

Exit: 0 PASS (BYTE_IDENTICAL/SEMANTICALLY_IDENTICAL/DRIFT)
      1 MISMATCH (or DRIFT with --strict-drift)
      2 usage / missing fixture
`;

// ───────────────────────── numeric comparison ───────────────────────────────

function floatsClose(a, b, relTol) {
    if (a === b) return true;
    // Exported buffers legitimately contain NaN (unused uv2 slots, padding). NaN-vs-NaN
    // is "unchanged" and must NOT register as a diff; NaN-vs-number IS a real change.
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;   // ±Infinity
    const diff = Math.abs(a - b);
    if (diff <= relTol) return true;                 // absolute floor for near-zero
    const scale = Math.max(Math.abs(a), Math.abs(b));
    return diff <= relTol * scale;                   // relative
}

// ───────────────────────── URL / handle helpers ─────────────────────────────

// Normalize machine-specific asset URLs to a stable token that STILL distinguishes
// distinct source files. We strip only the volatile scheme/host wrapper, never the
// directory or content hash — two different files must not collapse to one token.
// (Golden pairs are generated on the same machine, so absolute paths match; this is
// the harness's pinned condition.)
function normalizeAssetUrl(v) {
    if (typeof v !== 'string') return v;
    // ./assets/file_<hash>.ext or ./assets/dir_<hash>/... — KEEP the FNV1a hash; it
    // identifies the source, so distinct sources stay distinct. Only the leading
    // ./ wrapper is normalized away.
    let m = v.match(/(?:\.?\/)?assets\/((?:file|dir)_[0-9a-fA-F]+)(\.[A-Za-z0-9]+)?$/);
    if (m) return `asset:${m[1]}${m[2] ?? ''}`;
    // https://maxjs-assets.local/<urlencoded-abs-path> — KEEP the full decoded path
    // so brick.jpg in two different directories does not collapse to one token.
    m = v.match(/^https?:\/\/maxjs-assets\.local\/(.+)$/);
    if (m) {
        let decoded = m[1];
        try { decoded = decodeURIComponent(m[1]); } catch { /* keep raw */ }
        return `asset:${decoded.replace(/\\/g, '/')}`;
    }
    // tsl://procedural and html://managed are stable sentinels — keep as-is.
    return v;
}

function looksLikeUrl(key, value) {
    if (typeof value !== 'string') return false;
    if (value.startsWith('https://maxjs-assets.local/')) return true;
    if (/(?:^|\/)assets\/(?:file|dir)_[0-9a-fA-F]+/.test(value)) return true;
    return false;
}

// Editor-state / session-volatile fields to drop entirely before compare.
const DROP_TOP_KEYS = new Set(['camera']);              // live viewport view
const DROP_NODE_KEYS = new Set(['s']);                  // selection flag
// pointer-derived instance keys (remapped, not dropped — see remapForestKeys)

// ───────────────────── snapshot.json canonicalization ───────────────────────

// Build a stable id per node from DFS path + name, and a map old-handle -> id.
function buildNodeIdMap(nodes) {
    const handleToId = new Map();
    if (!Array.isArray(nodes)) return handleToId;
    // Reconstruct DFS path using parent handle 'p'. Fall back to array order.
    const byHandle = new Map();
    nodes.forEach((n, i) => { if (n && n.h != null) byHandle.set(n.h, n); n.__idx = i; });
    const pathCache = new Map();
    const pathOf = (n, guard = 0) => {
        if (!n || guard > 4096) return `#${n?.__idx ?? '?'}`;
        if (pathCache.has(n)) return pathCache.get(n);
        const name = n.n ?? n.name ?? '';
        const parent = (n.p != null && byHandle.has(n.p) && byHandle.get(n.p) !== n)
            ? byHandle.get(n.p) : null;
        const p = parent ? `${pathOf(parent, guard + 1)}/${name}` : `/${name}`;
        // disambiguate same-path siblings by array index
        const id = `${p}#${n.__idx}`;
        pathCache.set(n, id);
        return id;
    };
    nodes.forEach(n => { if (n && n.h != null) handleToId.set(n.h, pathOf(n)); });
    return handleToId;
}

// Replace pointer-derived forestInstances src/key with array-order indices,
// consistently across any node references.
function remapForestKeys(root) {
    const fi = root && root.forestInstances;
    if (!Array.isArray(fi)) return new Map();
    const keyToIdx = new Map();
    fi.forEach((g, i) => {
        const k = g && (g.key ?? g.src);
        if (k != null && !keyToIdx.has(String(k))) keyToIdx.set(String(k), i);
    });
    return keyToIdx;
}

// Deep canonicalizer: returns a structure-only clone with volatile data removed
// or remapped. `handleToId` and `forestKeyToIdx` drive remapping; `drops`
// chooses which key-set is active for the current object depth.
function canonicalize(value, ctx, where = 'top', keyName = null) {
    if (Array.isArray(value)) {
        return value.map((v, i) => canonicalize(v, ctx, where, keyName));
    }
    if (value && typeof value === 'object') {
        const out = {};
        const isNode = where === 'node';
        for (const k of Object.keys(value).sort()) {
            if (where === 'top' && DROP_TOP_KEYS.has(k)) continue;
            if (isNode && DROP_NODE_KEYS.has(k)) continue;
            // scene.bin byte offsets (vOff/iOff/uvOff/nOff/wOff/bindOff/dOff …) carry no
            // scene meaning: compareSceneBin slices the buffer by these from the RAW
            // root and aligns by node id, so a benign re-layout must not diff here.
            if (isNode && /Off$/.test(k)) continue;
            // editor-state current-time, ONLY at the animations root and per-clip level
            // — NOT recursively. Per-keyframe times live deeper (as 'times'/'timesRef')
            // and are real data that must still be compared.
            if ((where === 'animRoot' || where === 'animClips') && (k === 'time' || k === 'curFrame')) continue;

            let child = value[k];
            let nextWhere = where;
            if (where === 'top' && k === 'nodes') nextWhere = 'nodes';
            else if (where === 'nodes') nextWhere = 'node';      // array elements handled above
            else if (where === 'top' && k === 'animations') nextWhere = 'animRoot';
            else if (where === 'animRoot' && k === 'clips') nextWhere = 'animClips';
            else if (where === 'animRoot' || where === 'animClips') nextWhere = 'animDeep';

            // forestInstances src/key -> stable array index
            if (where === 'top' && k === 'forestInstances') {
                child = canonicalizeForest(child, ctx);
                out[k] = child;
                continue;
            }
            out[k] = canonicalizeLeafOrRecurse(k, child, ctx, nextWhere);
        }
        return out;
    }
    return value;
}

function canonicalizeForest(fi, ctx) {
    if (!Array.isArray(fi)) return fi;
    return fi.map((g) => {
        if (!g || typeof g !== 'object') return g;
        const o = {};
        for (const k of Object.keys(g).sort()) {
            if (k === 'key' || k === 'src') {
                const idx = ctx.forestKeyToIdx.get(String(g[k]));
                o[k] = idx == null ? '#?' : `forest#${idx}`;
            } else {
                o[k] = canonicalizeLeafOrRecurse(k, g[k], ctx, 'forest');
            }
        }
        return o;
    });
}

function canonicalizeLeafOrRecurse(key, child, ctx, where) {
    // handle references -> stable ids
    if ((key === 'h' || key === 'p' || key === 'lockedCamera') && typeof child === 'number') {
        return ctx.handleToId.has(child) ? ctx.handleToId.get(child) : `h:${child}`;
    }
    if (typeof child === 'string') {
        const hm = child.match(/^handle:(\d+)$/);
        if (hm) {
            const h = Number(hm[1]);
            return ctx.handleToId.has(h) ? `target:${ctx.handleToId.get(h)}` : child;
        }
        if (looksLikeUrl(key, child)) return normalizeAssetUrl(child);
        return child;
    }
    if (Array.isArray(child) || (child && typeof child === 'object')) {
        return canonicalize(child, ctx, where, key);
    }
    return child;
}

function canonicalizeSnapshot(root) {
    const ctx = {
        handleToId: buildNodeIdMap(root && root.nodes),
        forestKeyToIdx: remapForestKeys(root),
    };
    // nodes need where='node' for their own elements; canonicalize handles arrays
    // generically, but node array elements must drop selection. We tag them by
    // routing nodes through a node-aware pass.
    const clone = canonicalize(root, ctx, 'top');
    if (Array.isArray(root && root.nodes)) {
        clone.nodes = root.nodes.map(n => canonicalize(n, ctx, 'node'));
    }
    return clone;
}

// ───────────────────────── deep semantic diff ───────────────────────────────

function deepDiff(a, b, relTol, pathStr, diffs) {
    if (typeof a === 'number' && typeof b === 'number') {
        if (!floatsClose(a, b, relTol)) diffs.push({ path: pathStr, a, b, kind: 'number' });
        return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            diffs.push({ path: pathStr, a: `len ${a.length}`, b: `len ${b.length}`, kind: 'arrlen' });
            return;
        }
        for (let i = 0; i < a.length; i++) deepDiff(a[i], b[i], relTol, `${pathStr}[${i}]`, diffs);
        return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            if (!(k in a)) { diffs.push({ path: `${pathStr}.${k}`, a: undefined, b: b[k], kind: 'addkey' }); continue; }
            if (!(k in b)) { diffs.push({ path: `${pathStr}.${k}`, a: a[k], b: undefined, kind: 'delkey' }); continue; }
            deepDiff(a[k], b[k], relTol, `${pathStr}.${k}`, diffs);
        }
        return;
    }
    if (a !== b) diffs.push({ path: pathStr, a, b, kind: 'scalar' });
}

// Classify each diff as structural (MISMATCH) vs benign (DRIFT).
const STRUCTURAL_PATH_HINTS = [
    /\.materials(\b|\[)/, /\.geo\b/, /\.skin\b/, /\.morph\b/, /\.groups\b/,
    /\.matRef\b/, /\.matRefs\b/, /\.model\b/, /\.iN\b/, /\.vN\b/, /\.clips\b/,
];
// A diff is benign DRIFT only when BOTH sides are canonicalization-resistant
// volatile tokens: an unmapped session handle (`h:<n>`), an unresolved forest
// key (`#?`), or a raw `handle:<n>` target that no node map could resolve. These
// are session artifacts, not scene data, so they must not be treated as real
// changes — but they are surfaced (DRIFT, fails under --strict-drift).
function isVolatileToken(v) {
    return typeof v === 'string' &&
        (/^h:\d+$/.test(v) || /^#\?$/.test(v) || /^handle:\d+$/.test(v) || /^target:/.test(v));
}
function classifyDiffs(diffs) {
    let structural = 0;
    const samples = [];
    for (const d of diffs) {
        // Benign drift: a scalar swap between two unresolved volatile tokens on a
        // non-structural path (e.g. two different unmapped handles). Real scene
        // data never canonicalizes to these sentinels.
        if (d.kind === 'scalar' && isVolatileToken(d.a) && isVolatileToken(d.b) &&
            !STRUCTURAL_PATH_HINTS.some(re => re.test(d.path))) {
            continue; // benign -> contributes to DRIFT, not MISMATCH
        }
        // Every diff that reaches here survived canonicalization AND tolerance:
        //   - benign pointer keys / handles / asset URLs / editor state were
        //     dropped or normalized before diffing, so they produce NO diff;
        //   - sub-tolerance float jitter was already filtered in deepDiff /
        //     compareSceneBin, so a surviving 'number' diff is a real value
        //     change (geometry, transform, material scalar) past tolerance.
        // Therefore a surviving 'number' diff is structural (this is what the
        // determinism analysis means by "only sub-tolerance jitter is benign").
        // Structure-level diffs (add/del key, array-length, scalar string/bool,
        // and anything on a known structural path) are structural too.
        const isStructural =
            d.kind === 'addkey' || d.kind === 'delkey' || d.kind === 'arrlen' ||
            d.kind === 'scalar' || d.kind === 'number' ||
            STRUCTURAL_PATH_HINTS.some(re => re.test(d.path));
        if (isStructural) { structural++; if (samples.length < 25) samples.push(d); }
    }
    return { structural, samples };
}

// ───────────────────────── material key auditing ────────────────────────────

const KNOWN_MATERIAL_TEXTURE_KEYS = [
    'map', 'gradMap', 'roughMap', 'metalMap', 'normMap', 'bumpMap', 'dispMap',
    'parallaxMap', 'aoMap', 'sssMap', 'matcapMap', 'specMap', 'specIntMap',
    'specColMap', 'emMap', 'lmMap', 'opMap', 'transMap', 'ccMap', 'ccRoughMap',
    'ccNormMap',
];

function collectMaterials(root) {
    // materials live under root.materials = [{id, hash, mat:{...}}], either as the
    // parsed object or — in some folders — re-stringified. Handle both.
    const arr = root && root.materials;
    if (!Array.isArray(arr)) return [];
    return arr.map(e => (e && e.mat) ? e.mat : e).filter(Boolean);
}

function materialTextureKeySet(mat) {
    const set = new Set();
    for (const k of Object.keys(mat)) {
        if (KNOWN_MATERIAL_TEXTURE_KEYS.includes(k)) set.add(k);
    }
    return set;
}

// Scan material_builder.js for reader urlKeys so we can flag write-only keys.
async function loadBuilderReaderKeys(builderPath) {
    const src = await readFile(builderPath, 'utf8');
    const keys = new Set();
    const re = /urlKeys\s*:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        for (const lit of m[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) keys.add(lit[1]);
    }
    return keys;
}

// ───────────────────────── scene.bin comparison ─────────────────────────────

const TYPE_BYTES = { f32: 4, u32: 4, u16: 2, u8: 1, i32: 4, i16: 2 };
function readTyped(buf, off, count, type) {
    const t = (type || 'f32').toLowerCase();
    const out = new Array(count);
    const stride = TYPE_BYTES[t] ?? 4;
    for (let i = 0; i < count; i++) {
        const p = off + i * stride;
        if (p + stride > buf.length) { out[i] = NaN; continue; }
        switch (t) {
            case 'f32': out[i] = buf.readFloatLE(p); break;
            case 'u32': out[i] = buf.readUInt32LE(p); break;
            case 'u16': out[i] = buf.readUInt16LE(p); break;
            case 'u8':  out[i] = buf.readUInt8(p); break;
            case 'i32': out[i] = buf.readInt32LE(p); break;
            case 'i16': out[i] = buf.readInt16LE(p); break;
            default:    out[i] = buf.readFloatLE(p);
        }
    }
    return out;
}

// Pull (off,count,type) ranges declared in a node's geo/skin/morph metadata.
function nodeBinRanges(node) {
    const ranges = [];
    const g = node && node.geo;
    if (g) {
        const add = (offK, nK, typeK, label, exact) => {
            if (g[offK] != null && g[nK] != null) {
                ranges.push({ off: g[offK], count: g[nK], type: g[typeK] || 'f32', label, exact: !!exact });
            }
        };
        add('vOff', 'vN', null, 'verts', false);
        add('iOff', 'iN', 'iType', 'indices', true);
        add('uvOff', 'uvN', 'uvType', 'uv', false);
        add('uv2Off', 'uv2N', 'uv2Type', 'uv2', false);
        add('nOff', 'nN', 'nType', 'normals', false);
    }
    const s = node && node.skin;
    if (s) {
        if (s.wOff != null && s.wN != null) ranges.push({ off: s.wOff, count: s.wN, type: s.wType || 'f32', label: 'skinW', exact: false });
        if (s.iOff != null && s.iN != null) ranges.push({ off: s.iOff, count: s.iN, type: s.iType || 'u16', label: 'skinIdx', exact: true });
        if (s.bindOff != null && s.bindN != null) ranges.push({ off: s.bindOff, count: s.bindN, type: 'f32', label: 'skinBind', exact: false });
    }
    const mo = node && node.morph;
    if (mo && Array.isArray(mo.dOff) && Array.isArray(mo.dN)) {
        for (let i = 0; i < mo.dOff.length; i++) {
            ranges.push({ off: mo.dOff[i], count: mo.dN[i], type: 'f32', label: `morph${i}`, exact: false });
        }
    }
    return ranges;
}

function compareSceneBin(expRoot, actRoot, expBin, actBin, relTol, diffs) {
    // Align by canonical node id (DFS path + name), NOT by byte offset.
    const expNodes = Array.isArray(expRoot.nodes) ? expRoot.nodes : [];
    const actNodes = Array.isArray(actRoot.nodes) ? actRoot.nodes : [];
    const expIds = buildNodeIdMap(expNodes);
    const actIds = buildNodeIdMap(actNodes);
    const idToExp = new Map();
    expNodes.forEach(n => { if (n && n.h != null && expIds.has(n.h)) idToExp.set(expIds.get(n.h), n); });
    const idToAct = new Map();
    actNodes.forEach(n => { if (n && n.h != null && actIds.has(n.h)) idToAct.set(actIds.get(n.h), n); });

    for (const [id, eNode] of idToExp) {
        const aNode = idToAct.get(id);
        if (!aNode) { diffs.push({ path: `scene.bin/${id}`, kind: 'addkey', a: 'present', b: 'missing' }); continue; }
        const eR = nodeBinRanges(eNode);
        const aR = nodeBinRanges(aNode);
        if (eR.length !== aR.length) {
            diffs.push({ path: `scene.bin/${id}/ranges`, kind: 'arrlen', a: eR.length, b: aR.length });
            continue;
        }
        for (let i = 0; i < eR.length; i++) {
            const er = eR[i], ar = aR[i];
            if (er.count !== ar.count) {
                diffs.push({ path: `scene.bin/${id}/${er.label}`, kind: 'arrlen', a: er.count, b: ar.count });
                continue;
            }
            const ea = readTyped(expBin, er.off, er.count, er.type);
            const aa = readTyped(actBin, ar.off, ar.count, ar.type);
            for (let j = 0; j < ea.length; j++) {
                const ok = er.exact ? ea[j] === aa[j] : floatsClose(ea[j], aa[j], relTol);
                if (!ok) {
                    diffs.push({ path: `scene.bin/${id}/${er.label}[${j}]`, kind: er.exact ? 'scalar' : 'number', a: ea[j], b: aa[j] });
                    break; // one sample per range is enough to flag
                }
            }
        }
    }
}

// scene_anim.bin comparison. Baked animation tracks (times + values) live in a
// SEPARATE binary referenced by root.animations.bin; the scene.bin compare never
// touches it, so a keyframe regression with stable JSON offsets would otherwise pass
// as BYTE_IDENTICAL. Per-track typed decode via animations[].timesRef/valuesRef is a
// follow-up tied to the deferred animation-codec work; for now we tolerant-sweep the
// buffer as packed f32 (its dominant content), which catches value regressions while
// tolerating benign FP re-evaluation jitter. Byte-equal words are skipped first, so
// non-float / NaN regions never produce a spurious diff.
function compareAnimBin(expBin, actBin, relTol, diffs) {
    if (Boolean(expBin) !== Boolean(actBin)) {
        diffs.push({ path: 'scene_anim.bin', kind: 'addkey', a: Boolean(expBin), b: Boolean(actBin) });
        return;
    }
    if (!expBin || !actBin) return;
    if (expBin.length !== actBin.length) {
        diffs.push({ path: 'scene_anim.bin/length', kind: 'arrlen', a: expBin.length, b: actBin.length });
        return;
    }
    const words = Math.floor(expBin.length / 4);
    for (let i = 0; i < words; i++) {
        const off = i * 4;
        if (expBin.readUInt32LE(off) === actBin.readUInt32LE(off)) continue; // identical bytes
        const e = expBin.readFloatLE(off), a = actBin.readFloatLE(off);
        if (!floatsClose(e, a, relTol)) {
            diffs.push({ path: `scene_anim.bin/f32[${i}]`, kind: 'number', a: e, b: a });
            break; // one out-of-tolerance sample is enough to flag the regression
        }
    }
}

// ───────────────────────────── IO helpers ───────────────────────────────────

// Resolve the optional separate animation-binary name. Baked keyframe times/values
// live there (NOT in scene.bin). Be defensive about the JSON shape and fall back to
// the conventional filename on disk so a schema guess can't reintroduce a blind spot.
function resolveAnimBinName(root, dir) {
    const a = root && root.animations;
    if (a && typeof a === 'object' && !Array.isArray(a) && typeof a.bin === 'string') return a.bin;
    if (root && typeof root.animBin === 'string') return root.animBin;
    if (existsSync(path.join(dir, 'scene_anim.bin'))) return 'scene_anim.bin';
    return null;
}

async function loadFolder(dir) {
    const jsonPath = path.join(dir, 'snapshot.json');
    if (!existsSync(jsonPath)) throw new Error(`missing snapshot.json in ${dir}`);
    const jsonBuf = await readFile(jsonPath);
    let root;
    try { root = JSON.parse(jsonBuf.toString('utf8')); }
    catch (e) { throw new Error(`snapshot.json in ${dir} is not valid JSON: ${e.message}`); }
    const binName = (root && typeof root.bin === 'string') ? root.bin : 'scene.bin';
    const binPath = path.join(dir, binName);
    const bin = existsSync(binPath) ? await readFile(binPath) : null;
    const animBinName = resolveAnimBinName(root, dir);
    const animBin = (animBinName && existsSync(path.join(dir, animBinName)))
        ? await readFile(path.join(dir, animBinName)) : null;
    return { root, jsonBuf, bin, binName, animBin, animBinName, dir };
}

// ───────────────────────────── self-test ────────────────────────────────────

function selftest() {
    let fails = 0;
    const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fails++; } };
    ok(floatsClose(1.0, 1.00005, 1e-4), 'sub-tol close');
    ok(!floatsClose(1.0, 1.5, 1e-4), 'far apart');
    ok(floatsClose(NaN, NaN, 1e-4), 'NaN equals NaN (unchanged buffer slot)');
    ok(!floatsClose(NaN, 5, 1e-4), 'NaN vs number is a real change');
    ok(normalizeAssetUrl('./assets/file_deadBEEF12.png') === 'asset:file_deadBEEF12.png', 'file_ url keeps hash');
    ok(normalizeAssetUrl('https://maxjs-assets.local/C%3A%2Ftex%2Fbrick.jpg') === 'asset:C:/tex/brick.jpg', 'maxjs url keeps path');
    ok(normalizeAssetUrl('https://maxjs-assets.local/C%3A%2Ftex%2Fbrick.jpg') !==
       normalizeAssetUrl('https://maxjs-assets.local/D%3A%2Fother%2Fbrick.jpg'), 'same-basename distinct dirs stay distinct');
    ok(normalizeAssetUrl('tsl://procedural') === 'tsl://procedural', 'tsl sentinel kept');
    const c = canonicalizeSnapshot({
        camera: { fov: 50 },
        nodes: [{ h: 1, n: 'a', s: true }, { h: 2, n: 'b', p: 1, s: false }],
        forestInstances: [{ key: '140737488', src: 140737488 }],
    });
    ok(c.camera === undefined, 'camera dropped');
    ok(c.nodes[0].s === undefined, 'selection dropped');
    ok(c.forestInstances[0].key === 'forest#0', 'forest key remapped');
    // geo byte-offsets dropped (benign re-layout must not diff); counts kept.
    const cgeo = canonicalizeSnapshot({ nodes: [{ h: 1, n: 'm', geo: { vOff: 50, vN: 3, iOff: 99, iN: 6 } }] });
    ok(cgeo.nodes[0].geo.vOff === undefined && cgeo.nodes[0].geo.iOff === undefined, 'geo offsets dropped');
    ok(cgeo.nodes[0].geo.vN === 3 && cgeo.nodes[0].geo.iN === 6, 'geo counts kept');
    // clip-level current-time dropped; a deeper (real) keyframe time preserved.
    const canim = canonicalizeSnapshot({ animations: { time: 12, clips: [{ time: 5, tracks: [{ times: [0, 1], time: 9 }] }] } });
    ok(canim.animations.time === undefined, 'anim-root time dropped');
    ok(canim.animations.clips[0].time === undefined, 'clip time dropped');
    ok(canim.animations.clips[0].tracks[0].time === 9, 'deep track time preserved');
    // anim-bin compare: identical-length buffers, one float past tol -> diff; equal -> none.
    const eBuf = Buffer.alloc(8), aBuf = Buffer.alloc(8);
    eBuf.writeFloatLE(1.0, 0); aBuf.writeFloatLE(51.0, 0);
    const abd = []; compareAnimBin(eBuf, aBuf, 1e-4, abd);
    ok(abd.length === 1 && abd[0].kind === 'number', 'anim-bin float regression caught');
    const abd2 = []; compareAnimBin(eBuf, eBuf, 1e-4, abd2);
    ok(abd2.length === 0, 'anim-bin identical -> no diff');
    const d1 = []; deepDiff({ x: 1 }, { x: 1.00002 }, 1e-4, '$', d1);
    ok(d1.length === 0, 'tolerant number eq');
    const d2 = []; deepDiff({ x: 1 }, { y: 1 }, 1e-4, '$', d2);
    ok(d2.length === 2, 'key add/del detected');
    // classifier: a numeric value past tolerance (e.g. a scene.bin vertex) is
    // structural -> MISMATCH, not benign drift.
    ok(classifyDiffs([{ path: 'scene.bin//A#0/verts[0]', kind: 'number', a: 0, b: 99 }]).structural === 1,
        'bin numeric diff is structural');
    ok(classifyDiffs([{ path: '$.nodes[0].t[3]', kind: 'number', a: 0, b: 5 }]).structural === 1,
        'transform numeric diff is structural');
    // classifier: a swap between two unmapped session handles is benign drift.
    ok(classifyDiffs([{ path: '$.someRef', kind: 'scalar', a: 'h:7', b: 'h:9' }]).structural === 0,
        'unmapped-handle swap is benign drift');
    // classifier: a real string change is structural.
    ok(classifyDiffs([{ path: '$.materials[0].name', kind: 'scalar', a: 'Red', b: 'Blue' }]).structural === 1,
        'material string diff is structural');
    console.error(fails === 0 ? 'selftest: PASS' : `selftest: ${fails} FAIL`);
    return fails === 0 ? 0 : 1;
}

// ───────────────────────────── main ─────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(HELP); return 0; }
    if (args.selftest) return selftest();
    if (!args.expected || !args.actual) {
        console.error('error: need <expectedDir> and <actualDir>\n');
        console.error(HELP);
        return 2;
    }
    for (const d of [args.expected, args.actual]) {
        if (!existsSync(d)) {
            console.error(`error: folder not found: ${d}`);
            if (/[\\/]dist$/.test(d)) {
                console.error('  (snapshot dist fixture is not present in this checkout;');
                console.error('   generate a golden snapshot pair before running the gate.)');
            }
            return 2;
        }
    }

    const exp = await loadFolder(args.expected);
    const act = await loadFolder(args.actual);

    const report = { verdict: 'UNKNOWN', tol: args.tol, warnings: [], diffs: [], keyAudit: {} };

    // Tier 1: byte-identical fast path (json + scene.bin + scene_anim.bin).
    const jsonByteEq = exp.jsonBuf.equals(act.jsonBuf);
    const binByteEq = (exp.bin && act.bin) ? exp.bin.equals(act.bin) : (exp.bin == null && act.bin == null);
    const animByteEq = (exp.animBin && act.animBin) ? exp.animBin.equals(act.animBin) : (exp.animBin == null && act.animBin == null);
    if (jsonByteEq && binByteEq && animByteEq) {
        report.verdict = 'BYTE_IDENTICAL';
        return finish(report, args);
    }

    // Tier 2: semantic compare on canonicalized JSON.
    const expCanon = canonicalizeSnapshot(exp.root);
    const actCanon = canonicalizeSnapshot(act.root);
    const jsonDiffs = [];
    deepDiff(expCanon, actCanon, args.tol, '$', jsonDiffs);

    // scene.bin semantic compare (typed, aligned by node id).
    const binDiffs = [];
    if (exp.bin && act.bin) {
        compareSceneBin(exp.root, act.root, exp.bin, act.bin, args.tol, binDiffs);
    } else if (Boolean(exp.bin) !== Boolean(act.bin)) {
        binDiffs.push({ path: 'scene.bin', kind: 'addkey', a: Boolean(exp.bin), b: Boolean(act.bin) });
    }

    // scene_anim.bin semantic compare (separate baked-animation binary).
    compareAnimBin(exp.animBin, act.animBin, args.tol, binDiffs);

    // Material texture-key set audit (catches a broken serialization refactor).
    const expMats = collectMaterials(exp.root);
    const actMats = collectMaterials(act.root);
    if (expMats.length !== actMats.length) {
        jsonDiffs.push({ path: '$.materials.length', kind: 'arrlen', a: expMats.length, b: actMats.length });
    } else {
        for (let i = 0; i < expMats.length; i++) {
            const ek = [...materialTextureKeySet(expMats[i])].sort().join(',');
            const ak = [...materialTextureKeySet(actMats[i])].sort().join(',');
            if (ek !== ak) jsonDiffs.push({ path: `$.materials[${i}].textureKeys`, kind: 'scalar', a: ek, b: ak });
        }
    }
    report.keyAudit.materialCount = actMats.length;

    // Optional: builder cross-check (flags write-only keys like parallaxMap/sssMap).
    if (args.builderCrosscheck && existsSync(args.builderCrosscheck)) {
        const readerKeys = await loadBuilderReaderKeys(args.builderCrosscheck);
        const emitted = new Set();
        for (const m of actMats) for (const k of materialTextureKeySet(m)) emitted.add(k);
        const writeOnly = [...emitted].filter(k => !readerKeys.has(k)).sort();
        report.keyAudit.writeOnlyKeys = writeOnly;
        if (writeOnly.length) {
            report.warnings.push(`material texture keys EMITTED but NOT read by ${path.basename(args.builderCrosscheck)}: ${writeOnly.join(', ')}`);
        }
    }

    const allDiffs = [...jsonDiffs, ...binDiffs];
    report.diffs = allDiffs.slice(0, 60);
    const { structural, samples } = classifyDiffs(allDiffs);

    if (allDiffs.length === 0) report.verdict = 'SEMANTICALLY_IDENTICAL';
    else if (structural === 0) report.verdict = 'DRIFT';
    else { report.verdict = 'MISMATCH'; report.structuralSamples = samples; }

    return finish(report, args);
}

function finish(report, args) {
    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const bar = '─'.repeat(60);
        console.log(bar);
        console.log(`VERDICT: ${report.verdict}`);
        for (const w of report.warnings) console.log(`  warn: ${w}`);
        if (report.verdict === 'MISMATCH') {
            console.log(`  structural diffs (showing up to 25):`);
            for (const d of (report.structuralSamples || [])) {
                console.log(`    ${d.path}  [${d.kind}]  expected=${fmt(d.a)}  actual=${fmt(d.b)}`);
            }
        } else if (report.verdict === 'DRIFT') {
            console.log(`  only benign drift (ptr keys / handles / editor-state / sub-tolerance jitter)`);
        }
        if (report.keyAudit?.writeOnlyKeys?.length)
            console.log(`  write-only material keys: ${report.keyAudit.writeOnlyKeys.join(', ')}`);
        console.log(bar);
    }
    const pass = report.verdict === 'BYTE_IDENTICAL' ||
                 report.verdict === 'SEMANTICALLY_IDENTICAL' ||
                 (report.verdict === 'DRIFT' && !args.strictDrift);
    return pass ? 0 : 1;
}

function fmt(v) {
    if (v === undefined) return '<absent>';
    if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v;
    return String(v);
}

main().then(code => process.exit(code)).catch(err => {
    console.error('snapshot-verify: fatal:', err && err.stack ? err.stack : err);
    process.exit(2);
});
