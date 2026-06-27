// Shared post-FX frame-graph core — used by BOTH the editor facade
// (maxjs_fx.js, static registry) and the standalone snapshot viewer
// (snapshot_fx.js, dynamic loader). The graph-building code here is a
// verbatim move of the old maxjs_fx.js rebuildPipeline(): same fold, same
// node order, so editor and snapshot are structurally pixel-identical.
//
// Core-resident concerns (NOT descriptors, NOT dynamic modules):
//   - shared pre-pass (depth/normal/velocity MRT union)
//   - scene pass MRT + texture extraction + beauty-alpha coverage
//   - env-backdrop compensation (depends on environmentVisible + ssr/fog)
//   - PS1 vertex snap (material-level, driven by retro.wiggle / shaderlab)
//   - scene.fogNode fog (applySceneFog) + fog/pixel frame timers
//   - forced contact-shadow light, toon-mesh cache, deep node disposal
//
// Shader Lab, PowerShot, the clone CPU overlay, and colorGrading (CSS canvas
// filter) stay in the editor facade — they are final-stylize / CPU concerns,
// not part of the TSL composite.
import * as THREE from 'three';
import {
    color,
    densityFogFactor,
    diffuseColor,
    float,
    fog,
    max,
    metalness,
    mrt,
    normalView,
    output,
    packNormalToRGB,
    pass,
    positionLocal,
    positionView,
    positionWorld,
    rangeFogFactor,
    roughness,
    sample,
    screenSize,
    texture,
    triNoise3D,
    uniform,
    unpackRGBToNormal,
    vec2,
    vec3,
    vec4,
    velocity,
    Fn,
    cameraProjectionMatrix,
    cameraViewMatrix,
    modelWorldMatrix,
} from 'three/tsl';

// Effects safe to run on a path-traced source: pure color-domain folds that
// need no gbuffer. Everything else (SSGI/SSR/GTAO/DOF/fog/motionBlur/...)
// reads depth/normal the PT has no gbuffer for — and PT already does GI/DOF —
// so they are gated off whenever ctx.pathTracedColor is set.
const PT_SAFE_EFFECTS = new Set(['bloom', 'pixel', 'retro']);

function setTexturePrecision(scenePass) {
    const diffuseTexture = scenePass.getTexture('diffuseColor');
    if (diffuseTexture) diffuseTexture.type = THREE.UnsignedByteType;

    const normalTexture = scenePass.getTexture('normal');
    if (normalTexture) normalTexture.type = THREE.UnsignedByteType;

    const metalRoughTexture = scenePass.getTexture('metalrough');
    if (metalRoughTexture) metalRoughTexture.type = THREE.UnsignedByteType;
}

export function createFxCore({
    renderer,
    scene,
    descriptors = [],
    state,
    getCamera,
    getMainLight = () => null,
    supportsScreenSpaceEffects = false,
    supportsTslPostEffects = supportsScreenSpaceEffects,
    isShaderLabEnabled = () => false,
    getEnvironmentVisible = () => true,
    getResolutionScale = () => 1.0,
}) {
    const PipelineCtor = THREE.RenderPipeline || THREE.PostProcessing;
    const postProcessing = new PipelineCtor(renderer);
    const emptyOutputNode = vec4(0, 0, 0, 0);
    const SSR_REFERENCE_SIZE = 6.0;

    const byId = new Map(descriptors.map((d) => [d.id, d]));
    const sorted = [...descriptors].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

    let activeNodes = [];
    const activePasses = new Map();
    let activeScenePass = null;

    // ── Effect context ──────────────────────────────────────────────────
    // One persistent ctx per core; per-build fields are reset at the top of
    // buildPipeline(). Descriptor build()/update() read everything from here
    // instead of closure locals — that is the whole refactor.

    const uniforms = {
        dofFocusDistanceU: uniform(100),
        dofFocalLengthU: uniform(50),
        dofBokehScaleU: uniform(5),
        retroCurvatureU: uniform(0.02),
        retroBleedingU: uniform(0.001),
        retroColorDepthU: uniform(32),
        retroScanlineIntensityU: uniform(0.3),
        retroScanlineDensityU: uniform(1),
        retroVignetteIntensityU: uniform(0.3),
        pixelSizeU: uniform(4),
        pixelChromaticIntensityU: uniform(0.005),
        pixelSharpenStrengthU: uniform(0.5),
        pixelGrainIntensityU: uniform(0.08),
        pixelBrightnessU: uniform(0),
        pixelContrastU: uniform(0),
        pixelSaturationU: uniform(0),
        fogTimer: uniform(0),
        pixelTimer: uniform(0),
    };

    let currentBeauty = null;
    let currentBeautyAlpha = null;
    let currentDerived = null;

    const ctx = {
        THREE,
        renderer,
        scene,
        state,
        uniforms,
        shared: {},
        get camera() { return getCamera(); },
        get mainLight() { return getMainLight(); },
        get derived() { return currentDerived; },
        get beauty() { return currentBeauty; },
        set beauty(node) { currentBeauty = node; },
        get beautyAlpha() { return currentBeautyAlpha; },
        set beautyAlpha(node) { currentBeautyAlpha = node; },
        prePass: null,
        scenePass: null,
        sceneTex: null,
        sceneContext: null,
        pathTracedColor: null, // when set, the linear-HDR PT texture replaces the scene pass
        isShaderLabEnabled,
        has: isEffectActive,
        pushNode(node) { activeNodes.push(node); },
        setActivePass(key, passNode) { activePasses.set(key, passNode); },
        getActivePass(key) { return activePasses.get(key) ?? null; },
        applyNodeResolutionScale,
        raiseBeautyAlpha(alphaNode) {
            currentBeautyAlpha = max(currentBeautyAlpha, alphaNode);
            return currentBeautyAlpha;
        },
        withBeautyAlpha(node) { return vec4(node.rgb, currentBeautyAlpha); },
        getToonMeshes,
    };

    function isEffectActive(id) {
        const descriptor = byId.get(id);
        if (!descriptor || !state[id]?.enabled) return false;
        // Path-traced source → color-domain effects only (no gbuffer exists).
        if (ctx.pathTracedColor && !PT_SAFE_EFFECTS.has(id)) return false;
        const supports = (id === 'ssr' || id === 'bloom')
            ? supportsTslPostEffects
            : supportsScreenSpaceEffects;
        if (!supports) return false;
        if (typeof descriptor.activeWhen === 'function' && !descriptor.activeWhen(ctx)) return false;
        return true;
    }

    function anyEffectActive() {
        return sorted.some((d) =>
            isEffectActive(d.id) && (d.id !== 'toonOutline' || cachedHasToonMeshes));
    }

    function deactivateInactiveEffects() {
        for (const d of sorted) {
            if (!isEffectActive(d.id)) d.deactivate?.(ctx);
        }
    }

    function deactivateAllEffects() {
        for (const d of sorted) d.deactivate?.(ctx);
    }

    // ── Resolution scaling ──────────────────────────────────────────────

    function getCombinedPostFxResolutionScale(extraScale = 1.0) {
        const extra = Number(extraScale);
        const safeExtra = Number.isFinite(extra) ? extra : 1.0;
        return THREE.MathUtils.clamp(getResolutionScale() * safeExtra, 0.1, 1.0);
    }

    function getScaledPostFxSize(width, height, extraScale = 1.0) {
        const scale = getCombinedPostFxResolutionScale(extraScale);
        return {
            width: Math.max(2, Math.round(width * scale)),
            height: Math.max(2, Math.round(height * scale)),
        };
    }

    function applyNodeResolutionScale(node, extraScale = 1.0) {
        if (!node) return;
        const scale = getCombinedPostFxResolutionScale(extraScale);
        if (typeof node.setResolutionScale === 'function') {
            node.setResolutionScale(scale);
        } else if ('resolutionScale' in node) {
            node.resolutionScale = scale;
        }
    }

    // ── Toon mesh cache — refreshed on pipeline rebuild, not every frame ──

    let cachedHasToonMeshes = false;

    function refreshToonMeshCache() {
        cachedHasToonMeshes = false;
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.visible) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (m && m.isMeshToonMaterial) {
                    cachedHasToonMeshes = true;
                    return;
                }
            }
        });
    }

    function getToonMeshes() {
        // Only used during pipeline rebuild — returns fresh list
        const result = [];
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.visible) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (m && m.isMeshToonMaterial) {
                    result.push(obj);
                    break;
                }
            }
        });
        return result;
    }

    // ── Post-pass hide list ─────────────────────────────────────────────

    let postPassHideList = [];
    let normalsComputed = new WeakSet();
    let hiddenDuringPost = [];

    function refreshPostPassHideList() {
        postPassHideList = [];
        scene.traverse((object) => {
            if (!object?.visible) return;
            if (object.isLine || object.isLineSegments || object.isPoints || object.isSprite) {
                postPassHideList.push(object);
            }
            // Pre-compute normals once, not every frame
            if (object.isMesh && object.geometry && !normalsComputed.has(object.geometry)) {
                if (!object.geometry.getAttribute?.('normal') && object.geometry.getAttribute?.('position')) {
                    try { object.geometry.computeVertexNormals(); } catch {}
                }
                normalsComputed.add(object.geometry);
            }
        });
    }

    function prepareSceneForPostPass() {
        hiddenDuringPost = postPassHideList.filter(o => o.visible);
        for (const o of hiddenDuringPost) o.visible = false;
    }

    function restoreSceneAfterPostPass() {
        for (const o of hiddenDuringPost) o.visible = true;
        hiddenDuringPost = [];
    }

    // ── Forced contact-shadow light ─────────────────────────────────────

    let forcedContactShadowLightState = null;

    function restoreForcedContactShadowLight() {
        if (!forcedContactShadowLightState) return;

        const { light, castShadow, shadowIntensity } = forcedContactShadowLightState;
        forcedContactShadowLightState = null;

        if (!light) return;

        light.castShadow = castShadow;
        if (light.shadow && shadowIntensity != null) {
            light.shadow.intensity = shadowIntensity;
            light.shadow.needsUpdate = true;
        }
    }

    function ensureMainLightSupportsContactShadow() {
        const mainLight = getMainLight();
        if (!state.contactShadow?.enabled || !mainLight?.isDirectionalLight) {
            restoreForcedContactShadowLight();
            return;
        }

        if (forcedContactShadowLightState?.light && forcedContactShadowLightState.light !== mainLight) {
            restoreForcedContactShadowLight();
        }

        if (mainLight.castShadow || forcedContactShadowLightState?.light === mainLight) return;

        forcedContactShadowLightState = {
            light: mainLight,
            castShadow: mainLight.castShadow,
            shadowIntensity: mainLight.shadow && Number.isFinite(mainLight.shadow.intensity)
                ? mainLight.shadow.intensity
                : null,
        };

        mainLight.castShadow = true;
        if (mainLight.shadow) {
            if (typeof mainLight.shadow.intensity === 'number') {
                mainLight.shadow.intensity = 0;
            }
            mainLight.shadow.needsUpdate = true;
        }
    }

    function cleanupUnsupportedRealtimeResources() {
        if (supportsScreenSpaceEffects) return;
        restoreForcedContactShadowLight();
        deactivateAllEffects();
        activePasses.delete('contactShadow');
    }

    // ── Node disposal ───────────────────────────────────────────────────

    function disposeResource(resource, seen) {
        if (!resource || seen.has(resource)) return;
        seen.add(resource);
        if (typeof resource.dispose === 'function') {
            try { resource.dispose(); } catch (_) { /* best effort */ }
        }
    }

    function disposeResourceMap(map, seen) {
        if (!map) return;
        const values = map instanceof Map ? map.values() : Object.values(map);
        for (const value of values) {
            disposeResource(value, seen);
        }
    }

    function detachPostProcessingGraph() {
        postProcessing.outputNode = emptyOutputNode;
        postProcessing._context = null;
        postProcessing.needsUpdate = true;

        const quadMat = postProcessing?._quadMesh?.material;
        if (!quadMat) return;

        disposeResource(quadMat, new Set());
        quadMat.fragmentNode = null;
        quadMat.needsUpdate = true;
    }

    // Deep-dispose a post-FX node. PassNode owns render targets and temporal
    // previous-frame texture clones; RTTNode from convertToTexture owns its
    // render target plus a private quad material. Three's base Node.dispose()
    // only dispatches an event, so walk the private ownership fields too.
    function disposeNodeDeep(node, seen) {
        if (!node) return;
        try {
            disposeResource(node.renderTarget, seen);
            disposeResourceMap(node._previousTextures, seen);
            disposeResourceMap(node._textures, seen);
            disposeResource(node._quadMesh?.material, seen);
            disposeResource(node, seen);

            node.scene = null;
            node.camera = null;
            node.contextNode = null;
            node.renderTarget = null;
            node._previousTextures = {};
            node._previousTextureNodes = {};
            node._textures = {};
            node._textureNodes = {};
            node._linearDepthNodes = {};
            node._viewZNodes = {};
            node._contextNodeCache = null;
        } catch (_) {
            // Cleanup must never break a rebuild.
        }
    }

    function clearNodes() {
        detachPostProcessingGraph();
        activePasses.clear();
        activeScenePass = null;
        const seen = new Set();
        for (const node of activeNodes) {
            disposeNodeDeep(node, seen);
        }
        activeNodes = [];
    }

    // ── Derived state ───────────────────────────────────────────────────

    function computeSceneReferenceSize() {
        const box = new THREE.Box3();
        let foundMesh = false;

        scene.traverse((object) => {
            if (!object?.visible || !object.isMesh || !object.geometry) return;
            const position = object.geometry.getAttribute?.('position');
            if (!position || position.count === 0) return;
            box.expandByObject(object);
            foundMesh = true;
        });

        if (!foundMesh || box.isEmpty()) return SSR_REFERENCE_SIZE;

        const size = box.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z);
        return Number.isFinite(maxDimension) && maxDimension > 1.0e-3
            ? maxDimension
            : SSR_REFERENCE_SIZE;
    }

    function computeDerivedState() {
        const sceneReferenceSize = computeSceneReferenceSize();
        const ssrUnitScale = Math.max(1, sceneReferenceSize / SSR_REFERENCE_SIZE);

        // Optional chaining: the snapshot core only carries state for the
        // effects it loaded; fall back to descriptor defaults.
        return {
            sceneReferenceSize,
            ssrUnitScale,
            effectiveSSRMaxDistance: (state.ssr?.maxDistance ?? 0.5) * ssrUnitScale,
            effectiveSSRThickness: (state.ssr?.thickness ?? 0.015) * ssrUnitScale,
            effectiveGTAORadius: (state.gtao?.radius ?? 0.5) * ssrUnitScale,
            effectiveGTAOThickness: (state.gtao?.thickness ?? 1.0) * ssrUnitScale,
            effectiveContactShadowMaxDistance: (state.contactShadow?.maxDistance ?? 0.1) * ssrUnitScale,
            effectiveContactShadowThickness: (state.contactShadow?.thickness ?? 0.006) * ssrUnitScale,
            ps1SnapActive: isPS1WiggleActive(),
        };
    }

    // ── PS1 Vertex Snap ─────────────────────────────────────────────────
    // Snaps vertices to screen-pixel grid in clip space. Modifies materials
    // in-place — no material cloning, no CubeMapNode overhead, no separate
    // render pass.

    const ps1SnapStrength = uniform(5.0);
    // PS1 vertex snap — outputs clip-space position via vertexNode (bypasses Three.js projection)
    const ps1VertexSnap = Fn(() => {
        const worldPos = modelWorldMatrix.mul(vec4(positionLocal, 1.0));
        const clipPos = cameraProjectionMatrix.mul(cameraViewMatrix).mul(worldPos);
        const w = clipPos.w;
        const ndc = clipPos.xy.div(w);
        const screenPx = ndc.add(1.0).mul(0.5).mul(screenSize);
        const grid = ps1SnapStrength;
        const snappedPx = screenPx.div(grid).floor().mul(grid);
        const snappedNdc = snappedPx.div(screenSize).mul(2.0).sub(1.0);
        return vec4(snappedNdc.mul(w), clipPos.z, w);
    })();

    let ps1WiggleActive = false;
    let ps1SceneDirty = true;
    const ps1SavedNodes = new Map();

    function isPS1WiggleActive() {
        return supportsScreenSpaceEffects
            && !!state.retro?.wiggle
            && (state.retro?.enabled || isShaderLabEnabled());
    }

    function ps1SavedVertexNode(saved) {
        return saved && typeof saved === 'object' && Object.prototype.hasOwnProperty.call(saved, 'vertexNode')
            ? saved.vertexNode
            : saved;
    }

    function restorePS1Material(mat) {
        if (!ps1SavedNodes.has(mat)) return;
        mat.vertexNode = ps1SavedVertexNode(ps1SavedNodes.get(mat));
        ps1SavedNodes.delete(mat);
    }

    function hasPS1ExcludedToken(value) {
        const text = String(value || '').toLowerCase();
        return /(^|[_\-\s])(sky|skydome|skybox|background|backdrop|environment|env)([_\-\s]|$)/.test(text);
    }

    function shouldSkipPS1Object(obj) {
        if (!obj || (!obj.isMesh && !obj.isSkinnedMesh && !obj.isInstancedMesh)) return true;
        const data = obj.userData || {};
        if (data.maxjsNoPS1Wiggle || data.maxjsSky || data.maxjsBackground || data.maxjsBackdrop) return true;
        if (obj.isSky || obj.isSkyMesh || hasPS1ExcludedToken(obj.name) || hasPS1ExcludedToken(obj.type)) return true;
        return false;
    }

    function shouldSkipPS1Material(mat) {
        if (!mat) return true;
        const data = mat.userData || {};
        if (data.maxjsNoPS1Wiggle || data.maxjsSky || data.maxjsBackground || data.maxjsBackdrop) return true;
        return hasPS1ExcludedToken(mat.name) || hasPS1ExcludedToken(mat.type);
    }

    function enablePS1Wiggle(strength = 5.0) {
        ps1SnapStrength.value = Math.max(1.0, strength);
        ps1WiggleActive = true;
        scene.traverse(obj => {
            const skipObject = shouldSkipPS1Object(obj);
            const mats = obj.material
                ? (Array.isArray(obj.material) ? obj.material : [obj.material])
                : [];
            for (const mat of mats) {
                if (skipObject || shouldSkipPS1Material(mat)) {
                    restorePS1Material(mat);
                    continue;
                }
                if (ps1SavedNodes.has(mat)) continue;
                ps1SavedNodes.set(mat, { vertexNode: mat.vertexNode || null, object: obj });
                mat.vertexNode = ps1VertexSnap;
            }
        });
    }

    function disablePS1Wiggle() {
        if (!ps1WiggleActive && ps1SavedNodes.size === 0) return;
        ps1WiggleActive = false;
        for (const [mat, saved] of ps1SavedNodes) {
            mat.vertexNode = ps1SavedVertexNode(saved);
        }
        ps1SavedNodes.clear();
    }

    function syncSharedSceneEffects(force = false) {
        const shouldUsePS1Wiggle = isPS1WiggleActive();
        if (shouldUsePS1Wiggle) {
            if (force || ps1SceneDirty || !ps1WiggleActive) {
                enablePS1Wiggle(state.retro?.affineDistortion ?? 5.0);
            } else {
                ps1SnapStrength.value = Math.max(1.0, state.retro?.affineDistortion ?? 5.0);
            }
        } else {
            disablePS1Wiggle();
        }
        ps1SceneDirty = false;
    }

    // ── Fog — applied via scene.fogNode (independent of post-processing) ──

    let fogAnimationActive = false;

    function applySceneFog() {
        const f = state.fog;
        if (!supportsScreenSpaceEffects || !f?.enabled) {
            scene.fogNode = null;
            fogAnimationActive = false;
            return;
        }
        const camera = getCamera();

        const fogColor = color(f.color[0], f.color[1], f.color[2]);

        if (f.type === 0) {
            // Range fog (linear near/far)
            const factor = rangeFogFactor(f.near, f.far);
            scene.fogNode = fog(fogColor, factor.mul(float(f.opacity)));
        } else if (f.type === 1) {
            // Density fog (exponential)
            const factor = densityFogFactor(f.density);
            scene.fogNode = fog(fogColor, factor.mul(float(f.opacity)));
        } else if (f.type === 2) {
            // Custom procedural fog with triNoise3D
            const groundColor = fogColor;
            const fogDistance = positionView.z.negate().smoothstep(0, camera.far.sub ? camera.far : float(1000));
            const distance = fogDistance.mul(float(f.height)).max(float(4));
            const groundFogArea = distance.sub(positionWorld.y).div(distance).pow(3).saturate().mul(float(f.opacity));

            const noiseA = triNoise3D(positionWorld.mul(float(f.noiseScale)), float(0.2), uniforms.fogTimer);
            const noiseB = triNoise3D(positionWorld.mul(float(f.noiseScale * 2)), float(0.2), uniforms.fogTimer.mul(float(1.2)));
            const fogNoise = noiseA.add(noiseB).mul(groundColor);

            scene.fogNode = fog(fogDistance.oneMinus().mix(groundColor, fogNoise), groundFogArea);
            fogAnimationActive = true;
        }
    }

    // ── Build / teardown ────────────────────────────────────────────────

    function prepareRebuild() {
        disablePS1Wiggle();
        ps1SceneDirty = true;
        refreshToonMeshCache();
        refreshPostPassHideList();
        ensureMainLightSupportsContactShadow();
        cleanupUnsupportedRealtimeResources();
        deactivateInactiveEffects();
    }

    function teardownPipeline() {
        syncSharedSceneEffects(true);
        restoreForcedContactShadowLight();
        clearNodes();
        postProcessing.outputNode = null;
        postProcessing.needsUpdate = true;
    }

    function handleBuildFailure() {
        restoreForcedContactShadowLight();
        deactivateAllEffects();
        clearNodes();
        postProcessing.outputNode = null;
        postProcessing.needsUpdate = true;
    }

    /**
     * Reproduces the old rebuildPipeline() graph construction, data-driven:
     *  1. union pre-pass for descriptors with needs (samples:1 when forced)
     *  2. context-stage descriptors (slot order) build ctx.sceneContext
     *  3. scene pass (scenePass-stage descriptor or default pass) + MRT
     *  4. beauty fold in slot order, env-backdrop compensation spliced
     *     between slots 50 and 60 (early) / before 130 (late fallback)
     *  5. output node with coverage-derived beauty alpha
     *
     * The caller decides teardown-vs-build and owns error escalation; an
     * exception is returned, not thrown.
     */
    function buildPipeline() {
        activePasses.clear();
        ctx.prePass = null;
        ctx.scenePass = null;
        ctx.sceneTex = null;
        ctx.sceneContext = null;
        activeScenePass = null;
        currentBeauty = null;
        currentBeautyAlpha = null;

        try {
            // PS1 vertex snap — coexists with all post-FX, no takeover needed
            syncSharedSceneEffects(true);

            currentDerived = computeDerivedState();

            // ── Path-traced source ──────────────────────────────────────────
            // The spectral PT already produced linear-HDR beauty (with real GI +
            // DOF), so there is no scene pass and no gbuffer. Feed that color in
            // as the beauty and fold ONLY the color-domain effects (bloom/pixel/
            // retro); the gbuffer passes are gated off via isEffectActive. Output
            // (PowerShot film emulation + tone map) is shared with the raster
            // path, so the linear workflow is identical from here down.
            if (ctx.pathTracedColor) {
                const ptColor = texture(ctx.pathTracedColor);
                currentBeauty = vec4(ptColor.rgb, float(1));
                currentBeautyAlpha = float(1);
                for (const d of sorted) {
                    if (d.stage !== 'beauty' || !isEffectActive(d.id)) continue;
                    const next = d.build(ctx);
                    if (next != null) currentBeauty = next;
                }
                postProcessing.outputNode = ctx.withBeautyAlpha(currentBeauty);
                postProcessing.needsUpdate = true;
                return { ok: true, forceEnvironmentBackground: false, builtAgainstEmptyScene: false };
            }

            const active = sorted.filter((d) => isEffectActive(d.id));

            const useSharedPrePass = active.some((d) => Array.isArray(d.needs) && d.needs.length > 0);

            if (useSharedPrePass) {
                // TRAA copies depth — MSAA sample count must be 1 to avoid mismatch
                const forceSamplesOne = active.some((d) => d.forcePrePassSamplesOne);
                const prePass = forceSamplesOne
                    ? pass(scene, getCamera(), { samples: 1 })
                    : pass(scene, getCamera());
                applyNodeResolutionScale(prePass);
                activeNodes.push(prePass);
                prePass.transparent = false;
                prePass.setMRT(mrt({
                    output: packNormalToRGB(normalView),
                    velocity,
                }));

                const prePassDepth = prePass.getTextureNode('depth');
                const prePassNormalColor = prePass.getTextureNode('output');
                const prePassVelocity = prePass.getTextureNode('velocity');
                const prePassNormal = sample((uvNode) => unpackRGBToNormal(prePassNormalColor.sample(uvNode)));

                const normalTexture = prePass.getTexture('output');
                if (normalTexture) normalTexture.type = THREE.UnsignedByteType;

                ctx.prePass = {
                    node: prePass,
                    depth: prePassDepth,
                    normal: prePassNormal,
                    velocity: prePassVelocity,
                };
            }

            // Context stage: contactShadow / gtao contribute to ctx.sceneContext
            for (const d of active) {
                if (d.stage === 'context') d.build(ctx);
            }

            // When HDRI is loaded but not shown as the viewport background, the scene pass still
            // sees environment in reflections; far-depth pixels must be normalized to hidden fill + a=0
            // so SSR and fog (isBg) behave. This was SSR-only before, which broke fog whenever SSR was off.
            const hiddenEnvironmentBackdrop =
                !!scene.environment && !getEnvironmentVisible();
            const useEnvironmentBackdropCompensation =
                hiddenEnvironmentBackdrop
                && (isEffectActive('ssr') || isEffectActive('fog'));
            // Hidden environment/background means transparent scene input.
            // The CSS viewport backdrop may still be visible behind the canvas,
            // but it must never enter Bloom/SSGI/SSR source pixels.
            const backgroundFillNode = vec3(0, 0, 0);
            const backgroundAlphaNode = float(0);

            const ssrReflectivityNode = max(
                metalness,
                roughness.oneMinus().mul(0.35).add(float(0.04))
            ).mul(roughness.smoothstep(0.85, 0.75));

            // Scene pass: a scenePass-stage descriptor (toonOutline) may replace
            // the default pass() — outlines + MRT so beauty effects stack on top.
            const scenePassDescriptor = active.find((d) => d.stage === 'scenePass');
            let scenePass = scenePassDescriptor ? (scenePassDescriptor.build(ctx) || null) : null;
            if (!scenePass) scenePass = pass(scene, getCamera());
            applyNodeResolutionScale(scenePass);
            activeNodes.push(scenePass);
            ctx.scenePass = scenePass;
            activeScenePass = scenePass;
            // Keep the transparent render list enabled regardless of backdrop.
            // PassNode.transparent controls whether transparent objects render,
            // so tying it to the HDRI visibility toggle drops opacity maps.
            scenePass.transparent = true;

            if (ctx.sceneContext) scenePass.contextNode = ctx.sceneContext;

            scenePass.setMRT(mrt({
                output,
                diffuseColor,
                normal: packNormalToRGB(normalView),
                metalrough: vec2(ssrReflectivityNode, roughness),
            }));

            setTexturePrecision(scenePass);

            const scenePassColor = scenePass.getTextureNode('output');
            const scenePassDiffuse = scenePass.getTextureNode('diffuseColor');
            const scenePassDepth = scenePass.getTextureNode('depth');
            const scenePassNormalColor = scenePass.getTextureNode('normal');
            const scenePassMetalRough = scenePass.getTextureNode('metalrough');
            const sceneNormal = sample((uvNode) => unpackRGBToNormal(scenePassNormalColor.sample(uvNode)));

            ctx.sceneTex = {
                color: scenePassColor,
                diffuse: scenePassDiffuse,
                depth: scenePassDepth,
                normalColor: scenePassNormalColor,
                metalrough: scenePassMetalRough,
                normal: sceneNormal,
                reflectivity: scenePassMetalRough.r,
            };

            currentBeauty = scenePassColor;

            // The MRT scene-pass output alpha is unreliable for opaque geometry
            // when there is no background fill (alpha render / transparent
            // export): opaque pixels can read a=0, which then premultiplies the
            // whole matte to transparent black on the canvas. Derive coverage
            // from scene depth (already reliable, drives the env-backdrop
            // compensation below) and keep the higher of the two so glow/bloom
            // can still extend alpha past the geometry. This is a no-op for
            // live/opaque renders, where the background fills depth=far with a=1
            // — there scenePassColor.a is already 1 and dominates the max().
            const geometryCoverageAlpha = scenePassDepth.r.lessThan(float(0.999999)).select(float(1), float(0));
            currentBeautyAlpha = max(scenePassColor.a, geometryCoverageAlpha);

            // SSR needs the HDRI temporarily visible as a background source when
            // the user hides the environment, but downstream effects should see
            // a transparent/hidden backdrop. The early splice (before bloom) lets
            // glow rebuild alpha around geometry instead of being wiped later.
            let environmentBackdropCompensated = false;
            let earlyCompensationDone = false;
            const applyBackdropCompensation = () => {
                const hasGeom = scenePassDepth.r.lessThan(float(0.999999));
                currentBeautyAlpha = hasGeom.select(currentBeautyAlpha, backgroundAlphaNode);
                currentBeauty = vec4(
                    hasGeom.select(currentBeauty.rgb, backgroundFillNode),
                    currentBeautyAlpha
                );
                environmentBackdropCompensated = true;
            };

            for (const d of active) {
                if (d.stage !== 'beauty') continue;
                if (!earlyCompensationDone && (d.slot ?? 0) >= 60) {
                    earlyCompensationDone = true;
                    if (useEnvironmentBackdropCompensation) applyBackdropCompensation();
                }
                // Late fallback preserves older paths where the early
                // compensation could not run — must land before fog (slot 130).
                if ((d.slot ?? 0) >= 130
                    && useEnvironmentBackdropCompensation
                    && !environmentBackdropCompensated) {
                    applyBackdropCompensation();
                }
                const next = d.build(ctx);
                if (next != null) currentBeauty = next;
            }
            if (!earlyCompensationDone
                && useEnvironmentBackdropCompensation
                && !environmentBackdropCompensated) {
                applyBackdropCompensation();
            }

            postProcessing.outputNode = ctx.withBeautyAlpha(currentBeauty);
            postProcessing.needsUpdate = true;

            // Track whether the scene had any renderables at build time. If
            // zero (cold-start with saved post-FX before any scene sync),
            // pass(scene, camera) cached an empty render list and the next
            // markSceneChanged must escalate to a real rebuild.
            let renderableCount = 0;
            scene.traverse((obj) => {
                if (obj?.isMesh || obj?.isSkinnedMesh) renderableCount++;
            });

            return {
                ok: true,
                forceEnvironmentBackground: useEnvironmentBackdropCompensation,
                builtAgainstEmptyScene: renderableCount === 0,
            };
        } catch (error) {
            return { ok: false, error };
        }
    }

    // ── Per-frame ───────────────────────────────────────────────────────

    function updatePerFrame() {
        if (activeScenePass) {
            activeScenePass.transparent = true;
        }
        currentDerived = computeDerivedState();
        for (const d of sorted) {
            if (!isEffectActive(d.id)) continue;
            d.update?.(ctx);
        }
    }

    function updateFrameTimers() {
        // Fog timer for procedural animation (scene.fogNode custom fog)
        if (fogAnimationActive) {
            uniforms.fogTimer.value = performance.now() * 0.001 * (state.fog?.noiseSpeed ?? 0.2);
        }
        // Pixel grain timer
        if (isEffectActive('pixel') && state.pixel.grain) {
            uniforms.pixelTimer.value = performance.now() * 0.001;
        }
    }

    return {
        postProcessing,
        ctx,
        uniforms,
        descriptors: sorted,
        isEffectActive,
        anyEffectActive,
        hasToonMeshes: () => cachedHasToonMeshes,
        computeDerivedState,
        prepareRebuild,
        buildPipeline,
        teardownPipeline,
        handleBuildFailure,
        clearNodes,
        cleanupUnsupportedRealtimeResources,
        updatePerFrame,
        updateFrameTimers,
        applySceneFog,
        isFogAnimationActive: () => fogAnimationActive,
        syncSharedSceneEffects,
        markPS1SceneDirty: () => { ps1SceneDirty = true; },
        refreshSceneCaches() {
            refreshToonMeshCache();
            refreshPostPassHideList();
        },
        ensureMainLightSupportsContactShadow,
        restoreForcedContactShadowLight,
        prepareSceneForPostPass,
        restoreSceneAfterPostPass,
        getCombinedPostFxResolutionScale,
        getScaledPostFxSize,
        applyNodeResolutionScale,
    };
}
