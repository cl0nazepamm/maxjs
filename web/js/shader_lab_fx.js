// Shader Lab FX — bypass-ssgi post-processing mode.
//
// When enabled, MaxJS's main render loop skips ssgiFx.render() and calls
// shaderLabFx.renderFrame() instead. The scene renders to an internal
// renderer render target, that target's texture is piped into shader-lab's
// postprocessing pipeline, and the output is blitted to the canvas via a
// fullscreen quad. No ssgiFx modifications — it's a parallel path.
//
// shader-lab is React-only (useShaderLab hook) so we spin up a hidden
// React root whose sole purpose is to hold the hook instance and hand
// us the `postprocessing` object via a ready callback. The imperative
// render loop drives it from there.
//
// Known costs:
//   - Loses SSGI / SSR / GTAO / bloom / DOF / tone-mapping in this mode
//   - React + shader-lab loaded from esm.sh on first enable (needs net)
//   - Extra render target for the scene pass

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
    layers: [
        {
            id: 'crt-1',
            kind: 'effect',
            type: 'crt',
            name: 'CRT',
            visible: true,
            opacity: 1,
            hue: 0,
            saturation: 1,
            blendMode: 'normal',
            compositeMode: 'filter',
            params: {},
        },
    ],
    timeline: { duration: 6, loop: true, tracks: [] },
};

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
    let configKey = 0;
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
            toneMapped: false,
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

    async function enable(config) {
        if (enabled) return;
        if (loading) return;
        loading = true;
        errorText = '';
        try {
            const { React, ReactDOMClient, useShaderLab } = await loadShaderLab();
            _React = React;
            currentConfig = config || DEFAULT_COMPOSITION;
            configKey++;
            ensureTarget();
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
            reactRoot.render(React.createElement(BridgeComponent, { config: currentConfig, key: configKey }));

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
        cleanupResources();
        emitStateChange();
    }

    let BridgeComponent = null;
    let _React = null;

    async function setConfig(config) {
        currentConfig = config || DEFAULT_COMPOSITION;
        if (!enabled || !_React || !reactRoot) return;
        configKey++;
        reactRoot.render(_React.createElement(BridgeComponent, { config: currentConfig, key: configKey }));
    }

    // Main render path when enabled. Called from the frame loop in place
    // of ssgiFx.render().
    let lastOutputTex = null;

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

            const output = postprocessing.render(
                sceneTarget.texture,
                elapsedTime,
                delta
            );

            const outputTex = output?.isTexture ? output : output?.texture ?? output;
            if (outputTex && displayMaterial) {
                if (displayMaterial.map !== outputTex) {
                    displayMaterial.map = outputTex;
                    displayMaterial.needsUpdate = true;
                    lastOutputTex = outputTex;
                }
                renderer.render(displayScene, displayCamera);
            } else {
                renderer.render(scene, activeCamera);
            }
        } catch (err) {
            errorText = err?.message || String(err);
            console.error('[shader-lab-fx] frame render failed:', err);
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
        renderFrame,
        resize,
        setCamera(nextCamera) { if (nextCamera) activeCamera = nextCamera; },
        isEnabled: () => enabled,
        isReady:   () => ready,
        getError:  () => errorText,
    };
}
