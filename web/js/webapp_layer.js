// webapp_layer.js — mounts a webapp (HTML page or URL) into the MaxJS viewport.
// Host building/teardown is shared with the WebApp Animator origin system in
// webapp_host.js. Two presentation modes:
//   - css3d:  iframe wrapped in a CSS3DObject (crisp DOM, clickable, overlay only).
//   - texture: HTMLMesh from three/addons (DOM rasterized to a plane mesh, composites with WebGL).
// Animation:
//   - anchor: a named Max node provides per-frame transform via matrixWorld decomposition.
//   - params: each declared param writes to host as CSS variable, dataset attribute, and postMessage.
//
// Phase 1 supports static params (spec.params[name].value). For Max-curve-driven
// live params, use the WebApp Animator origin object instead (maxjs_webapp.js).

import {
    createCSS3DHost,
    createTextureHost,
    formatParamValue,
    postParamsToIframe,
    resolveWebappUrl,
    teardownWebappHost,
    writeHostParam,
} from './webapp_host.js';

const DEFAULT_SCALE = 0.001;

function readNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function createWebappLayer(ctx, THREE, spec) {
    if (!spec || typeof spec !== 'object') {
        throw new Error('createWebappLayer: spec is required');
    }
    const presentation = spec.presentation === 'texture' ? 'texture' : 'css3d';
    let entry = null;       // { obj, host, isIframe, presentation }
    let anchorAdapter = null;
    let anchorResolved = false;
    let disposed = false;
    const tmpMatrix = new THREE.Matrix4();
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3();

    function resolveUrl(rawUrl) {
        const state = ctx.project?.getState?.();
        return resolveWebappUrl(rawUrl, state?.projectRootUrl);
    }

    async function mount() {
        if (disposed) return;
        try {
            const hostSpec = {
                url: resolveUrl(spec.url),
                width: spec.size?.width,
                height: spec.size?.height,
                interactive: !!spec.interactive,
            };
            entry = presentation === 'css3d'
                ? await createCSS3DHost(hostSpec)
                : await createTextureHost(hostSpec);
            if (disposed) {
                teardownWebappHost(entry);
                entry = null;
                return;
            }
            const scale = readNumber(spec.scale, DEFAULT_SCALE);
            entry.obj.scale.setScalar(presentation === 'texture' ? scale / 0.001 : scale);
            entry.obj.matrixAutoUpdate = true;
            ctx.js.add(entry.obj);
            applyStaticParams();
        } catch (error) {
            ctx.runtime.error('webapp_layer mount failed', error);
        }
    }

    function applyStaticParams() {
        if (!entry || !spec.params) return;
        const staticPayload = {};
        for (const [name, decl] of Object.entries(spec.params)) {
            if (!decl) continue;
            if (decl.value !== undefined) {
                const formatted = formatParamValue(decl.value);
                writeHostParam(entry.host, name, formatted);
                staticPayload[name] = decl.value;
            }
        }
        if (entry.isIframe && Object.keys(staticPayload).length > 0) {
            const iframe = entry.host;
            const send = () => postParamsToIframe(iframe, staticPayload);
            if (iframe.contentDocument?.readyState === 'complete') send();
            else iframe.addEventListener('load', send, { once: true });
        }
    }

    function resolveAnchor() {
        if (anchorResolved || !spec.anchor) return;
        const found = ctx.maxScene.findByName(spec.anchor, { exact: true });
        if (found && found.length > 0) {
            anchorAdapter = found[0];
            anchorResolved = true;
        }
    }

    function applyAnchorTransform() {
        if (!entry || !anchorAdapter) return;
        const sourceMatrix = anchorAdapter.matrixWorld;
        if (!sourceMatrix) return;
        tmpMatrix.copy(sourceMatrix);
        tmpMatrix.decompose(tmpPos, tmpQuat, tmpScale);
        entry.obj.position.copy(tmpPos);
        entry.obj.quaternion.copy(tmpQuat);
        // Preserve declared host scale; multiply in anchor scale.
        const baseScale = readNumber(spec.scale, DEFAULT_SCALE);
        const sizeScale = presentation === 'texture' ? baseScale / 0.001 : baseScale;
        entry.obj.scale.set(tmpScale.x * sizeScale, tmpScale.y * sizeScale, tmpScale.z * sizeScale);
    }

    // Kick off mounting asynchronously; ctx.runtime is fine to use.
    const mountPromise = mount();

    return {
        async init() {
            await mountPromise;
        },
        update(ctxArg, dt) {
            if (!entry) return;
            if (!anchorResolved) resolveAnchor();
            if (anchorAdapter) applyAnchorTransform();
        },
        dispose() {
            disposed = true;
            if (entry) {
                teardownWebappHost(entry);
                entry = null;
            }
        },
    };
}
