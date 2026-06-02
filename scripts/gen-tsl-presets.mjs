// gen-tsl-presets.mjs — generate src/threejs_tsl_presets.inl from the vendored
// boytchev/tsl-textures bundle.
//
// Each texture exports a function with a `.defaults` object (numbers, THREE.Color,
// or TSL nodes like positionGeometry). We read those defaults to:
//   - classify the texture (BITMAP / MATERIAL / DISPLACEMENT),
//   - emit `// @param` lines for the float/color/bool params (the editable ones),
//   - emit a tiny snippet that calls TEXTURES.<fn>({ ...params }) for the runtime.
//
// We do NOT import the bundle (its bare `three` / `three/tsl` imports don't resolve
// under Node). Instead we extract each `defaults` object literal from the bundle
// text and eval it in a sandboxed `with(scope)` so unknown TSL node identifiers
// (positionGeometry, …) resolve to an inert proxy while Color/Vector stay real.
//
// Usage:  node scripts/gen-tsl-presets.mjs            (write the .inl)
//         node scripts/gen-tsl-presets.mjs --check     (validate, write nothing)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const BUNDLE = resolve(repoRoot, 'web/vendor/tsl-textures/tsl-textures.js');
const OUT = resolve(repoRoot, 'src/threejs_tsl_presets.inl');
const checkOnly = process.argv.includes('--check');

// Textures that must stay live colorNode materials (world-space / view-dependent /
// animated) — never baked to a flat bitmap. Everything else color-based is BITMAP.
const MATERIAL_ONLY = new Set([
    'planet', 'gasGiant', 'dysonSphere', 'photosphere', 'stars', 'clouds',
    'neonLights', 'turbulentSmoke', 'waves', 'protozoa', 'entangled', 'darthMaul',
    'caustics',
]);

const CAT_BITMAP = 0, CAT_MATERIAL = 1, CAT_DISPLACEMENT = 2;

// ── inert chainable proxy for TSL nodes referenced inside defaults literals ──
const NODE = new Proxy(function () {}, {
    get: () => NODE,
    apply: () => NODE,
    construct: () => NODE,
});

const lin2srgb = (c) => (c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgb2lin = (c) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
class ColorStub {
    constructor(r, g, b) {
        this.isColor = true;
        if (g === undefined && b === undefined && typeof r === 'number') {
            this.r = ((r >> 16) & 255) / 255;
            this.g = ((r >> 8) & 255) / 255;
            this.b = (r & 255) / 255;
        } else {
            this.r = +r || 0; this.g = +g || 0; this.b = +b || 0;
        }
    }
    convertLinearToSRGB() { this.r = lin2srgb(this.r); this.g = lin2srgb(this.g); this.b = lin2srgb(this.b); return this; }
    convertSRGBToLinear() { this.r = srgb2lin(this.r); this.g = srgb2lin(this.g); this.b = srgb2lin(this.b); return this; }
    multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
    setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
    setHSL() { return this; }
    offsetHSL() { return this; }
    clone() { return new ColorStub(this.r, this.g, this.b); }
}
class Vector2Stub { constructor(x = 0, y = 0) { this.isVector2 = true; this.x = x; this.y = y; } }
class Vector3Stub { constructor(x = 0, y = 0, z = 0) { this.isVector3 = true; this.x = x; this.y = y; this.z = z; } }

function evalDefaults(literalSrc) {
    const scope = new Proxy(
        { Color: ColorStub, Vector2: Vector2Stub, Vector3: Vector3Stub, Math },
        {
            has: () => true,
            // Symbol.unscopables (and any symbol) must be undefined, else `with`
            // treats every identifier as unscopable and falls through to global.
            get: (t, k) => (typeof k === 'symbol' ? undefined : (k in t ? t[k] : NODE)),
        },
    );
    // sloppy-mode Function body so `with` is permitted
    const fn = new Function('scope', `with (scope) { return (${literalSrc}); }`);
    return fn(scope);
}

// ── extract a balanced { ... } object literal starting at `from` ──
function extractBraced(text, from) {
    const start = text.indexOf('{', from);
    if (start < 0) return null;
    let depth = 0, inStr = null;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === inStr) inStr = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}

function roundN(n, d = 4) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
    const f = 10 ** d;
    return String(Math.round(n * f) / f);
}

function floatRange(name, def) {
    if (/seed/i.test(name)) return [0, 100];
    if (/angle/i.test(name)) {
        return Math.abs(def) <= Math.PI * 2 ? [-6.2832, 6.2832] : [0, 360];
    }
    if (/[xyz]$/i.test(name)) return [-5, 5];
    if (def === 0) return [0, 1];
    if (def < 0) return [roundN(def * 4), roundN(-def * 4)];
    return [0, roundN(Math.max(def * 4, 1))];
}

function pushFloatParam(paramLines, name, value) {
    const [min, max] = floatRange(name, value);
    paramLines.push(`// @param float ${name} ${roundN(value)} ${min} ${max}`);
}

function build() {
    const bundle = readFileSync(BUNDLE, 'utf8');

    // map: fnName -> defaults var name (e.g. marble -> defaults$z)
    const assignRe = /(\b[A-Za-z_$][\w$]*)\.defaults\s*=\s*(defaults(?:\$[\w$]+)?)\s*;/g;
    const presets = [];
    const errors = [];
    let m;
    while ((m = assignRe.exec(bundle))) {
        const fnName = m[1];
        const varName = m[2];
        const declRe = new RegExp(`(?:var|let|const)\\s+${varName.replace('$', '\\$')}\\s*=\\s*`);
        const declMatch = declRe.exec(bundle);
        if (!declMatch) { errors.push(`${fnName}: defaults decl ${varName} not found`); continue; }
        const literal = extractBraced(bundle, declMatch.index + declMatch[0].length - 1);
        if (!literal) { errors.push(`${fnName}: could not extract defaults literal`); continue; }

        let defaults;
        try { defaults = evalDefaults(literal); }
        catch (e) { errors.push(`${fnName}: eval failed — ${e.message}`); continue; }

        try {
        const label = typeof defaults.$name === 'string' && defaults.$name.trim()
            ? defaults.$name.trim()
            : fnName;
        const isDisplacement = !!defaults.$positionNode;

        // Build @param lines + the param keys passed to the texture call.
        const paramLines = [];
        const callArgs = [];
        for (const [key, val] of Object.entries(defaults)) {
            if (key.startsWith('$')) continue;
            // TSL node defaults (positionGeometry, …) resolve to the inert proxy,
            // which is typeof 'function'. They're wired by the lib default, not exposed.
            if (typeof val === 'function') continue;
            if (typeof val === 'number') {
                pushFloatParam(paramLines, key, val);
                callArgs.push(`${key}: params.${key}`);
            } else if (val && val.isColor === true) {
                paramLines.push(`// @param color ${key} ${roundN(val.r)} ${roundN(val.g)} ${roundN(val.b)}`);
                callArgs.push(`${key}: params.${key}`);
            } else if (typeof val === 'boolean') {
                paramLines.push(`// @param bool ${key} ${val ? 'true' : 'false'}`);
                callArgs.push(`${key}: params.${key}`);
            } else if (val && val.isVector2 === true) {
                const xKey = `${key}X`;
                const yKey = `${key}Y`;
                pushFloatParam(paramLines, xKey, val.x);
                pushFloatParam(paramLines, yKey, val.y);
                callArgs.push(`${key}: TSL.vec2(params.${xKey}, params.${yKey})`);
            } else if (val && val.isVector3 === true) {
                const xKey = `${key}X`;
                const yKey = `${key}Y`;
                const zKey = `${key}Z`;
                pushFloatParam(paramLines, xKey, val.x);
                pushFloatParam(paramLines, yKey, val.y);
                pushFloatParam(paramLines, zKey, val.z);
                callArgs.push(`${key}: TSL.vec3(params.${xKey}, params.${yKey}, params.${zKey})`);
            }
            // TSL node defaults (positionGeometry, …) stay wired by the lib default.
        }

        let category;
        if (isDisplacement) category = CAT_DISPLACEMENT;
        else if (MATERIAL_ONLY.has(fnName)) category = CAT_MATERIAL;
        else category = CAT_BITMAP;

        const args = callArgs.join(', ');
        const call = `TEXTURES.${fnName}({ ${args} })`;
        let body;
        if (category === CAT_DISPLACEMENT) {
            body = `const presetArgs = { ${args} };\r\nmaterial.positionNode = TEXTURES.${fnName}(presetArgs);\r\nif (TEXTURES.${fnName}.normal) material.normalNode = TEXTURES.${fnName}.normal(presetArgs);`;
        }
        else if (category === CAT_MATERIAL) body = `material.colorNode = ${call};`;
        else body = `return ${call};`; // BITMAP — evalTSLTexture bakes the node

        // Use CRLF line breaks to match the Win32 multiline edit control and the
        // existing Load-.js path (ParseTSLParams + the frontend already handle CRLF).
        const code = [...paramLines, body].join('\r\n');
        presets.push({ fnName, label, category, code });
        } catch (e) {
            errors.push(`${fnName}: build failed — ${e.message}`);
        }
    }

    presets.sort((a, b) => (a.category - b.category) || a.label.localeCompare(b.label));
    return { presets, errors };
}

function cppEscape(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function emit(presets) {
    const catName = { 0: 'BITMAP', 1: 'MATERIAL', 2: 'DISPLACEMENT' };
    const rows = presets.map((p) =>
        `    { L"${cppEscape(p.label)}", ${p.category} /* ${catName[p.category]} */, L"${cppEscape(p.code)}" },`
    ).join('\n');
    return `// AUTO-GENERATED by scripts/gen-tsl-presets.mjs from web/vendor/tsl-textures.
// Do not edit by hand. Regenerate: node scripts/gen-tsl-presets.mjs
#pragma once

namespace maxjs_tsl_presets {

enum TSLPresetCategory { TSL_PRESET_BITMAP = 0, TSL_PRESET_MATERIAL = 1, TSL_PRESET_DISPLACEMENT = 2 };

struct TSLPreset {
    const wchar_t* label;
    int            category; // TSLPresetCategory
    const wchar_t* code;     // injected into the code edit (@param lines + snippet)
};

static const TSLPreset kTSLPresets[] = {
${rows}
};

static const int kTSLPresetCount = ${presets.length};

} // namespace maxjs_tsl_presets
`;
}

const { presets, errors } = build();
const counts = presets.reduce((a, p) => (a[p.category] = (a[p.category] || 0) + 1, a), {});
console.log(`[gen-tsl-presets] ${presets.length} presets — BITMAP:${counts[0] || 0} MATERIAL:${counts[1] || 0} DISPLACEMENT:${counts[2] || 0}`);

let failed = errors.length > 0;
if (errors.length) {
    console.error('[gen-tsl-presets] errors:\n  ' + errors.join('\n  '));
}
// Sanity: every preset has the right body shape.
for (const p of presets) {
    const ok = p.category === 0 ? p.code.includes('return TEXTURES.')
        : p.category === 1 ? p.code.includes('material.colorNode = TEXTURES.')
        : p.code.includes('material.positionNode = TEXTURES.') && p.code.includes('material.normalNode = TEXTURES.');
    if (!ok) { console.error(`[gen-tsl-presets] bad snippet for ${p.fnName}`); failed = true; }
}

if (checkOnly) {
    process.exit(failed ? 1 : 0);
} else {
    writeFileSync(OUT, emit(presets));
    console.log(`[gen-tsl-presets] wrote ${OUT}`);
    process.exit(failed ? 1 : 0);
}
