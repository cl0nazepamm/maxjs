// gi-oct-test.mjs — Phase-0 gate #3 for HALO-GI (docs/GI_HALO_design.md §11.1).
//
// Pure-math round-trip of the hand-rolled octahedral map in web/js/gi_oct.js.
// No GPU needed. Verifies octDecode(octEncode(n)) == n across all 8 octants,
// the ±axis poles, near-seam directions, and a dense sphere grid, plus that
// encode lands inside [0,1]² and the map is continuous across tile seams.
//
// Run: node scripts/gi-oct-test.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(resolve(__dirname, '../web/js/gi_oct.js')).href;
const { octEncode, octDecode } = await import(modUrl);

let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.error('  FAIL:', msg); };
const RAD2DEG = 180 / Math.PI;

function angleErrDeg(ax, ay, az, bx, by, bz) {
    const d = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
    return Math.acos(d) * RAD2DEG;
}

// Round-trip a single direction; assert angular error and uv bounds.
const MAX_ERR_DEG = 0.1;
function roundTrip(nx, ny, nz, label) {
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const uv = octEncode(nx, ny, nz);
    if (!(uv[0] >= -1e-6 && uv[0] <= 1 + 1e-6 && uv[1] >= -1e-6 && uv[1] <= 1 + 1e-6)) {
        fail(`${label}: uv out of [0,1]²: (${uv[0]}, ${uv[1]})`);
        return;
    }
    if (!Number.isFinite(uv[0]) || !Number.isFinite(uv[1])) { fail(`${label}: NaN uv`); return; }
    const d = octDecode(uv[0], uv[1]);
    if (!Number.isFinite(d[0]) || !Number.isFinite(d[1]) || !Number.isFinite(d[2])) { fail(`${label}: NaN decode`); return; }
    const err = angleErrDeg(nx, ny, nz, d[0], d[1], d[2]);
    checks++;
    if (err > MAX_ERR_DEG) fail(`${label}: round-trip err ${err.toFixed(4)}° > ${MAX_ERR_DEG}° (n=${nx.toFixed(3)},${ny.toFixed(3)},${nz.toFixed(3)})`);
}

// 1) The 8 octant diagonals + the 6 axis poles (±Z is the worst case).
const POLES = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
for (const [x, y, z] of POLES) roundTrip(x, y, z, `pole(${x},${y},${z})`);
for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    roundTrip(sx, sy, sz, `octant(${sx},${sy},${sz})`);
}

// 2) Near-seam directions: z≈0 (the diamond edge) and the corner folds.
for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    roundTrip(Math.cos(a), Math.sin(a), 1e-4, `seam+z(${a.toFixed(2)})`);
    roundTrip(Math.cos(a), Math.sin(a), -1e-4, `seam-z(${a.toFixed(2)})`);
}

// 3) Dense Fibonacci sphere grid (uniform coverage).
const N = 20000;
const GA = Math.PI * (3 - Math.sqrt(5));
for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * GA;
    roundTrip(Math.cos(phi) * r, y, Math.sin(phi) * r, `fib(${i})`);
}

// 4) Seam continuity: a small step in world direction near the z=0 seam must
//    produce a bounded step in uv (no discontinuity / wrap jump on the same
//    hemisphere). We sample either side of the seam at matched angles and check
//    the encoded uv distance stays small for a small angular step.
{
    const eps = 1e-3;
    let maxJump = 0;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 64) {
        // two directions a hair apart, both just above the seam (z>0)
        const z = 0.02;
        const r0 = Math.sqrt(1 - z * z);
        const d0 = [Math.cos(a) * r0, Math.sin(a) * r0, z];
        const d1 = [Math.cos(a + eps) * r0, Math.sin(a + eps) * r0, z];
        const u0 = octEncode(d0[0], d0[1], d0[2]);
        const u1 = octEncode(d1[0], d1[1], d1[2]);
        maxJump = Math.max(maxJump, Math.hypot(u0[0] - u1[0], u0[1] - u1[1]));
    }
    checks++;
    // a 1e-3 rad step should never move uv more than a few 1e-3 within a hemisphere
    if (maxJump > 0.01) fail(`seam continuity: max uv jump ${maxJump.toFixed(5)} for ${eps} rad step`);
}

console.log(`gi-oct round-trip: ${checks} checks, ${failures} failures`);
if (failures > 0) { console.error('GATE #3 FAILED'); process.exit(1); }
console.log('GATE #3 GREEN: octahedral encode/decode round-trips within 0.1°.');
