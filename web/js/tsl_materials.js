// tsl_materials.js — shared TSL material/texture compiler.
//
// Extracted verbatim from the inline viewer script in web/index.html so that BOTH
// the live viewer and the standalone snapshot path (web/js/material_builder.js)
// compile TSL the same way. This is what makes WebGPU snapshots render real TSL
// instead of the PBR fallback.
//
// The compiler is host-agnostic: heavy host-owned closures (loadTexture, the
// texture cache, the debug logger, the WebGPU renderer used for baking) are
// INJECTED, never imported here. THREE / TSL are injected too so this module
// never pins a specific three build (the WebGL build has no node materials).
//
// TSL node materials only exist in the WebGPU build of three.js. When THREE has
// no MeshPhysicalNodeMaterial (the WebGL snapshot target), createTSLMaterial
// returns null and the host falls through to its existing path — no fallback is
// built here on purpose.

// Render a TSL color node into a sampleable THREE.DataTexture using an offscreen
// QuadMesh + RenderTarget + async readback. Do not return RenderTarget.texture:
// r185 WebGPU can leave that texture without a sampled bind resource and crash
// later in createBindGroup() when a classic material samples it.
export function makeBakeNodeToTexture(renderer, THREE, { onComplete = () => {} } = {}) {
    if (!renderer
        || typeof THREE?.QuadMesh !== 'function'
        || typeof THREE?.MeshBasicNodeMaterial !== 'function'
        || typeof THREE?.RenderTarget !== 'function'
        || typeof THREE?.DataTexture !== 'function'
        || typeof renderer?.readRenderTargetPixelsAsync !== 'function') {
        return null;
    }
    return function bakeNodeToTexture(colorNode, { size = 512, colorSpace = THREE.SRGBColorSpace } = {}) {
        const data = new Uint8Array(size * size * 4);
        data.fill(255);
        const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
        texture.colorSpace = colorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.name = 'tsl-bake';
        texture.needsUpdate = true;
        texture.userData ??= {};
        texture.userData.maxjsTSLBakePending = true;

        queueMicrotask(async () => {
            const rt = new THREE.RenderTarget(size, size, {
                depthBuffer: false,
                stencilBuffer: false,
                format: THREE.RGBAFormat,
                type: THREE.UnsignedByteType,
            });
            const mat = new THREE.MeshBasicNodeMaterial();
            mat.colorNode = colorNode;
            const quad = new THREE.QuadMesh(mat);
            const prev = renderer.getRenderTarget();
            try {
                renderer.initRenderTarget?.(rt);
                renderer.setRenderTarget(rt);
                quad.render(renderer);
                renderer.setRenderTarget(prev);
                const pixels = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
                if (pixels?.length >= data.length) {
                    data.set(pixels.subarray ? pixels.subarray(0, data.length) : pixels.slice(0, data.length));
                    texture.needsUpdate = true;
                    texture.userData.maxjsTSLBakePending = false;
                    try { onComplete(); } catch {}
                }
            } catch (err) {
                console.error('[TSL Texture] bake failed:', err);
            } finally {
                if (renderer.getRenderTarget?.() === rt) renderer.setRenderTarget(prev);
                rt.dispose?.();
                mat.dispose?.();
            }
        });

        return texture;
    };
}

export function createTSLCompiler({
    THREE,
    TSL,
    loadTexture = () => null,
    textureCache = new Map(),
    debugWarn = () => {},
    textures = null,
    bakeNodeToTexture = null,
} = {}) {
    if (!THREE || !TSL) {
        throw new Error('createTSLCompiler requires { THREE, TSL }');
    }

    const nodeMaterialsAvailable = typeof THREE.MeshPhysicalNodeMaterial === 'function';

    // Mutable so hosts can lazy-load the vendored tsl-textures library after
    // construction and the bake helper once a renderer exists.
    let texturesNs = textures;
    let bakeFn = bakeNodeToTexture;

    // Per-factory compat-namespace cache (was a module-level singleton inline).
    const tslCompatWarnings = new Set();
    let tslCompatNamespace = null;
    let fallbackTexture = null;

    function coerceTSLFloat(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function coerceTSLColor(value, fallbackR, fallbackG, fallbackB) {
        if (Array.isArray(value) && value.length >= 3) {
            return new THREE.Color(
                coerceTSLFloat(value[0], fallbackR),
                coerceTSLFloat(value[1], fallbackG),
                coerceTSLFloat(value[2], fallbackB),
            );
        }
        if (value && typeof value === 'object' &&
            Number.isFinite(value.r) &&
            Number.isFinite(value.g) &&
            Number.isFinite(value.b)) {
            return new THREE.Color(value.r, value.g, value.b);
        }
        if (typeof value === 'string' && value.trim()) {
            try {
                return new THREE.Color(value);
            } catch {}
        }
        return new THREE.Color(fallbackR, fallbackG, fallbackB);
    }

    function coerceTSLBool(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
            if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
        }
        return fallback;
    }

    // Parse @param declarations from TSL code and build uniform params object
    function buildTSLParams(code, values) {
        const params = {};
        const lines = code.split('\n');
        for (const line of lines) {
            const m = line.match(/\/\/\s*@param\s+(float|color|bool)\s+(\w+)\s*(.*)/);
            if (!m) continue;
            const [, type, name, rest] = m;
            const parts = rest.trim().split(/\s+/).map(Number);
            if (type === 'float') {
                const fallback = isFinite(parts[0]) ? parts[0] : 0.5;
                params[name] = TSL.uniform(coerceTSLFloat(values?.[name], fallback));
            } else if (type === 'color') {
                const r = isFinite(parts[0]) ? parts[0] : 1;
                const g = isFinite(parts[1]) ? parts[1] : 1;
                const b = isFinite(parts[2]) ? parts[2] : 1;
                params[name] = TSL.uniform(coerceTSLColor(values?.[name], r, g, b));
            } else if (type === 'bool') {
                const val = coerceTSLBool(values?.[name], rest.trim() === 'true');
                params[name] = TSL.uniform(val ? 1.0 : 0.0);
            }
        }
        return params;
    }

    function warnTSLLegacy(name, replacement) {
        const key = `${name}->${replacement}`;
        if (tslCompatWarnings.has(key)) return;
        tslCompatWarnings.add(key);
        debugWarn(`[TSL] Legacy API shim: ${name} -> ${replacement}`);
    }

    function getFallbackTexture() {
        if (fallbackTexture) return fallbackTexture;
        if (typeof THREE.DataTexture !== 'function') return null;
        fallbackTexture = new THREE.DataTexture(
            new Uint8Array([255, 255, 255, 255]),
            1,
            1,
            THREE.RGBAFormat,
            THREE.UnsignedByteType,
        );
        fallbackTexture.colorSpace = THREE.SRGBColorSpace ?? THREE.NoColorSpace;
        fallbackTexture.wrapS = fallbackTexture.wrapT = THREE.RepeatWrapping;
        fallbackTexture.name = 'maxjs-tsl-fallback';
        fallbackTexture.needsUpdate = true;
        return fallbackTexture;
    }

    function ensureTextureBindingSafe(texture) {
        if (!texture?.isTexture) return getFallbackTexture();
        const image = texture.source?.data ?? texture.image;
        if (image == null) {
            const fallback = getFallbackTexture();
            if (fallback?.image) {
                texture.image = fallback.image;
                texture.needsUpdate = true;
            }
        }
        return texture;
    }

    function normalizeMaxVertexColorChannel(channel = 0) {
        if (typeof channel === 'string') {
            const token = channel.trim().toLowerCase();
            if (token === 'color' || token === 'rgb') return 0;
            if (token === 'shading' || token === 'illum' || token === 'illumination') return -1;
            if (token === 'alpha') return -2;
            const parsed = Number.parseInt(token, 10);
            if (Number.isFinite(parsed)) return parsed;
            return 0;
        }
        if (!Number.isFinite(channel)) return 0;
        return Math.trunc(channel);
    }

    function maxVertexColorAttributeName(channel = 0) {
        const normalized = normalizeMaxVertexColorChannel(channel);
        if (normalized === 0) return 'color';
        if (normalized === -1) return 'maxjs_vc_shading';
        if (normalized === -2) return 'maxjs_vc_alpha';
        return `maxjs_vc_${normalized}`;
    }

    function getTSLCompatNamespace() {
        if (tslCompatNamespace) return tslCompatNamespace;
        const compat = Object.assign({}, TSL);
        const makeTimerShim = (name) => (scale = 1.0) => {
            warnTSLLegacy(name, 'TSL.time');
            const s = Number.isFinite(scale) ? scale : 1.0;
            return s === 1.0 ? TSL.time : TSL.time.mul(s);
        };
        compat.timerLocal = makeTimerShim('TSL.timerLocal');
        compat.timerGlobal = makeTimerShim('TSL.timerGlobal');
        compat.maxVertexColor = (channel = 0) =>
            TSL.attribute(maxVertexColorAttributeName(channel), 'vec4');
        compat.vertexColorChannel = compat.maxVertexColor;
        if (typeof TSL.texture === 'function') {
            compat.texture = (texture, ...args) => TSL.texture(ensureTextureBindingSafe(texture), ...args);
        }
        tslCompatNamespace = compat;
        return compat;
    }

    // Evaluate TSL texture code. Snippets may return a THREE.Texture/DataTexture
    // directly, OR (preset path) a TSL color node which we bake to a texture.
    function evalTSLTexture(code, tslParams) {
        if (!code) return null;
        const cacheKey = 'tsl_tex:' + code + JSON.stringify(tslParams || {});
        if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);
        try {
            const params = buildTSLParams(code, tslParams || {});
            const fn = new Function('THREE', 'TSL', 'params', 'TEXTURES', code);
            const result = fn(THREE, getTSLCompatNamespace(), params, texturesNs);
            if (result && result.isTexture) {
                const safeTexture = ensureTextureBindingSafe(result);
                safeTexture.needsUpdate = true;
                textureCache.set(cacheKey, safeTexture);
                return safeTexture;
            }
            // Preset path: snippet returned a TSL color node — bake it to a texture.
            if (result && bakeFn) {
                const baked = bakeFn(result, {});
                if (baked && baked.isTexture) {
                    textureCache.set(cacheKey, baked);
                    return baked;
                }
            }
            debugWarn('[TSL Texture] Code did not return a Texture');
        } catch (err) {
            console.error('[TSL Texture] Eval error:', err);
        }
        return null;
    }

    function createTSLMaterial(md) {
        if (!nodeMaterialsAvailable) return null;
        try {
            const material = new THREE.MeshPhysicalNodeMaterial();
            material.side = md.side === 0 ? THREE.FrontSide : THREE.DoubleSide;
            // Pre-load textures from material map slots
            const maps = {};
            for (let i = 1; i <= 16; i++) {
                const url = md[`tslMap${i}`];
                if (url) maps[`map${i}`] = ensureTextureBindingSafe(loadTexture(url));
            }
            // Build dynamic params from @param declarations + stored values
            const params = buildTSLParams(md.tslCode, md.tslParams || {});
            // TSL code gets: material, THREE, TSL, loadTexture, maps, params, TEXTURES
            const code = md.tslCode;
            const fn = new Function('material', 'THREE', 'TSL', 'loadTexture', 'maps', 'params', 'TEXTURES', code);
            fn(material, THREE, getTSLCompatNamespace(), loadTexture, maps, params, texturesNs);
            // Store params on material for live uniform updates
            material.userData.tslParams = params;
            material.needsUpdate = true;
            return material;
        } catch (err) {
            console.error('[TSL Material] Compile error:', err);
            return new THREE.MeshStandardMaterial({ color: 0xff00ff, wireframe: true });
        }
    }

    function createMissingTSLMaterial(md) {
        if (md.materialXBridgeConnected) {
            const sourceName = md.materialXBridgeSourceName || 'connected source material';
            const reason = md.materialXBridgeError || 'auto-compile produced no MaterialX payload';
            console.error(`[MaterialX] Auto-compile bridge failed for ${sourceName}: ${reason}`);
        }
        debugWarn('[TSL Material] Missing MaterialX source and tslCode. Rendering debug fallback.', md);
        const material = new THREE.MeshStandardMaterial({
            color: 0xff00ff,
            wireframe: true,
            side: md.side === 0 ? THREE.FrontSide : THREE.DoubleSide,
        });
        material.userData ??= {};
        material.userData.maxjsTSLMissingSource = true;
        material.needsUpdate = true;
        return material;
    }

    return {
        nodeMaterialsAvailable,
        buildTSLParams,
        getTSLCompatNamespace,
        evalTSLTexture,
        createTSLMaterial,
        createMissingTSLMaterial,
        // Lazy wiring: hosts set the vendored library / bake helper after construction.
        setTextures(ns) { texturesNs = ns; },
        setBakeNodeToTexture(fn) { bakeFn = fn; },
        get textures() { return texturesNs; },
    };
}
