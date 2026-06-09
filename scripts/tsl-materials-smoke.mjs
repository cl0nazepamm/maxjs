// tsl-materials-smoke.mjs — offline checks for the extracted TSL compiler.
//
// web/js/tsl_materials.js has no static imports (THREE/TSL are injected), so we
// can exercise its logic with mocks: the WebGL capability gate, @param parsing,
// the TEXTURES preset-library injection, and the node->texture bake path.
//
// Run: node scripts/tsl-materials-smoke.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(resolve(__dirname, '../web/js/tsl_materials.js')).href;
const { createTSLCompiler, makeBakeNodeToTexture } = await import(modUrl);

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  FAIL:', msg); } else { console.log('  ok:', msg); } };

class Color { constructor(r, g, b) { this.isColor = true; this.r = r ?? 0; this.g = g ?? 0; this.b = b ?? 0; } setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } }
const TSL = {
    uniform: (v) => ({ isUniform: true, value: v }),
    attribute: () => ({ isAttribute: true }),
    texture: (tex, ...args) => ({ isTextureNode: true, tex, args }),
    vec2: (x, y) => ({ isVec2: true, x, y }),
    vec3: (x, y, z) => ({ isVec3: true, x, y, z }),
    time: { isTime: true },
};
const THREE_GPU = {
    Color, FrontSide: 0, DoubleSide: 1,
    RGBAFormat: 'RGBAFormat',
    UnsignedByteType: 'UnsignedByteType',
    RepeatWrapping: 'RepeatWrapping',
    SRGBColorSpace: 'SRGBColorSpace',
    DataTexture: class {
        constructor(data, width, height) {
            this.isTexture = true;
            this.isDataTexture = true;
            this.image = { data, width, height };
        }
    },
    MeshPhysicalNodeMaterial: class { constructor() { this.userData = {}; this.isNodeMaterial = true; } },
    MeshStandardMaterial: class { constructor(o = {}) { Object.assign(this, o); this.userData = {}; } },
};
const THREE_GL = { ...THREE_GPU, MeshPhysicalNodeMaterial: undefined, QuadMesh: undefined };

console.log('[1] WebGL capability gate');
{
    const c = createTSLCompiler({ THREE: THREE_GL, TSL });
    ok(c.nodeMaterialsAvailable === false, 'nodeMaterialsAvailable is false on the WebGL build');
    ok(c.createTSLMaterial({ tslCode: 'material.colorNode = 1;' }) === null, 'createTSLMaterial returns null on WebGL (host falls back)');
}

console.log('[2] @param parsing → uniforms');
{
    const c = createTSLCompiler({ THREE: THREE_GPU, TSL });
    const params = c.buildTSLParams('// @param float scale 1.2 0 4\n// @param color tint 0.5 0.6 0.7\n// @param bool flag true\n', {});
    ok(params.scale?.isUniform && params.scale.value === 1.2, 'float @param → uniform default');
    ok(params.tint?.value?.isColor && params.tint.value.r === 0.5, 'color @param → uniform Color default');
    ok(params.flag?.isUniform && params.flag.value === 1.0, 'bool @param → uniform 1.0');
    const params2 = c.buildTSLParams('// @param float scale 1.2 0 4\n', { scale: 3.5 });
    ok(params2.scale.value === 3.5, 'stored value overrides default');
}

console.log('[3] createTSLMaterial (WebGPU) builds + stores params');
{
    const c = createTSLCompiler({ THREE: THREE_GPU, TSL });
    const mat = c.createTSLMaterial({ side: 1, tslCode: '// @param float k 2 0 4\nmaterial.colorNode = params.k;' });
    ok(mat && mat.isNodeMaterial, 'returns a MeshPhysicalNodeMaterial');
    ok(mat.colorNode?.isUniform && mat.colorNode.value === 2, 'snippet ran: colorNode set from params');
    ok(mat.userData.tslParams?.k?.isUniform, 'userData.tslParams stored for live updates');
}

console.log('[4] TEXTURES preset-library injection');
{
    const c = createTSLCompiler({ THREE: THREE_GPU, TSL });
    let calledWith = null;
    c.setTextures({ marble: (opts) => { calledWith = opts; return { isMarbleNode: true }; } });
    const mat = c.createTSLMaterial({ tslCode: '// @param float scale 1 0 4\nmaterial.colorNode = TEXTURES.marble({ scale: params.scale });' });
    ok(mat.colorNode?.isMarbleNode === true, 'preset snippet resolved TEXTURES.marble');
    ok(calledWith?.scale?.isUniform, 'preset received the param uniform');
}

console.log('[5] evalTSLTexture: direct texture + bake path');
{
    const c = createTSLCompiler({ THREE: THREE_GPU, TSL });
    const tex = c.evalTSLTexture('return { isTexture: true };', {});
    ok(tex?.isTexture === true, 'snippet returning a Texture is returned directly');

    // bitmap-preset path: snippet returns a TSL node → must be baked
    let bakedFrom = null;
    c.setTextures({ polkaDots: () => ({ isNode: true }) });
    c.setBakeNodeToTexture((node) => { bakedFrom = node; return { isTexture: true, baked: true }; });
    const baked = c.evalTSLTexture('return TEXTURES.polkaDots({});', {});
    ok(bakedFrom?.isNode === true, 'non-texture node result was handed to the bake helper');
    ok(baked?.isTexture && baked.baked === true, 'baked texture returned to the slot');
}

console.log('[6] displacement presets can drive position + normal nodes');
{
    const c = createTSLCompiler({ THREE: THREE_GPU, TSL });
    let positionArgs = null;
    let normalArgs = null;
    const translator = (args) => { positionArgs = args; return { isPositionNode: true }; };
    translator.normal = (args) => { normalArgs = args; return { isNormalNode: true }; };
    c.setTextures({ translator });
    const mat = c.createTSLMaterial({
        tslCode: [
            '// @param float distanceX -0.5 -5 5',
            '// @param float distanceY 0 -5 5',
            '// @param float distanceZ 0.2 -5 5',
            'const presetArgs = { distance: TSL.vec3(params.distanceX, params.distanceY, params.distanceZ) };',
            'material.positionNode = TEXTURES.translator(presetArgs);',
            'if (TEXTURES.translator.normal) material.normalNode = TEXTURES.translator.normal(presetArgs);',
        ].join('\n'),
    });
    ok(mat.positionNode?.isPositionNode === true, 'displacement snippet sets positionNode');
    ok(mat.normalNode?.isNormalNode === true, 'displacement snippet sets normalNode when available');
    ok(positionArgs?.distance?.isVec3 && normalArgs?.distance?.isVec3, 'vector params are passed as TSL vec3 nodes');
}

console.log('[7] makeBakeNodeToTexture gracefully disabled without a renderer');
{
    ok(makeBakeNodeToTexture(null, THREE_GPU) === null, 'no renderer → null (bake disabled)');
    ok(makeBakeNodeToTexture({}, THREE_GL) === null, 'WebGL build (no QuadMesh) → null');
}

console.log('[8] makeBakeNodeToTexture returns a bind-safe DataTexture placeholder');
{
    let rendered = false;
    let disposed = false;
    const THREE_BAKE = {
        ...THREE_GPU,
        DataTexture: class {
            constructor(data, width, height) {
                this.isTexture = true;
                this.isDataTexture = true;
                this.image = { data, width, height };
                this.userData = {};
            }
        },
        RenderTarget: class {
            constructor(width, height) {
                this.width = width;
                this.height = height;
                this.texture = { isTexture: true, isRenderTargetTexture: true };
            }
            dispose() { disposed = true; }
        },
        MeshBasicNodeMaterial: class {
            dispose() {}
        },
        QuadMesh: class {
            render() { rendered = true; }
        },
    };
    const renderer = {
        target: null,
        getRenderTarget() { return this.target; },
        setRenderTarget(target) { this.target = target; },
        initRenderTarget() {},
        async readRenderTargetPixelsAsync(_rt, _x, _y, width, height) {
            const pixels = new Uint8Array(width * height * 4);
            pixels.fill(7);
            return pixels;
        },
    };
    let completed = false;
    const bake = makeBakeNodeToTexture(renderer, THREE_BAKE, { onComplete: () => { completed = true; } });
    const tex = bake({ isNode: true }, { size: 2 });
    ok(tex?.isDataTexture === true && tex?.isRenderTargetTexture !== true, 'returns DataTexture, not RenderTarget.texture');
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(rendered === true && disposed === true, 'offscreen render target was rendered and disposed asynchronously');
    ok(completed === true && tex.image.data[0] === 7, 'async readback updates placeholder pixels');
}

console.log('[9] TSL texture nodes are bind-safe with missing or pending images');
{
    const pendingTexture = { isTexture: true, image: null };
    const c = createTSLCompiler({
        THREE: THREE_GPU,
        TSL,
        loadTexture: () => pendingTexture,
    });

    const missing = c.createTSLMaterial({
        tslCode: 'material.colorNode = TSL.texture(maps.map1);',
    });
    ok(missing.colorNode?.isTextureNode === true, 'missing map still creates a texture node');
    ok(missing.colorNode.tex?.image?.width === 1, 'missing map uses a 1x1 fallback texture');

    const pending = c.createTSLMaterial({
        tslMap1: 'pending.png',
        tslCode: 'material.colorNode = TSL.texture(maps.map1);',
    });
    ok(pending.colorNode.tex === pendingTexture, 'pending loader texture is preserved in the node graph');
    ok(pendingTexture.image?.width === 1, 'pending loader texture receives a bind-safe fallback image');

    const returned = c.evalTSLTexture('return new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);', {});
    ok(returned?.image?.width === 1, 'direct texture return remains bind-safe');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
