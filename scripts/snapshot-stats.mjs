#!/usr/bin/env node
//
// snapshot-stats.mjs — composition / byte breakdown of a MaxJS snapshot.
//
// Answers "what is actually in this export and where do the megabytes go?" for a
// snapshot folder (or a snapshot.json path). Pure Node, zero deps, offline — no
// running 3ds Max needed. Reports:
//   • file sizes (snapshot.json / scene.bin / scene_anim.bin)
//   • scene totals (nodes, materials, verts, tris, animation clips)
//   • scene.bin per-channel byte breakdown (positions/normals/uv/uv2/vcolor/
//     indices/skin/morph) with correct per-channel data types
//   • layout integrity: accounted bytes vs file size, gaps, overlaps
//   • top-N nodes by bytes
//   • vertex-color audit: per-channel sizes, channels that DUPLICATE uv2, and
//     f32 channels that could be quantized — the stuff that silently bloats a file
//
// Usage:
//   node scripts/snapshot-stats.mjs <snapshotDirOrJson> [--top N] [--json]
//   npm run snapshot:stats -- path/to/dist
//
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── data-type byte strides (handles normalized + half variants) ──────────────
function stride(t) {
    t = (t || 'f32').toLowerCase();
    if (t.startsWith('f32') || t.startsWith('u32') || t.startsWith('i32')) return 4;
    if (t.startsWith('u16') || t.startsWith('i16') || t.startsWith('half')) return 2; // u16n/i16n too
    if (t.startsWith('u8') || t.startsWith('i8')) return 1;                            // u8n/i8n too
    return 4; // unknown → assume 4 (and flag in notes)
}
const KNOWN_TYPES = new Set(['f32', 'u32', 'i32', 'u16', 'u16n', 'i16', 'i16n', 'half', 'u8', 'u8n', 'i8', 'i8n']);

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const out = { target: null, top: 10, json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') out.help = true;
        else if (a === '--json') out.json = true;
        else if (a === '--top') out.top = Math.max(0, Number(argv[++i]) || 0);
        else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        else out.target = a;
    }
    return out;
}
const HELP = `snapshot-stats.mjs — MaxJS snapshot composition / byte breakdown

  node scripts/snapshot-stats.mjs <snapshotDirOrJson> [options]

  <snapshotDirOrJson>   a snapshot folder (containing snapshot.json) or a
                        snapshot.json file directly

Options:
  --top N      show the N largest nodes by bytes (default 10; 0 = all)
  --json       emit the full report as JSON
  -h | --help  this help
`;

const MB = (x) => (x / 1048576).toFixed(2) + ' MB';
const PCT = (x, total) => total > 0 ? (100 * x / total).toFixed(1) + '%' : '—';
const fileSize = (p) => existsSync(p) ? statSync(p).size : 0;

// ── per-node range collection ────────────────────────────────────────────────
// Returns { ranges:[{off,len,label}], channels:{...}, verts, tris, perNode:[],
//           vcAudit:[{node,ch,name,type,bytes,uvDup,f32}], typeWarnings:Set }
function analyze(root, dir) {
    const channels = { positions: 0, normals: 0, uv: 0, uv2: 0, vcolor: 0, indices: 0, skin: 0, morph: 0 };
    const ranges = [];
    const perNode = [];
    const vcAudit = [];
    const typeWarnings = new Set();
    let verts = 0, tris = 0;

    const addRange = (off, count, type, ch, label) => {
        if (off == null || count == null) return 0;
        if (type && !KNOWN_TYPES.has(String(type).toLowerCase())) typeWarnings.add(String(type));
        const len = count * stride(type);
        ranges.push({ off, len, label });
        channels[ch] += len;
        return len;
    };

    for (const n of (root.nodes || [])) {
        const name = n.n || n.name || ('#' + (n.h ?? '?'));
        let nb = 0;
        const g = n.geo;
        if (g) {
            if (g.vN) { nb += addRange(g.vOff, g.vN, 'f32', 'positions', name + '.pos'); verts += g.vN / 3; }
            if (g.nN) nb += addRange(g.nOff, g.nN, g.nType, 'normals', name + '.nrm');
            if (g.uvN) nb += addRange(g.uvOff, g.uvN, g.uvType, 'uv', name + '.uv');
            if (g.uv2N) nb += addRange(g.uv2Off, g.uv2N, g.uv2Type, 'uv2', name + '.uv2');
            if (g.iN) { nb += addRange(g.iOff, g.iN, g.iType, 'indices', name + '.idx'); tris += g.iN / 3; }
            const hasUv2 = g.uv2N != null;
            if (Array.isArray(g.vc)) {
                for (const c of g.vc) {
                    const b = addRange(c.off, c.n, c.type, 'vcolor', name + '.vc' + c.ch);
                    nb += b;
                    const ty = (c.type || 'f32').toLowerCase();
                    vcAudit.push({
                        node: name, ch: c.ch, name: c.name || ('vc_' + c.ch), type: ty, bytes: b,
                        uvDup: c.ch === 2 && hasUv2,           // shares the uv2 map channel
                        f32: ty.startsWith('f32'),             // could be quantized
                    });
                }
            }
        }
        const sk = n.skin;
        if (sk) {
            nb += addRange(sk.wOff, sk.wN, sk.wType, 'skin', name + '.skinW');
            nb += addRange(sk.iOff, sk.iN, sk.iType, 'skin', name + '.skinI');
            nb += addRange(sk.bindOff, sk.bindN, 'f32', 'skin', name + '.bind');
        }
        const mo = n.morph;
        if (mo && Array.isArray(mo.dOff) && Array.isArray(mo.dN)) {
            for (let i = 0; i < mo.dOff.length; i++) nb += addRange(mo.dOff[i], mo.dN[i], 'f32', 'morph', name + '.morph' + i);
        }
        perNode.push({ name, bytes: nb, verts: g && g.vN ? g.vN / 3 : 0 });
    }

    // layout integrity: gaps + overlaps over the referenced ranges
    ranges.sort((a, b) => a.off - b.off);
    let gap = 0, overlap = 0, cursor = 0, hi = 0;
    for (const r of ranges) {
        if (r.off > cursor) gap += r.off - cursor;
        else if (r.off < cursor) overlap += Math.min(cursor, r.off + r.len) - r.off;
        cursor = Math.max(cursor, r.off + r.len);
        hi = cursor;
    }
    return { channels, ranges, perNode, vcAudit, typeWarnings, verts, tris, gap, overlap, hi };
}

function collectMaterials(root) {
    const arr = root && root.materials;
    if (!Array.isArray(arr)) return [];
    return arr.map(e => (e && e.mat) ? e.mat : e).filter(Boolean);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.target) { console.log(HELP); return args.target ? 0 : 2; }

    let dir, jsonPath;
    if (args.target.toLowerCase().endsWith('.json')) { jsonPath = args.target; dir = path.dirname(args.target); }
    else { dir = args.target; jsonPath = path.join(dir, 'snapshot.json'); }
    if (!existsSync(jsonPath)) { console.error(`error: snapshot.json not found at ${jsonPath}`); return 2; }

    const root = JSON.parse(await readFile(jsonPath, 'utf8'));
    const binName = (typeof root.bin === 'string') ? root.bin : 'scene.bin';
    const animName = (root.animations && typeof root.animations.bin === 'string') ? root.animations.bin
        : (existsSync(path.join(dir, 'scene_anim.bin')) ? 'scene_anim.bin' : null);
    const sceneBinSize = fileSize(path.join(dir, binName));
    const animBinSize = animName ? fileSize(path.join(dir, animName)) : 0;
    const jsonSize = fileSize(jsonPath);

    const a = analyze(root, dir);
    const mats = collectMaterials(root);
    const clips = (root.animations && Array.isArray(root.animations.clips)) ? root.animations.clips.length : 0;
    const accounted = Object.values(a.channels).reduce((s, v) => s + v, 0);
    const vcTotal = a.channels.vcolor;
    const vcDup = a.vcAudit.filter(v => v.uvDup).reduce((s, v) => s + v.bytes, 0);
    const vcHigh = a.vcAudit.filter(v => v.ch >= 3).reduce((s, v) => s + v.bytes, 0);
    const vcF32 = a.vcAudit.filter(v => v.f32).reduce((s, v) => s + v.bytes, 0);

    const report = {
        files: { 'snapshot.json': jsonSize, [binName]: sceneBinSize, ...(animName ? { [animName]: animBinSize } : {}) },
        totals: { nodes: (root.nodes || []).length, materials: mats.length, verts: Math.round(a.verts), tris: Math.round(a.tris), animationClips: clips },
        sceneBinChannels: a.channels, accounted, gap: a.gap, overlap: a.overlap, highWater: a.hi,
        vertexColor: { total: vcTotal, channels: a.vcAudit.length, bytesOnUv2Duplicates: vcDup, bytesOnChannelsGE3: vcHigh, bytesStoredAsF32: vcF32 },
        topNodes: [...a.perNode].sort((x, y) => y.bytes - x.bytes).slice(0, args.top || a.perNode.length),
        unknownTypes: [...a.typeWarnings],
    };

    if (args.json) { console.log(JSON.stringify(report, null, 2)); return 0; }

    const bar = '─'.repeat(64);
    console.log(bar);
    console.log(`SNAPSHOT: ${dir}`);
    console.log(bar);
    console.log('files:');
    for (const [k, v] of Object.entries(report.files)) console.log(`  ${k.padEnd(16)} ${MB(v).padStart(11)}`);
    console.log('');
    console.log(`scene: ${report.totals.nodes} nodes, ${report.totals.materials} materials, ` +
        `~${report.totals.verts.toLocaleString()} verts, ~${report.totals.tris.toLocaleString()} tris, ${clips} anim clip(s)`);
    console.log('');
    console.log(`${binName} channel breakdown:`);
    for (const [k, v] of Object.entries(a.channels).sort((x, y) => y[1] - x[1])) {
        if (v) console.log(`  ${k.padEnd(10)} ${MB(v).padStart(11)}  (${PCT(v, sceneBinSize)} of file)`);
    }
    console.log('');
    console.log('layout integrity:');
    console.log(`  accounted ${MB(accounted)} / file ${MB(sceneBinSize)} · high-water ${MB(a.hi)} · gaps ${MB(a.gap)} · overlaps ${MB(a.overlap)}`);
    if (a.gap > 1048576) console.log('  ⚠ >1MB of gaps — either an unmodeled channel or wasted/over-allocated space');
    if (a.overlap > 0) console.log('  ⚠ overlapping ranges — possible offset/length bug');
    if (report.unknownTypes.length) console.log(`  ⚠ unrecognized data types (sized as 4B): ${report.unknownTypes.join(', ')}`);
    console.log('');
    if (vcTotal) {
        console.log(`vertex-color audit: ${MB(vcTotal)} across ${a.vcAudit.length} channel(s)`);
        if (vcDup) console.log(`  ${MB(vcDup)} duplicates the uv2 map channel (channel 2 — also exported as uv2)`);
        if (vcHigh) console.log(`  ${MB(vcHigh)} on map channels ≥3 (likely stray UVW unless a material reads maxjs_vc_N)`);
        if (vcF32) console.log(`  ${MB(vcF32)} stored as f32 (would be 4× smaller as u8n if plain 0–1 color)`);
        console.log('');
    }
    if (args.top !== 0) {
        console.log(`top ${report.topNodes.length} nodes by bytes:`);
        for (const n of report.topNodes) console.log(`  ${MB(n.bytes).padStart(11)}  verts~${Math.round(n.verts).toLocaleString().padStart(10)}  ${n.name}`);
    }
    console.log(bar);
    return 0;
}

main().then(c => process.exit(c)).catch(e => { console.error('snapshot-stats: fatal:', e && e.stack ? e.stack : e); process.exit(2); });
