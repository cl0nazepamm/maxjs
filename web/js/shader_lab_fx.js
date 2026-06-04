// Shader Lab FX — optional custom pass for the MaxJS post-FX controller.
//
// The main render loop routes through the MaxJS FX controller. When Shader Lab
// is enabled, MaxJS FX renders its native stack to a texture and lets this module
// consume that texture as a final custom pass. This keeps SSGI / SSR / GTAO /
// bloom / DOF in front of Shader Lab, then lets the final screen blit apply
// the renderer's output tonemapping once.
//
// shader-lab is React-only (useShaderLab hook) so we spin up a hidden
// React root whose sole purpose is to hold the hook instance and hand
// us the `postprocessing` object via a ready callback. The imperative
// render loop drives it from there.
//
// Known costs:
//   - React + shader-lab loaded from esm.sh on first enable (needs net)
//   - One extra render target only while Shader Lab is active

let _loadPromise = null;

async function loadShaderLab() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
        // Use the bare specifiers resolved via the importmap in index.html
        // so React is shared between our Bridge component and shader-lab's
        // hook. esm.sh's ?external=react,react-dom on the shader-lab URL
        // rewrites the library's internal `import 'react'` to bare
        // specifiers which then resolve via the same importmap entry —
        // one React instance, one currentDispatcher, hooks work.
        const [ReactMod, ReactDOMClient, ShaderLabMod] = await Promise.all([
            import('react'),
            import('react-dom/client'),
            // Externalize react AND three so both resolve via the
            // importmap to the same instance the rest of MaxJS uses —
            // otherwise TSL stack state is per-module-instance and
            // shader-lab's assign() operations run against a stack
            // that was never opened by the MaxJS renderer.
            import('https://esm.sh/@basementstudio/shader-lab@1.3.12?external=react,react-dom,three'),
        ]);
        const React = ReactMod.default ?? ReactMod;
        const useShaderLab = ShaderLabMod.useShaderLab ?? ShaderLabMod.default?.useShaderLab;
        if (typeof useShaderLab !== 'function') {
            throw new Error('shader-lab: useShaderLab hook not found on default import');
        }
        return { React, ReactDOMClient, useShaderLab };
    })();
    return _loadPromise;
}

// Schema matches ShaderLabConfig from @basementstudio/shader-lab's
// types.d.ts. Every layer must have kind/name/visible/opacity/hue/
// saturation/blendMode/compositeMode/params — missing fields cause the
// layer to be silently skipped.
const DEFAULT_COMPOSITION = {
    composition: { width: 1920, height: 1080 },
    layers: [],
    timeline: { duration: 6, loop: true, tracks: [] },
};

const DEFAULT_PASS = {
    id: 'legacy-main',
    enabled: false,
    slot: 'finalStylize',
    requires: ['color'],
    config: DEFAULT_COMPOSITION,
};

const VALID_SLOTS = new Set(['preGrade', 'postLighting', 'finalStylize', 'depthStylize']);
const VALID_INPUTS = new Set(['color', 'depth', 'normal', 'motion']);

function isCompositionConfig(value) {
    return !!value && typeof value === 'object' && (
        Array.isArray(value.layers) ||
        !!value.composition ||
        !!value.timeline
    );
}

function normalizeRequires(requires) {
    if (!Array.isArray(requires)) return ['color'];
    const result = requires.filter(item => VALID_INPUTS.has(item));
    return result.length ? [...new Set(result)] : ['color'];
}

function normalizePass(pass, fallback = DEFAULT_PASS) {
    const source = pass && typeof pass === 'object' ? pass : {};
    const config = isCompositionConfig(source.config)
        ? source.config
        : isCompositionConfig(source)
        ? source
        : fallback.config || DEFAULT_COMPOSITION;
    return {
        id: typeof source.id === 'string' && source.id ? source.id : fallback.id || 'legacy-main',
        enabled: source.enabled != null ? !!source.enabled : !!fallback.enabled,
        slot: VALID_SLOTS.has(source.slot) ? source.slot : fallback.slot || 'finalStylize',
        requires: normalizeRequires(source.requires || fallback.requires),
        config,
    };
}

function normalizeState(input, fallbackConfig = DEFAULT_COMPOSITION) {
    if (isCompositionConfig(input)) {
        return {
            config: input,
            passes: [{ ...DEFAULT_PASS, enabled: true, config: input }],
        };
    }
    const source = input && typeof input === 'object' ? input : {};
    const config = isCompositionConfig(source.config) ? source.config : fallbackConfig;
    const fallbackPass = {
        ...DEFAULT_PASS,
        enabled: !!source.enabled,
        config,
    };
    const passes = Array.isArray(source.passes) && source.passes.length
        ? source.passes.map(pass => normalizePass(pass, fallbackPass))
        : [fallbackPass];
    return { config, passes };
}

function hasRenderableLayer(config) {
    const layers = Array.isArray(config?.layers) ? config.layers : [];
    return layers.some(layer =>
        layer
        && layer.visible !== false
        && (typeof layer.opacity !== 'number' || layer.opacity > 0)
    );
}

export function createShaderLabFx({ THREE, renderer, scene, camera }) {
    let activeCamera = camera;
    let enabled = false;
    let ready = false;
    let postprocessing = null;
    let reactRoot = null;
    let hiddenDiv = null;
    let sceneTarget = null;
    let displayScene = null;
    let displayCamera = null;
    let displayMaterial = null;
    let displayQuad = null;
    let currentConfig = DEFAULT_COMPOSITION;
    let currentPasses = [{ ...DEFAULT_PASS }];
    let errorText = '';
    let loading = false;

    function getSize() {
        const canvas = renderer.domElement;
        const w = canvas.width  || canvas.clientWidth  || 1920;
        const h = canvas.height || canvas.clientHeight || 1080;
        return { w, h };
    }

    function ensureTarget() {
        const { w, h } = getSize();
        if (sceneTarget && sceneTarget.width === w && sceneTarget.height === h) return;
        if (sceneTarget) sceneTarget.dispose();
        sceneTarget = new THREE.RenderTarget(w, h, {
            type: THREE.HalfFloatType,
            colorSpace: THREE.LinearSRGBColorSpace,
            depthBuffer: true,
            stencilBuffer: false,
        });
    }

    function ensureDisplayQuad() {
        if (displayScene) return;
        displayScene = new THREE.Scene();
        displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        displayMaterial = new THREE.MeshBasicMaterial({
            map: null,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            premultipliedAlpha: false,
            toneMapped: true,
            side: THREE.DoubleSide,
        });
        const geom = new THREE.PlaneGeometry(2, 2);
        // Flip V on the UVs so the render-target texture (which has its
        // origin at top-left in graphics-API convention) displays right
        // side up on the fullscreen quad.
        const uvArr = geom.attributes.uv.array;
        for (let i = 1; i < uvArr.length; i += 2) uvArr[i] = 1 - uvArr[i];
        geom.attributes.uv.needsUpdate = true;
        const quad = new THREE.Mesh(geom, displayMaterial);
        quad.frustumCulled = false;
        displayScene.add(quad);
        displayQuad = quad;
    }

    function disposePostprocessing(instance) {
        if (!instance || typeof instance.dispose !== 'function') return;
        try { instance.dispose(); } catch (_) { /* best effort */ }
    }

    function cleanupResources() {
        const oldPostprocessing = postprocessing;
        postprocessing = null;
        ready = false;

        try { reactRoot?.unmount(); } catch (_) {}
        reactRoot = null;

        try { hiddenDiv?.remove(); } catch (_) {}
        hiddenDiv = null;

        disposePostprocessing(oldPostprocessing);

        try { sceneTarget?.dispose(); } catch (_) {}
        sceneTarget = null;

        if (displayMaterial) {
            displayMaterial.map = null;
        }
        try { displayQuad?.geometry?.dispose?.(); } catch (_) {}
        try { displayMaterial?.dispose?.(); } catch (_) {}
        try {
            if (displayScene && displayQuad) displayScene.remove(displayQuad);
        } catch (_) {}
        displayQuad = null;
        displayMaterial = null;
        displayCamera = null;
        displayScene = null;
    }

    function emitStateChange() {
        try {
            window.dispatchEvent(new CustomEvent('maxjs-shader-lab-state', {
                detail: { enabled, ready, error: errorText },
            }));
        } catch (_) { /* ignore */ }
    }

    function getActivePass(slot = 'finalStylize') {
        return currentPasses.find(pass =>
            pass.enabled
            && pass.slot === slot
            && hasRenderableLayer(pass.config || currentConfig)
        ) || null;
    }

    function getUnavailableReason(inputs = {}) {
        if (!enabled) return 'Shader Lab disabled';
        const slot = inputs.slot || 'finalStylize';
        const pass = getActivePass(slot);
        if (!pass) return `No enabled Shader Lab pass for ${slot}`;
        const missing = pass.requires.filter(name => !inputs[name]);
        if (missing.length) return `Shader Lab pass missing ${missing.join(', ')}`;
        return '';
    }

    function canRenderWithInputs(inputs = {}) {
        return getUnavailableReason({ color: true, slot: 'finalStylize', ...inputs }) === '';
    }

    function renderBridge() {
        if (!enabled || !_React || !reactRoot || !BridgeComponent) return;
        reactRoot.render(_React.createElement(BridgeComponent, { config: currentConfig }));
    }

    async function enable(configOrState) {
        if (enabled) return;
        if (loading) return;
        loading = true;
        errorText = '';
        try {
            const { React, ReactDOMClient, useShaderLab } = await loadShaderLab();
            _React = React;
            const normalized = normalizeState(configOrState, currentConfig);
            currentConfig = normalized.config;
            currentPasses = normalized.passes.map(pass => ({
                ...pass,
                enabled: !!pass.enabled,
                config: pass.config || normalized.config,
            }));
            ensureDisplayQuad();

            BridgeComponent = function Bridge({ config: cfg }) {
                const { w, h } = getSize();
                const hookResult = useShaderLab(cfg, { renderer, width: w, height: h });
                React.useLayoutEffect(() => {
                    if (hookResult?.postprocessing) {
                        postprocessing = hookResult.postprocessing;
                        ready = true;
                        emitStateChange();
                    }
                    return () => {
                        postprocessing = null;
                        ready = false;
                    };
                }, [hookResult?.postprocessing]);
                return null;
            };

            hiddenDiv = document.createElement('div');
            hiddenDiv.style.cssText = 'display:none';
            hiddenDiv.setAttribute('aria-hidden', 'true');
            document.body.appendChild(hiddenDiv);
            reactRoot = ReactDOMClient.createRoot(hiddenDiv);
            reactRoot.render(React.createElement(BridgeComponent, { config: currentConfig }));

            enabled = true;
            loading = false;
            emitStateChange();
        } catch (err) {
            errorText = err?.message || String(err);
            console.error('[shader-lab-fx] enable failed:', err);
            enabled = false;
            loading = false;
            _React = null;
            cleanupResources();
            emitStateChange();
            throw err;
        }
    }

    function disable() {
        if (!enabled) return;
        enabled = false;
        lastOutputTex = null;
        currentPasses = currentPasses.map(pass => ({ ...pass, enabled: false }));
        cleanupResources();
        emitStateChange();
    }

    let BridgeComponent = null;
    let _React = null;

    async function setConfig(config) {
        currentConfig = config || DEFAULT_COMPOSITION;
        currentPasses = currentPasses.map(pass =>
            pass.id === 'legacy-main' || pass.slot === 'finalStylize'
                ? { ...pass, config: currentConfig }
                : pass
        );
        renderBridge();
    }

    function setPasses(passes) {
        const normalized = normalizeState({ config: currentConfig, passes }, currentConfig);
        currentPasses = normalized.passes;
        const finalPass = getActivePass('finalStylize') || currentPasses.find(pass => pass.slot === 'finalStylize');
        if (finalPass?.config) {
            currentConfig = finalPass.config;
            renderBridge();
        }
    }

    function getPasses() {
        return currentPasses.map(pass => ({
            ...pass,
            requires: [...pass.requires],
            config: pass.config,
        }));
    }

    function setState(snapshot) {
        const normalized = normalizeState(snapshot, currentConfig);
        currentConfig = normalized.config;
        currentPasses = normalized.passes;
        renderBridge();
    }

    // Integrated render path. MaxJS FX owns the native render stack and passes
    // its final texture here only when Shader Lab has a compatible final pass.
    let lastOutputTex = null;

    function blitTexture(texture, outputTarget = null) {
        ensureDisplayQuad();
        if (!texture || !displayMaterial) return false;
        if (displayMaterial.map !== texture) {
            displayMaterial.map = texture;
            displayMaterial.needsUpdate = true;
        }
        renderer.setClearColor?.(0x000000, 0);
        renderer.setRenderTarget(outputTarget);
        renderer.render(displayScene, displayCamera);
        return true;
    }

    function renderWithoutOutputToneMapping(fn) {
        const previousToneMapping = renderer.toneMapping;
        const previousExposure = renderer.toneMappingExposure;
        const previousOutputColorSpace = renderer.outputColorSpace;
        try {
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.0;
            renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
            return fn();
        } finally {
            renderer.toneMapping = previousToneMapping;
            renderer.toneMappingExposure = previousExposure;
            renderer.outputColorSpace = previousOutputColorSpace;
        }
    }

    function renderTexture(inputTexture, elapsedTime, delta, options = {}) {
        const inputs = { color: true, slot: 'finalStylize', ...(options.inputs || {}) };
        const unavailable = getUnavailableReason(inputs);
        if (unavailable) {
            errorText = unavailable;
            return false;
        }
        if (!ready || !postprocessing) {
            return blitTexture(inputTexture, options.outputTarget || null);
        }
        try {
            const output = renderWithoutOutputToneMapping(() =>
                postprocessing.render(
                    inputTexture,
                    elapsedTime,
                    delta
                )
            );

            const outputTex = output?.isTexture ? output : output?.texture ?? output;
            if (outputTex) {
                lastOutputTex = outputTex;
                return blitTexture(outputTex, options.outputTarget || null);
            }
            return blitTexture(inputTexture, options.outputTarget || null);
        } catch (err) {
            errorText = err?.message || String(err);
            console.error('[shader-lab-fx] frame render failed:', err);
            return blitTexture(inputTexture, options.outputTarget || null);
        }
    }

    // Backward-compatible fallback for old callers. The MaxJS frame loop no
    // longer uses this path, but keeping it prevents stale debug hooks from
    // hard-failing during development.
    function renderFrame(elapsedTime, delta) {
        if (!enabled || !ready || !postprocessing) {
            renderer.render(scene, activeCamera);
            return;
        }
        ensureTarget();
        try {
            renderer.setRenderTarget(sceneTarget);
            renderer.render(scene, activeCamera);
            renderer.setRenderTarget(null);
            renderTexture(sceneTarget.texture, elapsedTime, delta);
        } catch (err) {
            errorText = err?.message || String(err);
            console.error('[shader-lab-fx] legacy frame render failed:', err);
            renderer.setRenderTarget(null);
            renderer.render(scene, activeCamera);
        }
    }

    function resize(width, height) {
        if (sceneTarget) sceneTarget.setSize(width, height);
        if (postprocessing?.setSize) postprocessing.setSize(width, height);
    }

    return {
        enable,
        disable,
        setConfig,
        setPasses,
        getPasses,
        setState,
        canRenderWithInputs,
        getUnavailableReason,
        renderTexture,
        renderFrame,
        resize,
        setCamera(nextCamera) { if (nextCamera) activeCamera = nextCamera; },
        isEnabled: () => enabled,
        isReady:   () => ready,
        getError:  () => errorText,
    };
}
