// webgl_basicfx.js - tiny WGL2-only post stack for user-authored WebGL effects.
//
// This intentionally stays separate from maxjs_fx.js. It has no TSL imports,
// no SSGI/SSR/GTAO concepts, and no built-in heavy passes. It only provides a
// stable place for GLSL/fullscreen passes to own final presentation in WGL2.

export function createWebGLBasicFx({
    THREE,
    renderer,
    scene,
    camera,
    backendLabel = '',
    onError = console.warn,
} = {}) {
    const isWgl2 = backendLabel === 'WGL2 Mode' || backendLabel === 'WebGL2';
    const passes = new Map();
    const drawSize = new THREE.Vector2();
    let readTarget = null;
    let writeTarget = null;
    let fullscreenScene = null;
    let fullscreenCamera = null;
    let fullscreenMesh = null;
    let copyMaterial = null;
    let disposed = false;
    let state = {
        enabled: true,
        passes: [],
    };

    function isAvailable() {
        return !!isWgl2 && !!renderer && !!scene && !!camera && !disposed;
    }

    function getDrawSize() {
        if (typeof renderer?.getDrawingBufferSize === 'function') {
            renderer.getDrawingBufferSize(drawSize);
        } else if (typeof renderer?.getSize === 'function') {
            renderer.getSize(drawSize);
        } else {
            drawSize.set(
                Math.max(1, Math.round(renderer?.domElement?.width || globalThis.innerWidth || 1)),
                Math.max(1, Math.round(renderer?.domElement?.height || globalThis.innerHeight || 1)),
            );
        }
        drawSize.x = Math.max(1, Math.round(drawSize.x || 1));
        drawSize.y = Math.max(1, Math.round(drawSize.y || 1));
        return drawSize;
    }

    function makeTarget(width, height) {
        const TargetCtor = THREE.WebGLRenderTarget || THREE.RenderTarget;
        return new TargetCtor(width, height, {
            depthBuffer: false,
            stencilBuffer: false,
        });
    }

    function ensureTargets() {
        const size = getDrawSize();
        if (readTarget && writeTarget && readTarget.width === size.x && readTarget.height === size.y) {
            return;
        }
        disposeTargets();
        readTarget = makeTarget(size.x, size.y);
        writeTarget = makeTarget(size.x, size.y);
    }

    function ensureFullscreen() {
        if (fullscreenScene) return;
        fullscreenScene = new THREE.Scene();
        fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const geometry = new THREE.PlaneGeometry(2, 2);
        fullscreenMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }));
        fullscreenMesh.frustumCulled = false;
        fullscreenScene.add(fullscreenMesh);
    }

    function orderedPasses() {
        return [...passes.values()]
            .filter(pass => pass?.enabled !== false)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    function hasEnabledEffects() {
        return isAvailable() && state.enabled !== false && orderedPasses().length > 0;
    }

    function renderFullscreen(material, outputTarget = null) {
        if (!material) return false;
        ensureFullscreen();
        const previousTarget = renderer.getRenderTarget?.() ?? null;
        const previousMaterial = fullscreenMesh.material;
        fullscreenMesh.material = material;
        renderer.setRenderTarget(outputTarget);
        renderer.render(fullscreenScene, fullscreenCamera);
        renderer.setRenderTarget(previousTarget);
        fullscreenMesh.material = previousMaterial;
        return true;
    }

    function copyTexture(inputTexture, outputTarget = null) {
        if (!inputTexture) return false;
        if (!copyMaterial) {
            copyMaterial = new THREE.MeshBasicMaterial({ map: inputTexture });
        } else {
            copyMaterial.map = inputTexture;
            copyMaterial.needsUpdate = true;
        }
        const copied = renderFullscreen(copyMaterial, outputTarget);
        copyMaterial.map = null;
        return copied;
    }

    function render(renderScene = () => renderer.render(scene, camera)) {
        if (!hasEnabledEffects()) {
            renderScene();
            return false;
        }

        try {
            ensureTargets();
            const activePasses = orderedPasses();
            const previousTarget = renderer.getRenderTarget?.() ?? null;

            renderer.setRenderTarget(readTarget);
            renderScene();
            renderer.setRenderTarget(previousTarget);

            let inputTarget = readTarget;
            let outputTarget = null;
            for (let i = 0; i < activePasses.length; i++) {
                const pass = activePasses[i];
                const isLast = i === activePasses.length - 1;
                outputTarget = isLast ? null : writeTarget;

                let consumed = false;
                if (typeof pass.render === 'function') {
                    consumed = pass.render({
                        THREE,
                        renderer,
                        scene,
                        camera,
                        inputTexture: inputTarget.texture,
                        inputTarget,
                        outputTarget,
                        renderScene,
                        renderFullscreen,
                    }) !== false;
                } else if (pass.material) {
                    if (pass.material.uniforms?.tDiffuse) {
                        pass.material.uniforms.tDiffuse.value = inputTarget.texture;
                    }
                    consumed = renderFullscreen(pass.material, outputTarget);
                }

                if (!consumed) {
                    copyTexture(inputTarget.texture, outputTarget);
                }

                if (!isLast) {
                    const swap = inputTarget;
                    inputTarget = outputTarget;
                    outputTarget = swap;
                    writeTarget = outputTarget;
                }
            }
            return true;
        } catch (error) {
            onError?.('[webgl_basicfx] render failed', error);
            try { renderer.setRenderTarget(null); } catch {}
            renderScene();
            return false;
        }
    }

    function syncStateFromPasses() {
        state.passes = [...passes.values()].map(pass => ({
            id: pass.id,
            enabled: pass.enabled !== false,
            order: Number.isFinite(pass.order) ? pass.order : 0,
            type: pass.type || (pass.material ? 'material' : 'custom'),
            config: pass.config && typeof pass.config === 'object' ? { ...pass.config } : {},
        }));
    }

    function registerPass(pass = {}) {
        if (!pass.id) throw new Error('webglBasicFx.registerPass: pass.id is required');
        const next = {
            enabled: true,
            order: 0,
            ...pass,
        };
        passes.set(next.id, next);
        syncStateFromPasses();
        return () => unregisterPass(next.id);
    }

    function unregisterPass(id) {
        const pass = passes.get(id);
        if (!pass) return false;
        passes.delete(id);
        pass.dispose?.();
        syncStateFromPasses();
        return true;
    }

    function setPassEnabled(id, enabled) {
        const pass = passes.get(id);
        if (!pass) return false;
        pass.enabled = !!enabled;
        syncStateFromPasses();
        return pass.enabled;
    }

    function restoreState(snapshot = {}) {
        if (typeof snapshot.enabled === 'boolean') state.enabled = snapshot.enabled;
        if (Array.isArray(snapshot.passes)) {
            for (const saved of snapshot.passes) {
                const pass = passes.get(saved?.id);
                if (!pass) continue;
                if (typeof saved.enabled === 'boolean') pass.enabled = saved.enabled;
                if (Number.isFinite(saved.order)) pass.order = saved.order;
                if (saved.config && typeof saved.config === 'object') {
                    pass.config = { ...(pass.config || {}), ...saved.config };
                    pass.setConfig?.(pass.config);
                }
            }
        }
        syncStateFromPasses();
        return getState();
    }

    function getState() {
        syncStateFromPasses();
        return {
            enabled: state.enabled !== false,
            passes: state.passes.map(pass => ({
                ...pass,
                config: pass.config && typeof pass.config === 'object' ? { ...pass.config } : {},
            })),
        };
    }

    function disposeTargets() {
        readTarget?.dispose?.();
        writeTarget?.dispose?.();
        readTarget = null;
        writeTarget = null;
    }

    function dispose() {
        disposed = true;
        for (const pass of passes.values()) pass.dispose?.();
        passes.clear();
        disposeTargets();
        fullscreenMesh?.geometry?.dispose?.();
        fullscreenMesh?.material?.dispose?.();
        copyMaterial?.dispose?.();
        fullscreenScene = null;
        fullscreenCamera = null;
        fullscreenMesh = null;
        copyMaterial = null;
    }

    return {
        isAvailable,
        isEnabled: () => state.enabled !== false,
        setEnabled: (enabled) => {
            state.enabled = !!enabled;
            return state.enabled;
        },
        hasEnabledEffects,
        registerPass,
        unregisterPass,
        setPassEnabled,
        getState,
        restoreState,
        setCamera(nextCamera) {
            if (nextCamera) camera = nextCamera;
        },
        resize() {
            if (readTarget || writeTarget) ensureTargets();
        },
        markSceneChanged() {},
        markOutputChanged() {},
        markEnvironmentChanged() {},
        render,
        dispose,
    };
}
