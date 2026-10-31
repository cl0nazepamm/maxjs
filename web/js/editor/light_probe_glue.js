// light_probe_glue.js - editor glue for irradiance probe grids, their GI lightmaps,
// and the ambient SH probe.
//
// Probe grids (light_probes.js) light the scene on every renderer. Their volumes come
// from the Max "Light Probe Grid" helpers, or fit the whole scene when there are none.
// On node renderers each finished bake can also bake GI lightmaps from the grids
// (lightmap_baker.js) for meshes with a Max channel 2 UV set. Until the first grid is
// baked, and whenever probes are disabled, the ambient THREE.LightProbe carries the
// HDRI or sky irradiance as before.
//
// The 'speedball' probe mode replaces the grids with Speedball GI's live traced
// probes (speedball_probes.js, loaded on first use, node renderers only) in the
// same helper volumes, or fitted to the scene. It adds bounce on top of the
// HDRI, so it never owns the HDRI diffuse, and bakes no lightmaps.
import * as THREE from 'three';
import * as THREE_STD from 'three-std';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import {
    autoVolume,
    createLightProbeSystem,
    normalizeLightProbeSettings,
    volumeFromHelper,
} from '../light_probes.js';

const SCENE_REBAKE_DELAY_MS = 350;
const PLAYBACK_RETRY_MS = 500;
const LIGHTMAP_MESHES_PER_FRAME = 4;

function createLightProbeGlue(deps = {}) {
    // Probe grid helpers: handle -> { size: [l, w, h], div: [x, y, z], enabled }.
    // The helper transform rides the normal helper-node sync.
    const probeGridData = new Map();
    let settings = normalizeLightProbeSettings();
    let rebakeTimer = 0;
    let gridActive = false;
    let suspended = false;
    let lightmapBaker = null;
    let lightmapBakerPromise = null;
    let lightmapCount = 0;
    const lightmapsSupported = deps.renderer?.isWebGPURenderer === true;
    let speedball = null;
    let speedballLoading = null;
    let speedballWanted = false;
    let speedballHadData = false;
    // Set when this renderer cannot run Speedball; the grids light the scene instead.
    let speedballFailed = deps.renderer?.isWebGPURenderer !== true;

    const probes = createLightProbeSystem({
        renderer: deps.renderer,
        scene: deps.scene,
        // Grids capture the environment even while the viewport hides it.
        getBakeBackground: () => (deps.scene.background ? null : deps.scene.environment ?? null),
        wrapCapture: deps.wrapCapture,
        onUpdated: () => {
            applyLightProbeState();
            startLightmapBake();
        },
    });

    function loadLightmapBaker() {
        lightmapBakerPromise ??= import('../lightmap_baker.js').then(({ createLightmapBaker }) => {
            lightmapBaker = createLightmapBaker({ renderer: deps.renderer });
            return lightmapBaker;
        });
        return lightmapBakerPromise;
    }

    // Lightmaps follow every probe bake; they are cleared when turned off.
    function startLightmapBake() {
        if (!lightmapsSupported) return;
        if (!settings.lightmaps || !gridActive) {
            lightmapBaker?.cancel();
            if (lightmapCount) {
                deps.setGiLightmaps(new Map());
                lightmapBaker?.dispose();
                lightmapCount = 0;
            }
            return;
        }
        loadLightmapBaker().then((baker) => {
            baker.start(probes.grids, [...deps.nodeMap.values()], { resolution: settings.lightmapResolution });
        }).catch((error) => deps.maxjsDebugWarn('max.js GI lightmaps unavailable:', error));
    }

    function usingSpeedball() {
        return settings.mode === 'speedball' && !speedballFailed;
    }

    // Speedball runs while wanted, pauses when not, and is released when the
    // mode leaves it.
    function syncSpeedball(on) {
        if (!usingSpeedball()) {
            speedballWanted = false;
            speedball?.dispose();
            speedball = null;
            return;
        }
        speedballWanted = on;
        if (speedball) {
            speedball.setEnabled(on);
            return;
        }
        if (!on || speedballLoading) return;
        speedballLoading = import('../speedball_probes.js')
            .then(({ createSpeedballProbes }) => createSpeedballProbes({
                renderer: deps.renderer,
                scene: deps.scene,
                settings: settings.speedball,
            }))
            .then((created) => {
                if (!created) throw new Error('needs WebGPU or WebGL2 with float render targets');
                if (!usingSpeedball()) {
                    created.dispose();
                    return;
                }
                speedball = created;
                speedball.setSettings(settings.speedball);
                speedball.setVolumes(helperVolumes());
                speedball.setEnabled(speedballWanted);
            })
            .catch((error) => {
                deps.maxjsDebugWarn('max.js Speedball GI unavailable:', error);
                speedballFailed = true;
                applyLightProbeState();
                scheduleLightProbeFromCurrentScene({ delay: 0 });
            })
            .finally(() => {
                speedballLoading = null;
                window.__maxjsSyncProbesPanel?.();
            });
    }

    function getSpeedballStatus() {
        if (settings.mode !== 'speedball') return null;
        if (speedballFailed) return 'Speedball needs the WebGPU renderer; using grids';
        if (!speedball) return speedballLoading ? 'Loading Speedball...' : 'Speedball off';
        if (!speedball.enabled) return 'Speedball paused';
        const stats = speedball.getStats();
        return `Speedball: ${stats.probes} probes, ${stats.rays} rays${speedball.hasData() ? '' : ' (tracing...)'}`;
    }

    function updateLightProbes() {
        if (speedball) {
            speedball.update({ camera: deps.camera, playing: deps.maxTimeline?.playing?.() === true });
            const hasData = speedball.hasData();
            if (hasData !== speedballHadData) {
                speedballHadData = hasData;
                window.__maxjsSyncProbesPanel?.();
            }
        }
        probes.update();
        if (!lightmapBaker?.baking) return;
        const done = lightmapBaker.update(LIGHTMAP_MESHES_PER_FRAME);
        if (!done) return;
        lightmapCount = done.size;
        deps.setGiLightmaps(done, settings.intensity);
        window.__maxjsSyncProbesPanel?.();
    }

    function serializeRelayProbeGrids() {
        return {
            type: 'probeGrids',
            grids: Array.from(probeGridData, ([h, data]) => ({
                h,
                enabled: data.enabled ? 1 : 0,
                size: data.size ? [...data.size] : null,
                div: data.div ? [...data.div] : null,
            })),
        };
    }

    function sceneMeshBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        for (const object of deps.nodeMap.values()) {
            if (!object?.visible || !object.isMesh || !object.geometry?.getAttribute?.('position')?.count) continue;
            target.expandByObject(object);
        }
        return target;
    }

    function helperVolumes() {
        const volumes = [];
        for (const [handle, data] of probeGridData) {
            if (!data.enabled || !data.size || !data.div) continue;
            const helper = deps.nodeMap.get(handle);
            if (helper) volumes.push(volumeFromHelper(helper, data.size, data.div));
        }
        return volumes;
    }

    function currentVolumes() {
        const volumes = helperVolumes();
        if (volumes.length) return volumes;
        const bounds = sceneMeshBounds();
        return bounds.isEmpty() ? [] : [autoVolume(bounds, settings.density)];
    }

    // Probe grids own diffuse irradiance while they light the scene: they already
    // captured the environment, so the HDRI's flat diffuse IBL would count twice.
    function isLightProbeGridActive() {
        return gridActive;
    }

    function applyLightProbeState() {
        const enabled = deps.lightProbeEnabled && !deps.isHdriReflectionOnlyEffective() && !suspended;
        // Speedball holds no HDRI light, so reflection-only HDRI keeps it.
        syncSpeedball(deps.lightProbeEnabled && !suspended);
        const grids = enabled && !usingSpeedball();
        probes.setEnabled(grids);
        const nextGridActive = grids && probes.grids.length > 0;
        deps.lightProbe.intensity = enabled && !nextGridActive ? deps.lightProbeIntensity : 0;
        if (nextGridActive !== gridActive) {
            gridActive = nextGridActive;
            deps.onLightProbeGridActiveChanged?.(gridActive);
            startLightmapBake();
        }
    }

    // The NIR band view suspends probe GI: grids, GI lightmaps and Speedball's
    // probes hold visible-band light. The user's toggle is untouched.
    function setLightProbesSuspended(on) {
        const next = on === true;
        if (next === suspended) return;
        suspended = next;
        applyLightProbeState();
    }

    function clearLightProbe() {
        deps.lightProbe.copy(new THREE.LightProbe());
        deps.hasLightProbeData = false;
        applyLightProbeState();
    }

    // Full material recompile. Only for real lighting-topology flips (environment
    // identity, reflection-only), never from a per-sync path.
    function markLightProbeMaterialsDirty() {
        const seen = new WeakSet();
        deps.scene.traverse((object) => {
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
                if (!material || seen.has(material)) continue;
                seen.add(material);
                if (material.isMeshBasicMaterial || material.isLineBasicMaterial || material.isLineDashedMaterial) continue;
                material.needsUpdate = true;
            }
        });
    }

    // Lightmap UVs (Max map channel 2) are outside the host's geometry change
    // hash, so turning lightmaps on or a manual rebake asks for them again.
    function requestLightmapUvs() {
        if (lightmapsSupported && settings.lightmaps) deps.bridge.send?.('sync_lightmap_uvs', { reason: 'gi-lightmaps' });
    }

    // Speedball finds scene edits itself; it re-traces on `retrace` (Rebake).
    function rebakeLightProbes({ refreshLightmapUvs = false, retrace = true } = {}) {
        if (rebakeTimer) {
            clearTimeout(rebakeTimer);
            rebakeTimer = 0;
        }
        if (!deps.lightProbeEnabled) return;
        deps.scene.updateMatrixWorld(true);
        if (usingSpeedball()) {
            speedball?.setVolumes(helperVolumes());
            if (retrace) speedball?.retrace();
            return;
        }
        if (refreshLightmapUvs) requestLightmapUvs();
        if (!probes.setVolumes(currentVolumes())) probes.requestBake();
    }

    // Scene, light and environment edits rebake the grids once the scene rests,
    // and move Speedball's volumes with their helpers.
    function scheduleLightProbeFromCurrentScene({ force = false, delay = SCENE_REBAKE_DELAY_MS } = {}) {
        if (!deps.lightProbeEnabled && !force) return;
        if (rebakeTimer) clearTimeout(rebakeTimer);
        rebakeTimer = setTimeout(function fire() {
            if (deps.maxTimeline?.playing?.() === true) {
                rebakeTimer = setTimeout(fire, PLAYBACK_RETRY_MS);
                return;
            }
            rebakeTimer = 0;
            rebakeLightProbes({ retrace: false });
        }, delay);
    }

    async function updateLightProbeFromHDRI(hdrTex, probeSignature, loadGeneration) {
        scheduleLightProbeFromCurrentScene({ delay: 0 });
        const captureScene = new THREE.Scene();
        captureScene.background = hdrTex;
        captureScene.backgroundRotation.copy(deps.scene.environmentRotation);
        const classic = deps.renderer?.isWebGLRenderer === true;
        const CubeRenderTarget = classic ? THREE_STD.WebGLCubeRenderTarget : THREE.CubeRenderTarget;
        const CubeCamera = classic ? THREE_STD.CubeCamera : THREE.CubeCamera;
        const cubeRenderTarget = new CubeRenderTarget(128, {
            type: hdrTex.type ?? THREE.HalfFloatType,
            colorSpace: hdrTex.colorSpace ?? THREE.LinearSRGBColorSpace,
        });
        try {
            new CubeCamera(0.1, 10, cubeRenderTarget).update(deps.renderer, captureScene);
            const nextProbe = await LightProbeGenerator.fromCubeRenderTarget(deps.renderer, cubeRenderTarget);
            if (loadGeneration !== deps.hdriLoadGeneration || probeSignature !== deps.currentHdriProbeSignature) return;
            deps.lightProbe.copy(nextProbe);
            deps.hasLightProbeData = true;
            applyLightProbeState();
        } catch (error) {
            deps.hasLightProbeData = false;
            deps.maxjsDebugWarn('max.js light probe generation failed:', error);
        } finally {
            cubeRenderTarget.dispose();
        }
    }

    function getLightProbeSettings() {
        return settings;
    }

    function applyLightProbeSettings(next = {}, { persist = false } = {}) {
        const previous = settings;
        settings = probes.setSettings(next);
        if (settings.mode !== previous.mode) {
            applyLightProbeState();
            if (settings.mode === 'grid') scheduleLightProbeFromCurrentScene({ delay: 0 });
        }
        speedball?.setSettings(settings.speedball);
        if (Number(next.density) && probeGridData.size === 0) scheduleLightProbeFromCurrentScene({ delay: 0 });
        if (settings.lightmaps !== previous.lightmaps || settings.lightmapResolution !== previous.lightmapResolution) {
            if (settings.lightmaps && !previous.lightmaps) requestLightmapUvs();
            startLightmapBake();
        } else if (settings.intensity !== previous.intensity && lightmapBaker) {
            deps.setGiLightmaps(new Map([...lightmapBaker.maps].map(([mesh, target]) => [mesh, target.texture])), settings.intensity);
        }
        if (persist) deps.savePostFxState?.();
        deps.relayEmit?.({ type: 'lightProbeSettings', settings });
        return settings;
    }

    // Settings persist with the post FX state; snapshots also carry the volumes.
    // Speedball carries only helper volumes and fits the scene itself without one.
    function serializeSnapshotLightProbes() {
        return {
            settings: { ...settings, showProbes: false },
            volumes: settings.mode === 'speedball' ? helperVolumes() : currentVolumes(),
        };
    }

    deps.bridge.on('probeGrids', (msg) => {
        probeGridData.clear();
        for (const grid of Array.isArray(msg.grids) ? msg.grids : []) {
            if (!grid || !Number.isFinite(grid.h)) continue;
            probeGridData.set(grid.h, {
                size: Array.isArray(grid.size) && grid.size.length === 3 ? grid.size : null,
                div: Array.isArray(grid.div) && grid.div.length === 3 ? grid.div : null,
                enabled: grid.enabled !== 0,
            });
        }
        scheduleLightProbeFromCurrentScene({ delay: 0 });
    });

    window.maxjsLightProbes = {
        rebake: () => rebakeLightProbes({ refreshLightmapUvs: true }),
        get grids() { return probes.grids; },
        get baking() { return probes.baking; },
        get lightmaps() { return lightmapCount; },
        get settings() { return settings; },
        get speedball() { return speedball; },
        setSettings: (next) => applyLightProbeSettings(next, { persist: true }),
    };

    return {
        lightProbes: probes,
        lightmapsSupported,
        getSpeedballStatus,
        getLightmapCount: () => lightmapCount,
        isLightmapBakePending: () => lightmapBaker?.baking === true,
        serializeRelayProbeGrids,
        isLightProbeGridActive,
        applyLightProbeState,
        setLightProbesSuspended,
        clearLightProbe,
        markLightProbeMaterialsDirty,
        rebakeLightProbes,
        scheduleLightProbeFromCurrentScene,
        updateLightProbeFromHDRI,
        getLightProbeSettings,
        applyLightProbeSettings,
        serializeSnapshotLightProbes,
        updateLightProbes,
    };
}

export { createLightProbeGlue };
