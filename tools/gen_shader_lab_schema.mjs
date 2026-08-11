// Regenerate web/js/shader_lab_schema.js from a shader-lab checkout.
//
// The npm package ships no parameter registry — only the pass classes and the
// public layer-type unions — so the panel used to carry a hand-copied
// DEFAULT_PARAMS that drifted from upstream (dead keys, missing keys, defaults
// taken from pass-constructor fallbacks instead of the shipped UI defaults).
// This script pulls the real thing out of the app's layer-registry.ts instead.
//
// Usage:
//   git clone --depth 1 https://github.com/basementstudio/shader-lab <dir>
//   node tools/gen_shader_lab_schema.mjs <dir> <version>
//
// Keep <version> in sync with the esm.sh pin in web/js/shader_lab_fx.js.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const [checkout, version] = process.argv.slice(2);
if (!checkout || !version) {
    console.error('usage: node tools/gen_shader_lab_schema.mjs <shader-lab-checkout> <version>');
    process.exit(1);
}

const registrySrc = path.join(checkout, 'src/lib/editor/config/layer-registry.ts');
const typesSrc = path.join(checkout, 'packages/shader-lab-react/src/types.ts');
const outFile = path.join(import.meta.dirname, '../web/js/shader_lab_schema.js');
const tmpFile = path.join(import.meta.dirname, '.shader-lab-registry-probe.ts');
const tmpLoader = path.join(import.meta.dirname, '.shader-lab-loader.mjs');
const tmpBootstrap = path.join(import.meta.dirname, '.shader-lab-bootstrap.mjs');

// The registry is only reachable by executing the module: entries reference
// shared param arrays by identifier. Rather than stub the imports, resolve the
// "@/" alias to the checkout so the real values come through — the custom-shader
// starter source, the text font list and the sentinel that marks a param
// internal all live behind those imports and silently degrade if faked. The
// alias is transitive, so it needs a resolve hook, not a string rewrite.
const srcRoot = pathToFileURL(path.join(checkout, 'src') + path.sep).href;
fs.writeFileSync(tmpLoader, `
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const SRC_ROOT = ${JSON.stringify(srcRoot)};
export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
        const rel = specifier.slice(2);
        for (const candidate of [rel + '.ts', rel + '.tsx', rel + '/index.ts']) {
            const url = new URL(candidate, SRC_ROOT).href;
            if (fs.existsSync(fileURLToPath(url))) return next(url, context);
        }
    }
    return next(specifier, context);
}
`);
fs.writeFileSync(tmpBootstrap, `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(pathToFileURL(${JSON.stringify(tmpLoader)}).href);
`);

const probe = `
${fs.readFileSync(registrySrc, 'utf8')}
const out = {}
for (const [type, def] of Object.entries(layerDefinitions)) {
  out[type] = {
    kind: def.kind,
    defaultName: def.defaultName,
    params: def.params.map((p) => {
      const entry = { key: p.key, type: p.type, defaultValue: p.defaultValue }
      if (typeof p.min === "number") entry.min = p.min
      if (typeof p.max === "number") entry.max = p.max
      if (typeof p.step === "number") entry.step = p.step
      if (p.options) entry.options = p.options.map((o) => o.value)
      if (p.visibleWhen) entry.visibleWhen = { key: p.visibleWhen.key, equals: p.visibleWhen.equals }
      return entry
    }),
  }
}
console.log(JSON.stringify(out))
`;

fs.writeFileSync(tmpFile, probe);
let registry;
try {
    registry = JSON.parse(
        execFileSync(
            process.execPath,
            ['--no-warnings', '--experimental-strip-types', '--import', pathToFileURL(tmpBootstrap).href, tmpFile],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
        )
    );
} finally {
    for (const f of [tmpFile, tmpLoader, tmpBootstrap]) fs.rmSync(f, { force: true });
}

// layer-registry.ts also carries internal types that the package never exposes
// (`blur`, `model`). The exported unions are the real allow-list — anything
// outside them would put a layer type in the dropdown that the library rejects.
const typesText = fs.readFileSync(typesSrc, 'utf8');
function readUnion(name) {
    // The unions are written one `| "type"` per line and terminated by the
    // next top-level declaration rather than a semicolon.
    const start = typesText.indexOf(`export type ${name} =`);
    if (start === -1) throw new Error(`could not find union ${name} in ${typesSrc}`);
    const rest = typesText.slice(start + `export type ${name} =`.length);
    const end = rest.search(/\n\s*(?:export|type|interface|const)\b/);
    const body = end === -1 ? rest : rest.slice(0, end);
    const values = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!values.length) throw new Error(`union ${name} parsed empty from ${typesSrc}`);
    return values;
}
const sourceTypes = readUnion('ShaderLabSourceLayerType');
const effectTypes = readUnion('ShaderLabEffectLayerType');
const published = new Set([...sourceTypes, ...effectTypes]);

for (const type of Object.keys(registry)) {
    if (!published.has(type)) delete registry[type];
}
for (const type of published) {
    if (!registry[type]) throw new Error(`published type "${type}" missing from layer registry`);
}

const body = Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, def]) => {
        const params = def.params
            .map((p) => `        ${JSON.stringify(p)},`)
            .join('\n');
        return `    ${JSON.stringify(type)}: {\n`
            + `        kind: ${JSON.stringify(def.kind)},\n`
            + `        defaultName: ${JSON.stringify(def.defaultName)},\n`
            + `        params: [\n${params}\n        ],\n`
            + `    },`;
    })
    .join('\n');

fs.writeFileSync(outFile, `// GENERATED — do not edit by hand.
// Source: @basementstudio/shader-lab ${version} (src/lib/editor/config/layer-registry.ts)
// Regenerate: node tools/gen_shader_lab_schema.mjs <shader-lab-checkout> <version>
//
// The shipped parameter registry for every published layer type: the same
// defaults, ranges, enums and visibility rules the shader-lab editor itself
// uses. shader_lab_panel.js builds its controls from this, so the panel cannot
// drift from the library the way a hand-maintained table does.

export const SHADER_LAB_VERSION = ${JSON.stringify(version)};

export const SOURCE_TYPES = ${JSON.stringify(sourceTypes.sort())};

export const EFFECT_TYPES = ${JSON.stringify(effectTypes.sort())};

export const LAYER_SCHEMA = {
${body}
};

// Default params for a freshly created layer of \`type\`, straight from the
// registry. Returns a fresh object each call — callers mutate it.
export function defaultParamsFor(type) {
    const def = LAYER_SCHEMA[type];
    if (!def) return {};
    const out = {};
    for (const param of def.params) out[param.key] = param.defaultValue;
    return out;
}

export function paramSchemaFor(type, key) {
    return LAYER_SCHEMA[type]?.params.find((p) => p.key === key) || null;
}
`);

const paramCount = Object.values(registry).reduce((n, d) => n + d.params.length, 0);
console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
console.log(`  ${Object.keys(registry).length} layer types (${sourceTypes.length} source, ${effectTypes.length} effect), ${paramCount} params`);
