// gi_volume_glue.js - HALO-GI, GI volume, and light-probe refresh glue.
import * as THREE from 'three';
import * as THREE_STD from 'three-std';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { createIrradianceVolume, createProbeField as createHaloProbeField } from 'speedball-gi';

function createGiVolumeGlue(deps = {}) {
        // HALO-GI Probe Grid side-channel: handle -> { size:[l,w,h], div:[x,y,z], enabled }.
        // Transform rides the normal helper-node sync; this carries size + manual divisions.
        const probeGridData = new Map();
        let probeVolumeSig = '';
        let probeGridAutoEnabled = false; // auto-turn-on GI once when an enabled grid first appears
        const HALO_GI_DEFAULTS = Object.freeze({
            // Speedball probes exist only in spectral, where they default ON
            // (the DDGI field IS the live view). window.MAXJS_HALO_GI = false
            // force-disables; standard mode never runs them.
            enabled: deps.isStudioMode && window.MAXJS_HALO_GI !== false,
            intensity: 10,
            divisions: 16,
            rays: 64,
            cascades: 1,
            continuous: true,
            hysteresis: 0.9,
            hysteresisNormalize: true,
            normalBias: 1.75,
            radianceClamp: 8,
            depthSharpness: 40,
            cheby: 0.5,
            classify: 0,
            filter: 1,
            smoothness: 1,
            detail: 1,
            changeThreshold: 2.5,
            snapAmount: 0.30,
            fireflyClamp: 6.0,
            roughReflections: false,
            reflectionIntensity: 1.0,
            showProbes: false,
        });
        const HALO_GI_NUMERIC_CONTROLS = Object.freeze([
            { key: 'intensity', label: 'Intensity', min: 0, max: 32, step: 0.05, digits: 1 },
            { key: 'divisions', label: 'Divisions', min: 2, max: 32, step: 1, digits: 0 },
            { key: 'rays', label: 'Rays / Probe', min: 32, max: 256, step: 16, digits: 0 },
            { key: 'hysteresis', label: 'Hysteresis', min: 0.5, max: 0.99, step: 0.01, digits: 2 },
            { key: 'normalBias', label: 'Normal Bias', min: 0, max: 4, step: 0.05, digits: 2 },
            { key: 'radianceClamp', label: 'Radiance Clamp', min: 0, max: 32, step: 0.5, digits: 1 },
            { key: 'depthSharpness', label: 'Depth Sharpness', min: 1, max: 200, step: 1, digits: 0 },
            { key: 'cheby', label: 'Chebyshev', min: 0, max: 1, step: 0.05, digits: 2 },
            { key: 'classify', label: 'Solid Classify', min: 0, max: 1, step: 0.05, digits: 2 },
            { key: 'filter', label: 'Filter', min: 0, max: 1, step: 0.05, digits: 2 },
            { key: 'smoothness', label: 'Smoothness', min: 0, max: 1, step: 0.05, digits: 2 },
            { key: 'detail', label: 'Detail', min: 0, max: 1, step: 0.05, digits: 2 },
            { key: 'reflectionIntensity', label: 'Reflection Intensity', min: 0, max: 1, step: 0.05, digits: 2 },
            { key: 'changeThreshold', label: 'Change Threshold', min: 0.5, max: 8, step: 0.05, digits: 2 },
            { key: 'snapAmount', label: 'Snap Amount', min: 0, max: 0.9, step: 0.01, digits: 2 },
            { key: 'fireflyClamp', label: 'Firefly Clamp', min: 1, max: 20, step: 0.5, digits: 1 },
        ]);
        let haloGiSettings = { ...HALO_GI_DEFAULTS };
        let giVolumeSyncToken = '';
        let giVolumeRefreshTimer = 0;
        let giVolumeFadeFrame = 0;
        let giVolumeFadeSerial = 0;
        let giVolumeDebounceSerial = 0;
        let giVolumeIdleToken = 0;
        let giVolumeIdleSolving = false;
        let giVolumeHiddenForDebounce = false;
        let giVolumePendingRefresh = false;
        let giVolumePendingLightRefresh = false;
        let giVolumeLastCameraSignature = '';
        let giVolumeNativeRequestToken = 0;
        let giVolumeNativeWaitTimer = 0;
        let giVolumeNativeAwaitSurface = false;
        let giVolumeNativeAwaitLights = false;
        const GI_VOLUME_BASE_INTENSITY = 0.38;
        const GI_VOLUME_FADE_OUT_MS = 80;
        const GI_VOLUME_FADE_IN_MS = 180;
        const GI_VOLUME_CAMERA_DEBOUNCE_MS = 240;
        const GI_VOLUME_LIGHT_DEBOUNCE_MS = 260;
        const GI_VOLUME_SCENE_DEBOUNCE_MS = 480;
        const GI_VOLUME_PLAYBACK_DEBOUNCE_MS = 520;
        const GI_VOLUME_NATIVE_WAIT_MS = 160;
        let lightProbeSceneRevision = 0;
        let lightProbeGridActive = null;

        const isAdvancedWebGpuLighting = deps.isStudioMode && deps.renderer.backend?.isWebGPUBackend === true;
        const isWebGpuBackend = deps.renderer.backend?.isWebGPUBackend === true;

        function getHaloGiSettings() {
            return haloGiSettings;
        }

        function clampHaloGiNumber(key, value) {
            const control = HALO_GI_NUMERIC_CONTROLS.find(c => c.key === key);
            if (!control) return Number.isFinite(value) ? value : HALO_GI_DEFAULTS[key];
            const n = Number(value);
            const fallback = HALO_GI_DEFAULTS[key];
            if (!Number.isFinite(n)) return fallback;
            const stepped = control.step >= 1 ? Math.round(n / control.step) * control.step : n;
            return THREE.MathUtils.clamp(stepped, control.min, control.max);
        }
        function formatHaloGiValue(key, value = haloGiSettings[key]) {
            const control = HALO_GI_NUMERIC_CONTROLS.find(c => c.key === key);
            if (!control) return String(value);
            const n = Number(value);
            if (!Number.isFinite(n)) return String(HALO_GI_DEFAULTS[key]);
            return control.digits === 0 ? String(Math.round(n)) : n.toFixed(control.digits);
        }
        function normalizeHaloGiSettings(input = {}, base = HALO_GI_DEFAULTS) {
            const out = { ...base };
            for (const control of HALO_GI_NUMERIC_CONTROLS) {
                if (control.key in input) out[control.key] = clampHaloGiNumber(control.key, input[control.key]);
            }
            if ('enabled' in input) out.enabled = input.enabled === true;
            if ('continuous' in input) out.continuous = input.continuous === true;
            if ('hysteresisNormalize' in input) out.hysteresisNormalize = input.hysteresisNormalize === true;
            if ('roughReflections' in input) out.roughReflections = input.roughReflections === true;
            if ('showProbes' in input) out.showProbes = input.showProbes === true;
            if ('cascades' in input) out.cascades = Math.round(Number(input.cascades)) === 2 ? 2 : 1;
            return out;
        }
        function applyHaloGiTuning(field = deps.haloGi?.field) {
            if (!field) return;
            field.setIntensity?.(haloGiSettings.intensity);
            field.setDivisions?.(haloGiSettings.divisions);
            field.setRays?.(haloGiSettings.rays);
            field.setCascades?.(haloGiSettings.cascades);
            field.setContinuous?.(haloGiSettings.continuous);
            field.setHysteresis?.(haloGiSettings.hysteresis);
            field.setHysteresisNormalization?.(haloGiSettings.hysteresisNormalize);
            field.setNormalBias?.(haloGiSettings.normalBias);
            field.setRadianceClamp?.(haloGiSettings.radianceClamp);
            field.setDepthSharpness?.(haloGiSettings.depthSharpness);
            field.setChebyStrength?.(haloGiSettings.cheby);
            field.setClassifyStrength?.(haloGiSettings.classify);
            field.setFilterStrength?.(haloGiSettings.filter);
            field.setSmoothness?.(haloGiSettings.smoothness);
            field.setDetailStrength?.(haloGiSettings.detail);
            field.setReflectionIntensity?.(haloGiSettings.reflectionIntensity);
            field.setChangeThreshold?.(haloGiSettings.changeThreshold);
            field.setSnapAmount?.(haloGiSettings.snapAmount);
            field.setFireflyClamp?.(haloGiSettings.fireflyClamp);
        }
        function serializeHaloGiState() {
            return {
                ...haloGiSettings,
                volumes: serializeHaloGiProbeVolumes(),
            };
        }
        function applyHaloGiState(input = {}, { persist = false } = {}) {
            const togglesEnabled = Object.prototype.hasOwnProperty.call(input, 'enabled');
            const togglesReflections = Object.prototype.hasOwnProperty.call(input, 'roughReflections')
                && (input.roughReflections === true) !== haloGiSettings.roughReflections;
            const togglesProbes = Object.prototype.hasOwnProperty.call(input, 'showProbes');
            haloGiSettings = normalizeHaloGiSettings(input, haloGiSettings);
            const gi = window.maxjsHaloGI;
            if (togglesReflections && gi?.setRoughReflections) gi.setRoughReflections(haloGiSettings.roughReflections);
            else applyHaloGiTuning();
            if (togglesProbes && haloGiSettings.showProbes !== probeHelpersVisible) setProbeHelpersVisible(haloGiSettings.showProbes);
            if (gi && togglesEnabled) {
                if (haloGiSettings.enabled) gi.enable({ applySettings: false });
                else gi.disable({ applySettings: false });
            }
            window.__maxjsSyncGiPanel?.();
            if (persist) deps.savePostFxState();
        }
        function setHaloGiSetting(key, value, { persist = false } = {}) {
            applyHaloGiState({ [key]: value }, { persist });
        }
        function resetHaloGiToDefaults({ persist = false } = {}) {
            applyHaloGiState({
                ...HALO_GI_DEFAULTS,
                enabled: haloGiSettings.enabled,
                showProbes: haloGiSettings.showProbes,
            }, { persist });
        }

        function shouldAutoStartStudioGiVolume() {
            if (window.MAXJS_STUDIO_GI === true) return true;
            if (deps.pageParams.get('studioGi') === '1' || deps.pageParams.get('studioGI') === '1') return true;
            try {
                return localStorage.getItem('maxjs-studio-gi') === '1'
                    || localStorage.getItem('maxjs-studio-surfel-gi') === '1';
            } catch {
                return false;
            }
        }
        function ensureStudioGiVolume() {
            if (deps.giVolume || !isAdvancedWebGpuLighting) return deps.giVolume;
            try {
                deps.giVolume = createIrradianceVolume({ renderer: deps.renderer, scene: deps.scene, intensity: GI_VOLUME_BASE_INTENSITY });
                deps.renderer.userData = deps.renderer.userData || {};
                deps.renderer.userData.maxjsGI = deps.giVolume;
            } catch (err) {
                deps.maxjsDebugWarn?.('max.js GI volume init failed:', err);
                deps.giVolume = null;
            }
            return deps.giVolume;
        }
        function installStudioGiConsoleHandle() {
            window.maxjsGI = {
                get volume() { return deps.giVolume; },
                get node() { return deps.giVolume?.node ?? null; },
                isSupported: () => ensureStudioGiVolume()?.isSupported?.() === true,
                isEnabled: () => deps.giVolume?.node?._enabled === true,
                enable() {
                    const volume = ensureStudioGiVolume();
                    if (!volume?.isSupported?.()) return false;
                    volume.setEnabled(true);
                    volume.setIntensity(GI_VOLUME_BASE_INTENSITY);
                    scheduleGiVolumeFromCurrentScene({ delay: 0, refresh: true, reason: 'manual-enable' });
                    return true;
                },
                disable() {
                    if (!deps.giVolume) return true;
                    deps.giVolume.setEnabled(false);
                    deps.giVolume.setIntensity(0);
                    syncGiVolumeActive();
                    return true;
                },
                setEnabled(on) { return on ? this.enable() : this.disable(); },
                setIntensity(value) {
                    const volume = ensureStudioGiVolume();
                    volume?.setIntensity?.(value);
                    syncGiVolumeActive();
                },
                bakeAll() {
                    const volume = ensureStudioGiVolume();
                    if (!volume?.isSupported?.()) return false;
                    volume.bakeAll?.();
                    scheduleGiVolumeFromCurrentScene({ delay: 0, refresh: true, reason: 'manual-bake' });
                    return true;
                },
                scheduleBake() {
                    const volume = ensureStudioGiVolume();
                    if (!volume?.isSupported?.()) return false;
                    volume.scheduleBake?.();
                    scheduleGiVolumeFromCurrentScene({ delay: 0, refresh: false, lightRefresh: true, reason: 'manual-light-bake' });
                    return true;
                },
                getStats: () => deps.giVolume?.getStats?.() ?? { active: false, available: false, lazy: true },
            };
        }

        function applyLightProbeState() {
            // Native three.js probes are standard-mode GI only — the spectral
            // stack sources ALL probe GI from speedball (HALO-GI DDGI).
            const probesAllowed = !deps.isStudioMode;
            const hdriDiffuseMuted = deps.isHdriReflectionOnlyEffective();
            const useGrid = probesAllowed && !hdriDiffuseMuted && deps.lightProbeEnabled && deps.hasLightProbeGridData && !!deps.lightProbeGrid;
            deps.lightProbe.intensity = probesAllowed && !hdriDiffuseMuted && deps.lightProbeEnabled && !useGrid ? deps.lightProbeIntensity : 0.0;
            if (deps.lightProbeGrid) deps.lightProbeGrid.visible = useGrid;
            if (lightProbeGridActive !== useGrid) {
                lightProbeGridActive = useGrid;
                markLightProbeMaterialsDirty();
            }
        }

        function clearLightProbe() {
            deps.lightProbe.copy(new THREE.LightProbe());
            deps.hasLightProbeData = false;
            deps.hasLightProbeGridData = false;
            if (deps.lightProbeGrid) {
                if (deps.lightProbeGrid.parent) deps.lightProbeGrid.parent.remove(deps.lightProbeGrid);
                deps.lightProbeGrid.dispose?.();
                deps.lightProbeGrid = null;
            }
            if (deps.giVolume) { deps.giVolume.setEnabled(false); syncGiVolumeActive(); }
            applyLightProbeState();
        }

        function supportsWebGLLightProbeGrid() {
            return !deps.isPathTracingMode
                && typeof LightProbeGrid === 'function'
                && deps.renderer?.isWebGLRenderer === true;
        }

        function computeLightProbeGridBounds(target = new THREE.Box3()) {
            target.makeEmpty();
            for (const mesh of deps.nodeMap.values()) {
                if (!mesh?.visible || !mesh.isMesh || !mesh.geometry) continue;
                const position = mesh.geometry.getAttribute?.('position');
                if (!position || position.count <= 0) continue;
                target.expandByObject(mesh);
            }
            if (target.isEmpty()) {
                target.setFromCenterAndSize(
                    new THREE.Vector3(0, 0, 0),
                    new THREE.Vector3(200, 120, 200)
                );
            } else {
                const size = target.getSize(new THREE.Vector3());
                const pad = Math.max(10, Math.max(size.x, size.y, size.z) * 0.08);
                target.expandByScalar(pad);
            }
            return target;
        }

        function chooseLightProbeGridResolution(size) {
            const maxDim = Math.max(size.x, size.y, size.z, 1);
            const axisCount = (axisSize) => THREE.MathUtils.clamp(Math.round(2 + 3 * axisSize / maxDim), 2, 5);
            return new THREE.Vector3(
                axisCount(size.x),
                axisCount(size.y),
                axisCount(size.z)
            );
        }

        function markLightProbeSceneDirty() {
            lightProbeSceneRevision += 1;
            scheduleGiVolumeFromCurrentScene({
                delay: deps.maxTimeline.playing() ? GI_VOLUME_PLAYBACK_DEBOUNCE_MS : GI_VOLUME_SCENE_DEBOUNCE_MS,
                refresh: true,
                reason: 'scene',
            });
        }

        function markLightProbeLightsDirty() {
            lightProbeSceneRevision += 1;
            scheduleGiVolumeFromCurrentScene({
                delay: deps.maxTimeline.playing() ? GI_VOLUME_PLAYBACK_DEBOUNCE_MS : GI_VOLUME_LIGHT_DEBOUNCE_MS,
                refresh: false,
                lightRefresh: true,
                reason: 'lights',
            });
        }

        function markLightProbeMaterialsDirty() {
            const seen = new WeakSet();
            const markMaterial = (material) => {
                if (!material || seen.has(material)) return;
                seen.add(material);
                if (material.isMeshBasicMaterial || material.isLineBasicMaterial || material.isLineDashedMaterial) return;
                if (material.visible === false) return;
                material.needsUpdate = true;
            };
            deps.scene.traverse((object) => {
                if (!object?.material) return;
                if (Array.isArray(object.material)) {
                    for (const material of object.material) markMaterial(material);
                } else {
                    markMaterial(object.material);
                }
            });
        }

        function currentLightProbeSceneSignature() {
            const bounds = computeLightProbeGridBounds(new THREE.Box3());
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const quantize = (value) => Math.round(Number(value || 0) * 1000) / 1000;
            let bakeSignature = '';
            try {
                bakeSignature = deps.bakeStateSignature();
            } catch {}
            return JSON.stringify([
                'scene-grid',
                deps.currentHdriUrl || null,
                deps.isLocalHdriActive(),
                !!deps.scene.environment,
                deps.defaultLights.visible,
                deps.lastLightsSignature,
                bakeSignature,
                deps.nodeMap.size,
                lightProbeSceneRevision,
                center.toArray().map(quantize),
                size.toArray().map(quantize),
            ]);
        }

        async function updateLightProbeGridFromScene(hdrTex, probeSignature, loadGeneration) {
            if (!supportsWebGLLightProbeGrid()) return false;

            const bounds = computeLightProbeGridBounds(new THREE.Box3());
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const resolution = chooseLightProbeGridResolution(size);
            const nextGrid = new LightProbeGrid(
                Math.max(size.x, 1),
                Math.max(size.y, 1),
                Math.max(size.z, 1),
                resolution.x,
                resolution.y,
                resolution.z
            );
            nextGrid.name = '__maxjs_light_probe_grid__';
            nextGrid.position.copy(center);
            nextGrid.userData.maxjsExcludeFromRuntimeSnapshot = true;
            nextGrid.userData.volumetricBoundsBypass = true;

            const previousGrid = deps.lightProbeGrid;
            if (previousGrid?.parent) previousGrid.parent.remove(previousGrid);

            const savedProbeIntensity = deps.lightProbe.intensity;
            const savedBackground = deps.scene.background;
            const savedBackgroundRotation = deps.scene.backgroundRotation.clone();
            deps.lightProbe.intensity = 0.0;
            if (hdrTex) deps.scene.background = hdrTex;

            try {
                deps.scene.updateMatrixWorld(true);
                const maxDim = Math.max(size.x, size.y, size.z, 1);
                nextGrid.bake(deps.renderer, deps.scene, {
                    cubemapSize: 16,
                    near: 0.1,
                    far: Math.max(1000, maxDim * 4),
                });

                if (loadGeneration !== deps.hdriLoadGeneration || probeSignature !== deps.currentHdriProbeSignature) {
                    nextGrid.dispose?.();
                    if (previousGrid) deps.scene.add(previousGrid);
                    return true;
                }

                if (previousGrid) previousGrid.dispose?.();
                deps.lightProbeGrid = nextGrid;
                deps.hasLightProbeGridData = true;
                deps.hasLightProbeData = true;
                deps.scene.add(deps.lightProbeGrid);
                applyLightProbeState();
                return true;
            } catch (error) {
                nextGrid.dispose?.();
                if (previousGrid) {
                    deps.scene.add(previousGrid);
                    deps.lightProbeGrid = previousGrid;
                    deps.hasLightProbeGridData = true;
                    applyLightProbeState();
                    deps.maxjsDebugWarn('max.js WebGL light probe grid bake failed; keeping previous grid:', error);
                    return true;
                }
                deps.hasLightProbeGridData = false;
                deps.maxjsDebugWarn('max.js WebGL light probe grid bake failed:', error);
                return false;
            } finally {
                deps.scene.background = savedBackground;
                deps.scene.backgroundRotation.copy(savedBackgroundRotation);
                if (!deps.hasLightProbeGridData) deps.lightProbe.intensity = savedProbeIntensity;
            }
        }

        function giVolumeNowMs() {
            return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        }

        function giVolumeEase(t) {
            const x = THREE.MathUtils.clamp(t, 0, 1);
            return x * x * (3 - 2 * x);
        }

        function fadeGiVolumeTo(targetIntensity, durationMs, onComplete) {
            if (!deps.giVolume) return;
            const startIntensity = Math.max(0, Number(deps.giVolume.node?.intensity) || 0);
            const endIntensity = Math.max(0, Number(targetIntensity) || 0);
            giVolumeFadeSerial += 1;
            const serial = giVolumeFadeSerial;
            if (giVolumeFadeFrame) cancelAnimationFrame(giVolumeFadeFrame);
            giVolumeFadeFrame = 0;

            if (!(durationMs > 0) || Math.abs(startIntensity - endIntensity) < 1e-4) {
                deps.giVolume.setIntensity(endIntensity);
                syncGiVolumeActive();
                onComplete?.();
                return;
            }

            const startedAt = giVolumeNowMs();
            const step = () => {
                if (serial !== giVolumeFadeSerial) return;
                const t = giVolumeEase((giVolumeNowMs() - startedAt) / durationMs);
                deps.giVolume.setIntensity(THREE.MathUtils.lerp(startIntensity, endIntensity, t));
                syncGiVolumeActive();
                if (t < 1) {
                    giVolumeFadeFrame = requestAnimationFrame(step);
                } else {
                    giVolumeFadeFrame = 0;
                    onComplete?.();
                }
            };
            step();
        }

        function hideGiVolumeForDebounce() {
            if (!deps.giVolume || !deps.giVolume.isSupported?.()) return;
            giVolumeHiddenForDebounce = true;
            if (deps.giVolume.hasData?.()) {
                if (giVolumeFadeFrame) cancelAnimationFrame(giVolumeFadeFrame);
                giVolumeFadeFrame = 0;
                giVolumeFadeSerial += 1;
                deps.giVolume.setEnabled(true);
                deps.giVolume.setIntensity(GI_VOLUME_BASE_INTENSITY);
                deps.lightProbe.intensity = 0;
                deps.hasLightProbeData = true;
                syncGiVolumeActive();
            } else if ((Number(deps.giVolume.node?.intensity) || 0) > 1e-4) {
                fadeGiVolumeTo(0, GI_VOLUME_FADE_OUT_MS);
            } else {
                deps.giVolume.setIntensity(0);
                syncGiVolumeActive();
            }
        }

        function revealGiVolumeAfterDebounce(token) {
            if (!deps.giVolume || !deps.giVolume.isSupported?.() || deps.isPathTracingMode) return;
            if (token != null && token !== giVolumeDebounceSerial) return;
            if (deps.maxTimeline.playing()) {
                scheduleGiVolumeFromCurrentScene({
                    delay: GI_VOLUME_PLAYBACK_DEBOUNCE_MS,
                    refresh: giVolumePendingRefresh,
                    lightRefresh: true,
                    reason: 'playback',
                });
                return;
            }
            if (!deps.giVolume.hasData?.()) return;
            giVolumeIdleSolving = false;
            giVolumeHiddenForDebounce = false;
            deps.giVolume.setEnabled(true);
            deps.lightProbe.intensity = 0;
            deps.hasLightProbeData = true;
            fadeGiVolumeTo(GI_VOLUME_BASE_INTENSITY, GI_VOLUME_FADE_IN_MS);
        }

        function startGiVolumeHiddenSolve(token, { refresh = false, lightRefresh = false } = {}) {
            if (!deps.giVolume || !deps.giVolume.isSupported?.() || deps.isPathTracingMode) return;
            if (token !== giVolumeDebounceSerial) return;
            if (deps.maxTimeline.playing()) {
                scheduleGiVolumeFromCurrentScene({
                    delay: GI_VOLUME_PLAYBACK_DEBOUNCE_MS,
                    refresh,
                    lightRefresh: true,
                    reason: 'playback',
                });
                return;
            }

            giVolumeIdleToken = token;
            const hasHistory = deps.giVolume.hasData?.() === true;
            deps.giVolume.setEnabled(true);
            deps.giVolume.setIntensity(hasHistory ? GI_VOLUME_BASE_INTENSITY : 0);
            deps.lightProbe.intensity = 0;
            deps.hasLightProbeData = true;
            syncGiVolumeActive();

            let queued = true;
            if (refresh) {
                queued = updateGiVolumeFromScene({ hidden: true });
            } else if (lightRefresh) {
                deps.giVolume.requestLightRefresh?.();
            }

            if (!queued) return;
            giVolumeIdleSolving = deps.giVolume.hasPendingWork?.() === true;
            if (!giVolumeIdleSolving) revealGiVolumeAfterDebounce(token);
        }

        function clearGiVolumeNativeWait() {
            if (giVolumeNativeWaitTimer) clearTimeout(giVolumeNativeWaitTimer);
            giVolumeNativeWaitTimer = 0;
            giVolumeNativeRequestToken = 0;
            giVolumeNativeAwaitSurface = false;
            giVolumeNativeAwaitLights = false;
        }

        function maybeStartGiVolumeAfterNativePacket(token) {
            if (token !== giVolumeDebounceSerial || token !== giVolumeNativeRequestToken) return;
            if (giVolumeNativeAwaitSurface || giVolumeNativeAwaitLights) return;
            clearGiVolumeNativeWait();
            startGiVolumeHiddenSolve(token, { refresh: false, lightRefresh: false });
        }

        function requestNativeGiPackets(token, { refresh = false, lightRefresh = false } = {}) {
            if (!window.chrome?.webview || !deps.bridge?.send) return false;
            const needSurface = refresh === true || !deps.giVolume?.hasData?.();
            const needLights = needSurface || lightRefresh === true;
            if (!needSurface && !needLights) return false;

            clearGiVolumeNativeWait();
            giVolumeNativeRequestToken = token;
            giVolumeNativeAwaitSurface = needSurface;
            giVolumeNativeAwaitLights = needLights;
            deps.bridge.send('gi_probe_refresh', { surface: needSurface, lights: needLights });

            giVolumeNativeWaitTimer = setTimeout(() => {
                if (token !== giVolumeDebounceSerial || token !== giVolumeNativeRequestToken) return;
                const fallbackRefresh = giVolumeNativeAwaitSurface;
                const fallbackLightRefresh = giVolumeNativeAwaitLights;
                clearGiVolumeNativeWait();
                startGiVolumeHiddenSolve(token, {
                    refresh: fallbackRefresh,
                    lightRefresh: fallbackLightRefresh,
                });
            }, GI_VOLUME_NATIVE_WAIT_MS);
            return true;
        }

        function runGiVolumeAfterDebounce(token) {
            giVolumeRefreshTimer = 0;
            if (!deps.giVolume || !deps.giVolume.isSupported?.() || deps.isPathTracingMode) return;
            if (token !== giVolumeDebounceSerial) return;
            if (deps.maxTimeline.playing()) {
                scheduleGiVolumeFromCurrentScene({
                    delay: GI_VOLUME_PLAYBACK_DEBOUNCE_MS,
                    refresh: giVolumePendingRefresh,
                    lightRefresh: true,
                    reason: 'playback',
                });
                return;
            }

            const refresh = giVolumePendingRefresh || !deps.giVolume.hasData?.();
            const lightRefresh = giVolumePendingLightRefresh;
            giVolumePendingRefresh = false;
            giVolumePendingLightRefresh = false;
            if (requestNativeGiPackets(token, { refresh, lightRefresh })) return;
            startGiVolumeHiddenSolve(token, { refresh, lightRefresh });
        }

        // Recompile materials once when the GI volume's active state flips, so
        // MaxLightsNode's customCacheKey picks up (or drops) the GiVolumeNode.
        // Data-only surfel-buffer writes during compute do NOT pass through here.
        function syncGiVolumeActive() {
            // Recompile on active flip OR grid resize (cacheToken carries a
            // generation that bumps when the GPU surfel/grid buffers are rebuilt).
            const token = deps.giVolume && deps.giVolume.node.active
                ? `on:${deps.giVolume.node.cacheToken}`
                : 'off';
            if (token !== giVolumeSyncToken) {
                giVolumeSyncToken = token;
                markLightProbeMaterialsDirty();
            }
        }

        // WebGPU compute local-bounce surfel path. Sizes the box from the scene
        // bounds, enables the volume, mutes the single ambient lightProbe to
        // avoid double counting, and schedules a GPU probe solve.
        function updateGiVolumeFromScene({ hidden = false } = {}) {
            if (!deps.giVolume || !deps.giVolume.isSupported() || deps.isPathTracingMode) {
                if (deps.giVolume) { deps.giVolume.setEnabled(false); syncGiVolumeActive(); }
                return false;
            }
            if (deps.maxTimeline.playing()) {
                scheduleGiVolumeFromCurrentScene({
                    delay: GI_VOLUME_PLAYBACK_DEBOUNCE_MS,
                    refresh: true,
                    reason: 'playback',
                });
                return true;
            }
            deps.scene.updateMatrixWorld(true);
            const bounds = computeLightProbeGridBounds(new THREE.Box3());
            const hasHistory = deps.giVolume.hasData?.() === true;
            if (!deps.giVolume.setBounds(bounds)) return false;
            deps.giVolume.setEnabled(true);
            deps.giVolume.setIntensity(hidden && !hasHistory ? 0 : GI_VOLUME_BASE_INTENSITY);
            deps.lightProbe.intensity = 0; // volume owns indirect diffuse — no double count
            deps.hasLightProbeData = true;
            syncGiVolumeActive();
            deps.giVolume.scheduleBake();
            return true;
        }

        function scheduleGiVolumeFromCurrentScene({
            delay = GI_VOLUME_SCENE_DEBOUNCE_MS,
            refresh = true,
            lightRefresh = false,
            reason = 'scene',
        } = {}) {
            if (!deps.giVolume || !deps.giVolume.isSupported() || deps.isPathTracingMode) return;
            giVolumePendingRefresh = giVolumePendingRefresh || refresh === true;
            giVolumePendingLightRefresh = giVolumePendingLightRefresh || lightRefresh === true;
            giVolumeDebounceSerial += 1;
            const token = giVolumeDebounceSerial;
            giVolumeIdleSolving = false;
            hideGiVolumeForDebounce();
            if (giVolumeRefreshTimer) clearTimeout(giVolumeRefreshTimer);
            giVolumeRefreshTimer = setTimeout(() => {
                runGiVolumeAfterDebounce(token);
            }, delay);
        }

        function updateGiVolumeIdleWork() {
            if (!deps.giVolume || !deps.giVolume.isSupported?.() || deps.isPathTracingMode || deps.renderToImageActive) return;
            if (deps.maxTimeline.playing()) {
                if (deps.giVolume.node?.active || giVolumeIdleSolving || deps.giVolume.hasPendingWork?.()) {
                    scheduleGiVolumeFromCurrentScene({
                        delay: GI_VOLUME_PLAYBACK_DEBOUNCE_MS,
                        refresh: false,
                        lightRefresh: true,
                        reason: 'playback',
                    });
                }
                return;
            }
            if (giVolumeRefreshTimer) return;
            if (!giVolumeIdleSolving && !deps.giVolume.hasPendingWork?.()) return;
            const token = giVolumeIdleToken || giVolumeDebounceSerial;
            const compute = deps.giVolume.tick({ playback: false });
            if (compute && typeof compute.finally === 'function') {
                compute.finally(() => {
                    if (giVolumeIdleSolving
                        && token === giVolumeDebounceSerial
                        && !deps.giVolume.hasPendingWork?.()
                        && !deps.maxTimeline.playing()) {
                        revealGiVolumeAfterDebounce(token);
                    }
                });
            } else if (!deps.giVolume.hasPendingWork?.()) {
                revealGiVolumeAfterDebounce(token);
            }
        }

        function giVolumeCameraSignature(cam) {
            const q = (v) => Math.round((Number(v) || 0) * 1000);
            const a = Array.isArray(cam?.pos) ? cam.pos : [];
            const b = Array.isArray(cam?.tgt) ? cam.tgt : [];
            const u = Array.isArray(cam?.up) ? cam.up : [];
            return [
                cam?.persp === false ? 0 : 1,
                q(cam?.fov),
                q(cam?.viewWidth),
                q(a[0]), q(a[1]), q(a[2]),
                q(b[0]), q(b[1]), q(b[2]),
                q(u[0]), q(u[1]), q(u[2]),
            ].join(':');
        }

        function noteGiVolumeCameraSync(cam) {
            if (!deps.giVolume || !deps.giVolume.isSupported?.() || !deps.giVolume.hasData?.()) return;
            const signature = giVolumeCameraSignature(cam);
            if (!signature || signature === giVolumeLastCameraSignature) return;
            giVolumeLastCameraSignature = signature;
            scheduleGiVolumeFromCurrentScene({
                delay: GI_VOLUME_CAMERA_DEBOUNCE_MS,
                refresh: false,
                reason: 'camera',
            });
        }

        async function updateLightProbeFromCurrentScene({ force = false } = {}) {
            if (!deps.lightProbeEnabled && !force) {
                if (deps.giVolume) { deps.giVolume.setEnabled(false); syncGiVolumeActive(); }
                return;
            }
            if (!supportsWebGLLightProbeGrid()) {
                if (deps.giVolume?.isSupported?.() && !deps.isPathTracingMode) {
                    scheduleGiVolumeFromCurrentScene({ delay: 0, refresh: true, reason: 'probe' });
                    return;
                }
                if (deps.refreshSkyAmbientLightProbeFromCurrentSky()) return;
                if (!deps.currentHdriUrl) clearLightProbe();
                return;
            }

            deps.scene.updateMatrixWorld(true);
            const probeSignature = currentLightProbeSceneSignature();
            if (!force && deps.hasLightProbeGridData && probeSignature === deps.currentHdriProbeSignature) return;

            deps.currentHdriProbeSignature = probeSignature;
            deps.hdriLoadGeneration = deps.hdriLoadGeneration + 1;
            await updateLightProbeGridFromScene(null, probeSignature, deps.hdriLoadGeneration);
        }

        function scheduleLightProbeFromCurrentScene({ force = false, delay = 180 } = {}) {
            if (!deps.lightProbeEnabled && !force) return;
            if (deps.giVolume?.isSupported?.() && !supportsWebGLLightProbeGrid() && !deps.isPathTracingMode) {
                scheduleGiVolumeFromCurrentScene({ delay, refresh: true, reason: 'light-probe' });
                return;
            }
            if (deps.lightProbeRefreshTimer) clearTimeout(deps.lightProbeRefreshTimer);
            deps.lightProbeRefreshTimer = setTimeout(() => {
                deps.lightProbeRefreshTimer = 0;
                void updateLightProbeFromCurrentScene({ force });
            }, delay);
        }

        async function updateLightProbeFromHDRI(hdrTex, probeSignature, loadGeneration) {
            if (deps.isPathTracingMode) {
                clearLightProbe();
                return;
            }

            if (await updateLightProbeGridFromScene(hdrTex, probeSignature, loadGeneration)) {
                return;
            }

            const captureScene = new THREE.Scene();
            captureScene.background = hdrTex;
            captureScene.backgroundRotation.copy(deps.scene.environmentRotation);

            const CubeRenderTargetCtor =
                typeof THREE.WebGLCubeRenderTarget === 'function'
                    ? THREE.WebGLCubeRenderTarget
                    : THREE_STD.WebGLCubeRenderTarget;
            const CubeCameraCtor =
                typeof THREE.CubeCamera === 'function'
                    ? THREE.CubeCamera
                    : THREE_STD.CubeCamera;

            if (typeof CubeRenderTargetCtor !== 'function' || typeof CubeCameraCtor !== 'function') {
                deps.hasLightProbeData = false;
                deps.maxjsDebugWarn('max.js light probe generation unavailable: missing cube capture constructors');
                return;
            }

            const cubeRenderTarget = new CubeRenderTargetCtor(128, {
                type: hdrTex.type ?? THREE.HalfFloatType,
                colorSpace: hdrTex.colorSpace ?? THREE.LinearSRGBColorSpace,
            });
            const cubeCamera = new CubeCameraCtor(0.1, 10, cubeRenderTarget);

            try {
                cubeCamera.update(deps.renderer, captureScene);
                const nextProbe = await LightProbeGenerator.fromCubeRenderTarget(deps.renderer, cubeRenderTarget);

                if (loadGeneration !== deps.hdriLoadGeneration || probeSignature !== deps.currentHdriProbeSignature) {
                    return;
                }

                deps.lightProbe.copy(nextProbe);
                deps.hasLightProbeData = true;
                deps.hasLightProbeGridData = false;
                applyLightProbeState();
            } catch (error) {
                deps.hasLightProbeData = false;
                deps.maxjsDebugWarn('max.js light probe generation failed:', error);
            } finally {
                cubeRenderTarget.dispose();
            }
        }

        // Fit the HALO-GI probe volume(s) to the synced probe-grid helper(s): each box's
        // world AABB (from the helper node's transform x its size) + manual divisions.
        // No enabled grids -> whole-scene auto-fit. Change-gated.
        const _pgBox = new THREE.Box3();
        const _pgVec = new THREE.Vector3();
        function buildHaloProbeVolumes() {
            const volumes = [];
            for (const [h, data] of probeGridData) {
                if (!data || data.enabled === false || !Array.isArray(data.size)) continue;
                const obj = deps.nodeMap.get(h);
                if (!obj) continue;
                obj.updateWorldMatrix(true, false);
                const size = data.size;
                const hx = size[0] * 0.5, hy = size[1] * 0.5, hz = size[2] * 0.5;
                const box = new THREE.Box3();
                for (let cx = -1; cx <= 1; cx += 2) for (let cy = -1; cy <= 1; cy += 2) for (let cz = -1; cz <= 1; cz += 2) {
                    _pgVec.set(cx * hx, cy * hy, cz * hz).applyMatrix4(obj.matrixWorld);
                    box.expandByPoint(_pgVec);
                }
                const div = data.div;
                const res = (Array.isArray(div) && div.length === 3) ? { x: div[0], y: div[1], z: div[2] } : null;
                volumes.push(res ? { box, res } : box);
            }
            return volumes;
        }
        function serializeHaloGiProbeVolumes() {
            return buildHaloProbeVolumes().map((entry) => {
                const box = entry.isBox3 ? entry : entry.box;
                const res = entry.isBox3 ? null : entry.res;
                if (!box || !box.isBox3 || box.isEmpty()) return null;
                const out = {
                    min: [box.min.x, box.min.y, box.min.z],
                    max: [box.max.x, box.max.y, box.max.z],
                };
                if (res) out.res = [res.x, res.y, res.z];
                return out;
            }).filter(Boolean);
        }
        function syncHaloProbeVolumes() {
            const gi = window.maxjsHaloGI;
            if (!gi || typeof gi.setVolumes !== 'function') return;
            const volumes = buildHaloProbeVolumes();
            let sig = '';
            for (const entry of volumes) {
                const box = entry.isBox3 ? entry : entry.box;
                const res = entry.isBox3 ? null : entry.res;
                if (!box || box.isEmpty()) continue;
                const size = _pgVec.subVectors(box.max, box.min);
                sig += `${box.min.x.toFixed(3)},${box.min.y.toFixed(3)},${box.min.z.toFixed(3)}|`
                    + `${size.x.toFixed(3)},${size.y.toFixed(3)},${size.z.toFixed(3)}|`
                    + `${res ? `${res.x},${res.y},${res.z}` : 'a'};`;
            }
            if (sig === probeVolumeSig) return;
            probeVolumeSig = sig;
            if (volumes.length === 0) gi.setBounds?.(null); // no grids -> whole-scene auto-fit
            else gi.setVolumes(volumes);
        }

        // ── Diagnostics: draw the HALO-GI probe field as a grid of small spheres. ──
        let probeHelperMesh = null;
        let probeHelpersVisible = false;
        let probeHelperSig = '';
        const _probeHelperMat = new THREE.Matrix4();
        function disposeProbeHelpers() {
            if (probeHelperMesh) {
                probeHelperMesh.parent?.remove(probeHelperMesh);
                probeHelperMesh.geometry?.dispose?.();
                probeHelperMesh.material?.dispose?.();
                probeHelperMesh = null;
            }
            probeHelperSig = '';
        }
        function updateProbeHelpers() {
            if (!probeHelpersVisible) return;
            const gi = window.maxjsHaloGI;
            const field = gi?.field;
            if (!field || typeof field.getResolution !== 'function' || gi.hasData?.() === false) {
                if (probeHelperMesh) probeHelperMesh.visible = false;
                return;
            }
            const res = field.getResolution();
            const bounds = field.getBounds?.();
            if (!res || !bounds) { if (probeHelperMesh) probeHelperMesh.visible = false; return; }
            const rx = Math.max(1, Math.round(res.x)), ry = Math.max(1, Math.round(res.y)), rz = Math.max(1, Math.round(res.z));
            const total = rx * ry * rz;
            const min = bounds.min;
            const size = _pgVec.subVectors(bounds.max, bounds.min);
            const sx = size.x, sy = size.y, sz = size.z;
            const sig = `${rx},${ry},${rz}|${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}|${sx.toFixed(2)},${sy.toFixed(2)},${sz.toFixed(2)}`;
            if (sig === probeHelperSig && probeHelperMesh) { probeHelperMesh.visible = true; return; }
            probeHelperSig = sig;
            if (!probeHelperMesh || probeHelperMesh.count !== total) {
                disposeProbeHelpers();
                probeHelperSig = sig;
                const r = Math.max(sx / Math.max(1, rx - 1), sy / Math.max(1, ry - 1), sz / Math.max(1, rz - 1)) * 0.08 + 1e-3;
                const geo = new THREE.SphereGeometry(r, 8, 6);
                const mat = new THREE.MeshBasicMaterial({ color: 0x33ddff, depthWrite: false, transparent: true, opacity: 0.85, toneMapped: false });
                probeHelperMesh = new THREE.InstancedMesh(geo, mat, total);
                probeHelperMesh.frustumCulled = false;
                probeHelperMesh.renderOrder = 9999;
                probeHelperMesh.userData.maxjsExcludeFromRuntimeSnapshot = true;
                deps.scene.add(probeHelperMesh);
            }
            let idx = 0;
            for (let k = 0; k < rz; k++) for (let j = 0; j < ry; j++) for (let i = 0; i < rx; i++) {
                const fx = rx > 1 ? i / (rx - 1) : 0, fy = ry > 1 ? j / (ry - 1) : 0, fz = rz > 1 ? k / (rz - 1) : 0;
                _probeHelperMat.makeTranslation(min.x + fx * sx, min.y + fy * sy, min.z + fz * sz);
                probeHelperMesh.setMatrixAt(idx++, _probeHelperMat);
            }
            probeHelperMesh.instanceMatrix.needsUpdate = true;
            probeHelperMesh.visible = true;
        }
        function setProbeHelpersVisible(v) {
            probeHelpersVisible = !!v;
            haloGiSettings.showProbes = probeHelpersVisible;
            if (!probeHelpersVisible) { if (probeHelperMesh) probeHelperMesh.visible = false; }
            else updateProbeHelpers();
            const cb = document.getElementById('fx-gi-show-probes');
            if (cb && cb.checked !== probeHelpersVisible) cb.checked = probeHelpersVisible;
            window.__maxjsSyncGiPanel?.();
        }

        if (isAdvancedWebGpuLighting) {
            installStudioGiConsoleHandle();
            if (shouldAutoStartStudioGiVolume()) {
                window.maxjsGI.enable();
            }
        }

        // HALO-GI: BVH-traced DDGI probe field (docs/GI_HALO_design.md) — the
        // speedball probes. SPECTRAL-ONLY: standard mode is vanilla three.js
        // (native LightProbe / LightProbeGrid GI) and must never run speedball.
        // In spectral the field is constructed up front and ON by default — it
        // IS the live view, and because it shares the BVH/traversal core with
        // the path tracer (spectral_traverse.js) the PT ⇄ DDGI switch is
        // instant. window.MAXJS_HALO_GI = false force-disables. When enabled it
        // mutes the surfel giVolume to avoid double-counting and ticks every
        // frame — the field self-gates on idle and auto-throttles its own ray
        // budget. The probe node only injects into context.irradiance while
        // active, so a disabled field changes nothing.
        if (isWebGpuBackend && deps.isStudioMode) {
            try {
                let haloOn = haloGiSettings.enabled === true;
                let haloField = null;
                const createConfiguredHaloField = () => createHaloProbeField({
                    renderer: deps.renderer,
                    scene: deps.scene,
                    intensity: haloGiSettings.intensity,
                    hysteresis: haloGiSettings.hysteresis,
                    divisions: haloGiSettings.divisions,
                    roughReflections: haloGiSettings.roughReflections,
                    reflectionIntensity: haloGiSettings.reflectionIntensity,
                    onRebuilt: markLightProbeMaterialsDirty,
                });
                const replaceHaloField = () => {
                    const previousField = haloField;
                    previousField?.setEnabled?.(false);
                    previousField?.dispose?.();
                    haloField = createConfiguredHaloField();
                    applyHaloGiTuning(haloField);
                    // The reflection feature is structural in Speedball: recreation
                    // is deliberate. Off has no glossy buffers/kernels; On allocates
                    // and runs them, making the performance comparison truthful.
                    probeVolumeSig = '\0';
                    syncHaloProbeVolumes();
                    if (haloOn) {
                        haloField.setEnabled(true);
                        haloField.requestRebuild();
                    }
                    markLightProbeMaterialsDirty();
                    updateProbeHelpers();
                    return haloField;
                };
                haloField = createConfiguredHaloField();
                applyHaloGiTuning(haloField);
                deps.haloGi = {
                    get field() { return haloField; },
                    isOn: () => haloOn && haloField?.isSupported?.() === true,
                    enable({ applySettings = true } = {}) {
                        if (!haloField?.isSupported?.()) { console.warn('HALO-GI needs the WebGPU backend'); return false; }
                        haloOn = true;
                        haloGiSettings.enabled = true;
                        if (deps.giVolume) { deps.giVolume.setEnabled(false); deps.giVolume.setIntensity(0); }
                        if (applySettings) applyHaloGiTuning(haloField);
                        haloField.setEnabled(true);
                        haloField.requestRebuild();
                        // The fold-in recompile is forced by the field's onRebuilt hook
                        // (markLightProbeMaterialsDirty) the moment the first rebuild
                        // produces probe data — same frame the data exists, not a rebuild
                        // late. Fires once per rebuild (debounced), never per tick.
                        window.__maxjsSyncGiPanel?.(); // mirror On state in the FX panel (incl. auto-enable on reload)
                        return true;
                    },
                    disable({ applySettings = true } = {}) {
                        haloOn = false;
                        haloGiSettings.enabled = false;
                        if (applySettings) applyHaloGiTuning(haloField);
                        haloField.setEnabled(false);
                        markLightProbeMaterialsDirty(); // one-shot: drop the probe node from the lights graph this frame
                        window.__maxjsSyncGiPanel?.();
                    },
                    setRoughReflections(enabled) {
                        const next = enabled === true;
                        const current = haloField?.hasRoughReflections?.() === true;
                        haloGiSettings.roughReflections = next;
                        if (next === current) return false;
                        replaceHaloField();
                        window.__maxjsSyncGiPanel?.();
                        return true;
                    },
                    hasRoughReflections: () => haloField?.hasRoughReflections?.() === true,
                    setReflectionIntensity: (v) => setHaloGiSetting('reflectionIntensity', v),
                    setIntensity: (v) => setHaloGiSetting('intensity', v),
                    setDivisions: (v) => setHaloGiSetting('divisions', v),
                    setRays: (v) => setHaloGiSetting('rays', v),
                    setCascades: (v) => setHaloGiSetting('cascades', v),
                    setContinuous: (v) => setHaloGiSetting('continuous', v),
                    setHysteresis: (v) => setHaloGiSetting('hysteresis', v),
                    setHysteresisNormalize: (v) => setHaloGiSetting('hysteresisNormalize', v),
                    setNormalBias: (v) => setHaloGiSetting('normalBias', v),
                    setRadianceClamp: (v) => setHaloGiSetting('radianceClamp', v),
                    setDepthSharpness: (v) => setHaloGiSetting('depthSharpness', v),
                    setCheby: (v) => setHaloGiSetting('cheby', v), // 0 leaks, 1 leak-free
                    setChebyStrength: (v) => setHaloGiSetting('cheby', v),
                    setClassify: (v) => setHaloGiSetting('classify', v), // 0 off (default), 1 drop buried probes (solid scenes)
                    setClassifyStrength: (v) => setHaloGiSetting('classify', v),
                    setFilter: (v) => setHaloGiSetting('filter', v),     // CORE denoise: 0 off (baseline), 1 full intra-tile spatial filter
                    setFilterStrength: (v) => setHaloGiSetting('filter', v),
                    setSmoothness: (v) => setHaloGiSetting('smoothness', v),     // UI "Smoothness": widen the denoise edge-stop (kills GI splotch)
                    setChangeThreshold: (v) => setHaloGiSetting('changeThreshold', v),
                    setSnapAmount: (v) => setHaloGiSetting('snapAmount', v),
                    setFireflyClamp: (v) => setHaloGiSetting('fireflyClamp', v),
                    resetDefaults: () => resetHaloGiToDefaults({ persist: true }),
                    getSettings: () => serializeHaloGiState(),
                    setBounds: (box) => haloField?.setBounds?.(box),     // single Probe Origin box; null = auto-fit
                    setVolumes: (boxes) => haloField?.setVolumes?.(boxes), // multiple Probe Origin boxes (unioned for now)
                    getStats: () => haloField?.getStats?.() ?? { active: false, available: false },
                    tick(nowMs) {
                        if (!haloOn || deps.isPathTracingMode || !haloField?.isSupported?.()) return;
                        // Tick EVERY frame, exactly like the speedball standalone — the
                        // field self-gates on viewport idle and auto-throttles its ray
                        // budget from measured tick-to-tick dt. An external cadence cap
                        // (the old ~30 Hz throttle) reads as GPU pressure to that
                        // auto-throttle and pins the budget at the floor: 12× less
                        // solve throughput than the standalone = laggy convergence.
                        void haloField.tick({
                            idleMs: nowMs - deps.haloGiLastInteractionMs,
                            playing: !!deps.maxTimeline?.playing?.(),
                        });
                    },
                };
                window.maxjsHaloGI = deps.haloGi; // console handle
                if (haloOn) deps.haloGi.enable({ applySettings: false });
            } catch (err) {
                deps.maxjsDebugWarn?.('max.js HALO-GI init failed:', err);
                deps.haloGi = null;
            }
        }

        deps.hostBridge.onSharedBuffer('gi_surface_bin', (buf, meta) => {
                        const floatCount = Math.max(0, Math.min(Number(meta.floatCount) || 0, buf.byteLength / 4));
                        const array = new Float32Array(new Float32Array(buf, 0, floatCount));
                        const expectedNativeSurface = giVolumeNativeRequestToken === giVolumeDebounceSerial
                            && giVolumeNativeAwaitSurface === true;
                        if (deps.giVolume?.setNativeSurface?.({
                            array,
                            count: meta.sampleCount,
                            boundsMin: meta.boundsMin,
                            boundsSize: meta.boundsSize,
                        })) {
                            if (expectedNativeSurface) {
                                giVolumeNativeAwaitSurface = false;
                                maybeStartGiVolumeAfterNativePacket(giVolumeNativeRequestToken);
                            } else {
                                scheduleGiVolumeFromCurrentScene({
                                    delay: GI_VOLUME_SCENE_DEBOUNCE_MS,
                                    refresh: false,
                                    reason: 'native-surface',
                                });
                            }
                        }
        });
        deps.hostBridge.onSharedBuffer('gi_light_bin', (buf, meta) => {
                        const floatCount = Math.max(0, Math.min(Number(meta.floatCount) || 0, buf.byteLength / 4));
                        const array = new Float32Array(new Float32Array(buf, 0, floatCount));
                        const expectedNativeLights = giVolumeNativeRequestToken === giVolumeDebounceSerial
                            && giVolumeNativeAwaitLights === true;
                        if (deps.giVolume?.setNativeLights?.({
                            array,
                            count: meta.lightCount,
                        })) {
                            if (expectedNativeLights) {
                                giVolumeNativeAwaitLights = false;
                                maybeStartGiVolumeAfterNativePacket(giVolumeNativeRequestToken);
                            } else {
                                scheduleGiVolumeFromCurrentScene({
                                    delay: GI_VOLUME_LIGHT_DEBOUNCE_MS,
                                    refresh: false,
                                    lightRefresh: true,
                                    reason: 'native-lights',
                                });
                            }
                        }
        });

        // ── HALO-GI Probe Grid: size + manual divisions per node handle ──
        deps.bridge.on('probeGrids', msg => {
            probeGridData.clear();
            if (Array.isArray(msg.grids)) {
                for (const g of msg.grids) {
                    if (!g || !Number.isFinite(g.h)) continue;
                    probeGridData.set(g.h, {
                        size: Array.isArray(g.size) ? g.size : null,  // [l,w,h] world units
                        div: Array.isArray(g.div) ? g.div : null,     // [x,y,z] manual divisions
                        enabled: g.enabled !== 0,
                    });
                }
            }
            // Auto-enable HALO-GI the first time an enabled grid appears so adding a
            // probe grid "just works" (and survives viewer reloads).
            if (!probeGridAutoEnabled && window.maxjsHaloGI && window.maxjsHaloGI.isOn?.() !== true) {
                for (const d of probeGridData.values()) {
                    if (d.enabled && Array.isArray(d.size)) { probeGridAutoEnabled = true; try { window.maxjsHaloGI.enable(); } catch (e) {} break; }
                }
            }
            syncHaloProbeVolumes();
        });
        window.maxjsHaloGIShowProbes = setProbeHelpersVisible;

        return {
            HALO_GI_NUMERIC_CONTROLS,
            GI_VOLUME_CAMERA_DEBOUNCE_MS,
            getHaloGiSettings,
            clampHaloGiNumber,
            formatHaloGiValue,
            normalizeHaloGiSettings,
            applyHaloGiTuning,
            serializeHaloGiState,
            applyHaloGiState,
            setHaloGiSetting,
            resetHaloGiToDefaults,
            shouldAutoStartStudioGiVolume,
            ensureStudioGiVolume,
            installStudioGiConsoleHandle,
            applyLightProbeState,
            clearLightProbe,
            supportsWebGLLightProbeGrid,
            computeLightProbeGridBounds,
            chooseLightProbeGridResolution,
            markLightProbeSceneDirty,
            markLightProbeLightsDirty,
            markLightProbeMaterialsDirty,
            currentLightProbeSceneSignature,
            updateLightProbeGridFromScene,
            giVolumeNowMs,
            giVolumeEase,
            fadeGiVolumeTo,
            hideGiVolumeForDebounce,
            revealGiVolumeAfterDebounce,
            startGiVolumeHiddenSolve,
            clearGiVolumeNativeWait,
            maybeStartGiVolumeAfterNativePacket,
            requestNativeGiPackets,
            runGiVolumeAfterDebounce,
            syncGiVolumeActive,
            updateGiVolumeFromScene,
            scheduleGiVolumeFromCurrentScene,
            updateGiVolumeIdleWork,
            giVolumeCameraSignature,
            noteGiVolumeCameraSync,
            updateLightProbeFromCurrentScene,
            scheduleLightProbeFromCurrentScene,
            updateLightProbeFromHDRI,
            buildHaloProbeVolumes,
            serializeHaloGiProbeVolumes,
            syncHaloProbeVolumes,
            disposeProbeHelpers,
            updateProbeHelpers,
            setProbeHelpersVisible,
        };
}

export { createGiVolumeGlue };
