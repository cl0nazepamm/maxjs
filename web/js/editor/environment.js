// environment.js - HDRI/environment texture loading and local HDRI state.
import * as THREE from 'three';

function createEnvironment(deps = {}) {
        let currentHdriEnvMap = null;
        let currentHdriRawTexture = null;

        // Local HDRI override (independent of Max environment)
        let localHdriObjectUrl = null;   // file loaded in memory
        let localHdriEnvMap = null;      // cached PMREM texture
        let localHdriRawTexture = null;  // equirect source for pathtracing

        function retainPMREMTexture(renderTarget) {
            const texture = renderTarget?.texture ?? null;
            if (!texture) {
                renderTarget?.dispose?.();
                return null;
            }
            texture.userData ??= {};
            if (!texture.userData.maxjsPMREMDisposeWrapped) {
                let disposed = false;
                const originalDispose = texture.dispose?.bind(texture);
                texture.dispose = () => {
                    if (disposed) return;
                    disposed = true;
                    const target = texture.userData?.maxjsPMREMRenderTarget;
                    if (target) target.dispose?.();
                    else originalDispose?.();
                    if (texture.userData) {
                        delete texture.userData.maxjsPMREMRenderTarget;
                        delete texture.userData.maxjsPMREMDisposeWrapped;
                    }
                };
                texture.userData.maxjsPMREMDisposeWrapped = true;
            }
            texture.userData.maxjsPMREMRenderTarget = renderTarget;
            return texture;
        }

        function loadEnvironmentTexture(url, sourceName, onLoad, onProgress, onError) {
            const ext = deps.getTextureExtension(sourceName || url);
            const loader = ext === 'exr'
                ? deps.exrLoader
                : (ext === 'hdr' ? deps.rgbeLoader : deps.textureLoader);

            loader.load(url, (texture) => {
                texture.colorSpace = deps.colorSpaceForTextureExtension(ext, THREE.SRGBColorSpace);
                texture.mapping = THREE.EquirectangularReflectionMapping;
                onLoad(texture);
            }, onProgress, onError);
        }

        function getEnvironmentBackgroundMap() {
            if (isLocalHdriActive() && localHdriEnvMap) return localHdriEnvMap;
            if (currentHdriEnvMap) return currentHdriEnvMap;
            const bg = deps.scene.environment;
            return bg && !bg.isColor ? bg : null;
        }

        function syncViewportBackdrop(envMap = getEnvironmentBackgroundMap()) {
            deps.applyViewportBackdropColor(deps.envVisible && !envMap ? deps.hiddenBackgroundColor : null);
        }

        function syncEnvironmentDisplay() {
            const envMap = getEnvironmentBackgroundMap();
            deps.localHdriShowBg = deps.envVisible && !!envMap;
            syncViewportBackdrop(envMap);
            if (deps.envVisible && envMap) {
                deps.scene.background = envMap;
                if (isLocalHdriActive()) {
                    deps.scene.backgroundIntensity = deps.localHdriIntensity;
                    deps.scene.userData.maxjsPathTraceBackground = localHdriRawTexture || null;
                } else {
                    deps.scene.userData.maxjsPathTraceBackground = currentHdriRawTexture || null;
                    if (deps.localHdriBlur) deps.scene.backgroundBlurriness = deps.localHdriBlur;
                }
                deps.maxjsFx.setEnvironmentVisible(true);
            } else {
                deps.scene.background = null;
                if (!deps.envVisible) deps.scene.userData.maxjsPathTraceBackground = null;
                deps.maxjsFx.setEnvironmentVisible(false);
            }
            deps.maxjsFx.markEnvironmentChanged?.();
        }

        function syncDefaultLightsVisibility() {
            const environmentLightingActive = !!(
                deps.currentHdriUrl
                || (isLocalHdriLoaded() && deps.localHdriEnabled)
                || deps.skyActive
            );
            deps.setDefaultLightsVisible(deps.lightHandleMap.size === 0 && !environmentLightingActive);
        }

        function resetEnvironmentLighting({ restoreDefaultLights = true } = {}) {
            if (deps.lightProbeRefreshTimer) {
                clearTimeout(deps.lightProbeRefreshTimer);
                deps.lightProbeRefreshTimer = 0;
            }
            deps.currentHdriProbeSignature = '';
            deps.hdriLoadGeneration = deps.hdriLoadGeneration + 1;
            deps.clearLightProbe();
            deps.markLightProbeSceneDirty();
            deps.markLightProbeMaterialsDirty();
            if (restoreDefaultLights) {
                syncDefaultLightsVisibility();
            }
            deps.maxjsFx.markEnvironmentChanged?.();
        }

        function isLocalHdriLoaded() { return localHdriObjectUrl != null; }
        function isLocalHdriActive() { return isLocalHdriLoaded() && deps.localHdriEnabled; }
        function isNativeWebGPUBackend() {
            return deps.rendererBackendLabel === 'WebGPU' && deps.renderer?.backend?.isWebGPUBackend === true;
        }
        function isHdriReflectionOnlyEffective() {
            return !!(deps.localHdriReflectionOnly && isNativeWebGPUBackend() && isLocalHdriActive() && !deps.hasAuthoredEnvironmentActive());
        }
        function applyHdriReflectionOnlyState({ markOutput = false } = {}) {
            const active = isHdriReflectionOnlyEffective();
            deps.scene.userData.maxjsHdriReflectionOnly = active;
            deps.maxjsHdriDiffuseIntensity.value = active ? 0.0 : 1.0;
            deps.applyLightProbeState();
            if (markOutput) {
                deps.markLightProbeMaterialsDirty();
                deps.maxjsFx.markEnvironmentChanged?.();
                deps.maxjsFx.markOutputChanged?.();
            }
        }

        function clearCurrentHdriEnvMap() {
            if (currentHdriEnvMap) {
                const oldEnvMap = currentHdriEnvMap;
                currentHdriEnvMap = null;
                if (deps.scene.environment === oldEnvMap) deps.scene.environment = null;
                if (deps.scene.background === oldEnvMap) deps.scene.background = null;
                oldEnvMap.dispose?.();
            }
            if (currentHdriRawTexture) {
                if (deps.scene.userData.maxjsPathTraceEnvironment === currentHdriRawTexture) {
                    deps.scene.userData.maxjsPathTraceEnvironment = null;
                }
                if (deps.scene.userData.maxjsPathTraceBackground === currentHdriRawTexture) {
                    deps.scene.userData.maxjsPathTraceBackground = null;
                }
                currentHdriRawTexture.dispose?.();
                currentHdriRawTexture = null;
            }
        }

        function refreshLightProbeFromCurrentHDRI() {
            if (!deps.currentEnvParams?.hdri) {
                deps.markLightProbeSceneDirty();
                deps.scheduleLightProbeFromCurrentScene({ force: true, delay: 0 });
                return;
            }
            loadHDRI(deps.currentEnvParams, { forceProbeRefresh: true });
        }

        function loadHDRI(envParams, options = {}) {
            if (!envParams?.hdri) return;
            deps.currentEnvParams = envParams;

            let hdriUrl = envParams.hdri;
            try {
                hdriUrl = new URL(envParams.hdri, window.location.href).href;
            } catch {
                hdriUrl = envParams.hdri;
            }

            // Exposure
            deps.renderer.toneMappingExposure = Math.pow(2, envParams.exp || 0) * (envParams.gamma || 1.0);
            // Post FX owns the final view transform; Max HDRI exposure is
            // environment metadata and must not stomp a restored custom look.
            deps.applyCoreToneMappingState({ markOutput: false });

            const rot = (envParams.rot || 0) * Math.PI / 180;
            deps.scene.environmentRotation.set(0, -rot, 0);
            deps.scene.backgroundRotation.set(0, -rot, 0);
            const probeSignature = JSON.stringify([hdriUrl, envParams.rot || 0, envParams.flip || 0, envParams.zup || 0]);
            const shouldRefreshTexture = hdriUrl !== deps.currentHdriUrl;
            const shouldRefreshProbe = !!options.forceProbeRefresh
                || probeSignature !== deps.currentHdriProbeSignature
                || !deps.hasLightProbeData;

            if (!shouldRefreshTexture && !shouldRefreshProbe) return;

            deps.currentHdriUrl = hdriUrl;
            deps.currentHdriProbeSignature = probeSignature;
            deps.hdriLoadGeneration = deps.hdriLoadGeneration + 1;
            const loadGeneration = deps.hdriLoadGeneration;

            loadEnvironmentTexture(hdriUrl, hdriUrl, async (hdrTex) => {
                if (loadGeneration !== deps.hdriLoadGeneration) {
                    hdrTex.dispose();
                    return;
                }
                if (currentHdriRawTexture && currentHdriRawTexture !== hdrTex) currentHdriRawTexture.dispose?.();
                currentHdriRawTexture = hdrTex;
                deps.scene.userData.maxjsPathTraceEnvironment = hdrTex;
                const previousEnvMap = currentHdriEnvMap;
                const envMap = deps.isPathTracingMode
                    ? null
                    : retainPMREMTexture(deps.pmremGenerator.fromEquirectangular(hdrTex));
                currentHdriEnvMap = envMap;
                deps.scene.environment = envMap;
                applyHdriReflectionOnlyState();
                deps.syncMaterialEnvMaps();
                syncEnvironmentDisplay();
                if (previousEnvMap && previousEnvMap !== envMap) previousEnvMap.dispose?.();
                syncDefaultLightsVisibility();
                if (deps.lightProbeEnabled || shouldRefreshProbe) {
                    await deps.updateLightProbeFromHDRI(hdrTex, probeSignature, loadGeneration);
                }
                deps.maxjsFx.markEnvironmentChanged?.();
                // The path tracer bakes the env texture into its kernel at
                // build time, so an async HDRI load that lands after the scene
                // was built needs an explicit rebuild — otherwise the tracer
                // keeps its stale (null) env and shows the black/no-env state.
                deps.markPathTracingSceneDirtyNow();
                syncHdriPanel();
            }, undefined, (error) => {
                console.error('max.js HDRI load failed', { hdriUrl, error });
                deps.currentHdriUrl = null;
                deps.currentEnvParams = null;
                clearCurrentHdriEnvMap();
                deps.scene.environment = null;
                deps.scene.userData.maxjsPathTraceEnvironment = null;
                deps.scene.userData.maxjsPathTraceBackground = null;
                applyHdriReflectionOnlyState();
                deps.syncMaterialEnvMaps();
                syncEnvironmentDisplay();
                resetEnvironmentLighting();
                deps.markPathTracingSceneDirtyNow(); // drop the now-cleared env binding
                syncHdriPanel();
            });
        }

        // ── Local HDRI (independent of Max) ─────────────────
        // Persist HDRI across page reloads (Force WebGL pipeline switch) via IndexedDB
        const HDRI_DB_NAME = 'maxjs_hdri_cache';
        const HDRI_DB_STORE = 'files';

        function openHdriDB() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(HDRI_DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(HDRI_DB_STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

        async function stashHdriFile(file) {
            try {
                const db = await openHdriDB();
                const buf = await file.arrayBuffer();
                const tx = db.transaction(HDRI_DB_STORE, 'readwrite');
                tx.objectStore(HDRI_DB_STORE).put({ name: file.name, buffer: buf }, 'current');
                db.close();
            } catch (e) { deps.maxjsDebugWarn('[max.js] HDRI stash failed:', e); }
        }

        async function restoreStashedHdri() {
            try {
                const db = await openHdriDB();
                const tx = db.transaction(HDRI_DB_STORE, 'readonly');
                const req = tx.objectStore(HDRI_DB_STORE).get('current');
                return new Promise((resolve) => {
                    req.onsuccess = () => {
                        db.close();
                        const data = req.result;
                        if (data?.buffer && data?.name) {
                            resolve(new File([data.buffer], data.name));
                        } else {
                            resolve(null);
                        }
                    };
                    req.onerror = () => { db.close(); resolve(null); };
                });
            } catch { return null; }
        }

        async function clearStashedHdri() {
            try {
                const db = await openHdriDB();
                const tx = db.transaction(HDRI_DB_STORE, 'readwrite');
                tx.objectStore(HDRI_DB_STORE).delete('current');
                db.close();
            } catch {}
        }

        function loadLocalHDRIFile(file, { preserveEnabled = false, persist = true } = {}) {
            if (localHdriObjectUrl) URL.revokeObjectURL(localHdriObjectUrl);
            if (localHdriEnvMap) { localHdriEnvMap.dispose(); localHdriEnvMap = null; }
            if (localHdriRawTexture) { localHdriRawTexture.dispose?.(); localHdriRawTexture = null; }
            if (!deps.hasAuthoredEnvironmentActive()) {
                clearCurrentHdriEnvMap();
            }
            deps.localHdriFile = file;
            localHdriObjectUrl = URL.createObjectURL(file);
            deps.localHdriFileName = file.name;
            if (!preserveEnabled) deps.localHdriEnabled = true;
            void stashHdriFile(file);

            deps.hdriLoadGeneration = deps.hdriLoadGeneration + 1;
            const loadGen = deps.hdriLoadGeneration;

            loadEnvironmentTexture(localHdriObjectUrl, file.name, async (hdrTex) => {
                if (loadGen !== deps.hdriLoadGeneration) { hdrTex.dispose(); return; }
                localHdriRawTexture = hdrTex;
                localHdriEnvMap = deps.isPathTracingMode
                    ? null
                    : retainPMREMTexture(deps.pmremGenerator.fromEquirectangular(hdrTex));
                applyLocalHDRIToScene();
                deps.currentHdriUrl = localHdriObjectUrl;
                if (!deps.hasAuthoredEnvironmentActive() && deps.lightProbeEnabled) {
                    await deps.updateLightProbeFromHDRI(hdrTex, 'local-' + deps.localHdriFileName, loadGen);
                }
                deps.maxjsFx.markEnvironmentChanged?.();
                // Async load: rebuild the tracer so it picks up the new env
                // texture (baked into the kernel at build time). See loadHDRI.
                deps.markPathTracingSceneDirtyNow();
                if (persist) deps.savePostFxState();
                syncHdriPanel();
            }, undefined, (error) => {
                console.error('max.js local HDRI load failed', error);
                clearLocalHDRI();
            });
        }

        function applyLocalHDRIToScene() {
            if (deps.hasAuthoredEnvironmentActive()) {
                deps.restoreAuthoredEnvironmentAfterLocalHDRIChange();
                return;
            }
            if (!localHdriEnvMap && !localHdriRawTexture) return;
            if (deps.localHdriEnabled) {
                deps.scene.environment = localHdriEnvMap;
                deps.scene.userData.maxjsPathTraceEnvironment = localHdriRawTexture || null;
                deps.syncMaterialEnvMaps();
                deps.scene.environmentIntensity = deps.localHdriIntensity;
                applyHdriReflectionOnlyState();
                const rot = deps.localHdriRotation * Math.PI / 180;
                deps.scene.environmentRotation.set(0, -rot, 0);
                deps.scene.backgroundRotation.set(0, -rot, 0);
                if (deps.localHdriFlip) {
                    deps.scene.environmentRotation.y += Math.PI;
                    deps.scene.backgroundRotation.y += Math.PI;
                }
                deps.scene.backgroundBlurriness = deps.localHdriBlur;
                syncEnvironmentDisplay();
                syncDefaultLightsVisibility();
            } else {
                deps.scene.environment = null;
                deps.scene.userData.maxjsPathTraceEnvironment = currentHdriRawTexture || null;
                deps.scene.userData.maxjsPathTraceBackground = null;
                applyHdriReflectionOnlyState();
                deps.syncMaterialEnvMaps();
                deps.setBackgroundColor(deps.hiddenBackgroundColor);
                deps.maxjsFx.setEnvironmentVisible(false);
                resetEnvironmentLighting();
            }
        }

        function applyLocalHDRISettings() {
            if (deps.hasAuthoredEnvironmentActive()) {
                deps.restoreAuthoredEnvironmentAfterLocalHDRIChange();
                return;
            }
            if (!isLocalHdriActive()) return;
            applyLocalHDRIToScene();
            deps.maxjsFx.markOutputChanged?.();
        }

        function toggleLocalHDRI(enabled) {
            deps.localHdriEnabled = enabled;
            applyLocalHDRIToScene();
            deps.maxjsFx.markEnvironmentChanged?.();
            deps.markPathTracingSceneDirtyNow(); // env texture binding toggled on/off
            deps.savePostFxState();
            syncHdriPanel();
        }

        function clearLocalHDRI() {
            const authoredEnvironmentActive = deps.hasAuthoredEnvironmentActive();
            deps.localHdriFileName = '';
            deps.localHdriFile = null;
            deps.localHdriEnabled = true;
            if (localHdriEnvMap) { localHdriEnvMap.dispose(); localHdriEnvMap = null; }
            if (localHdriRawTexture) { localHdriRawTexture.dispose?.(); localHdriRawTexture = null; }
            clearCurrentHdriEnvMap();
            if (localHdriObjectUrl) { URL.revokeObjectURL(localHdriObjectUrl); localHdriObjectUrl = null; }
            void clearStashedHdri();
            deps.currentHdriUrl = null;
            deps.currentHdriProbeSignature = '';
            if (authoredEnvironmentActive) {
                deps.restoreAuthoredEnvironmentAfterLocalHDRIChange();
                deps.maxjsFx.markEnvironmentChanged?.();
                deps.markPathTracingSceneDirtyNow(); // env binding swapped back to authored
                deps.savePostFxState();
                syncHdriPanel();
                return;
            }
            deps.scene.environment = null;
            deps.scene.userData.maxjsPathTraceEnvironment = null;
            deps.scene.userData.maxjsPathTraceBackground = null;
            applyHdriReflectionOnlyState();
            deps.syncMaterialEnvMaps();
            deps.scene.environmentIntensity = 1.0;
            deps.scene.environmentRotation.set(0, 0, 0);
            deps.scene.backgroundRotation.set(0, 0, 0);
            deps.scene.backgroundBlurriness = 0;
            syncEnvironmentDisplay();
            resetEnvironmentLighting();
            deps.markPathTracingSceneDirtyNow(); // env binding cleared
            deps.savePostFxState();
            syncHdriPanel();
        }

        function syncHdriPanel() {
            const nameEl = document.getElementById('fx-hdri-name');
            const toggleEl = document.getElementById('fx-hdri-toggle');
            const authoredEnvironmentActive = deps.hasAuthoredEnvironmentActive();
            if (nameEl) {
                nameEl.textContent = authoredEnvironmentActive
                    ? 'Max environment active'
                    : isLocalHdriLoaded()
                    ? deps.localHdriFileName + (deps.localHdriEnabled ? '' : ' (off)')
                    : 'No HDRI loaded';
            }
            if (toggleEl) {
                toggleEl.textContent = deps.localHdriEnabled ? 'On' : 'Off';
                toggleEl.classList.toggle('active', !authoredEnvironmentActive && deps.localHdriEnabled && isLocalHdriLoaded());
            }
            const reflectionOnlyEl = document.getElementById('fx-hdri-reflection-only');
            if (reflectionOnlyEl) reflectionOnlyEl.checked = deps.localHdriReflectionOnly;
            for (const id of ['fx-hdri-toggle', 'fx-hdri-load', 'fx-hdri-clear', 'fx-hdri-rotation', 'fx-hdri-intensity', 'fx-hdri-blur', 'fx-hdri-flip', 'fx-hdri-reflection-only']) {
                const el = document.getElementById(id);
                if (el) el.disabled = authoredEnvironmentActive;
            }
        }

        return {
            retainPMREMTexture,
            loadEnvironmentTexture,
            getEnvironmentBackgroundMap,
            syncViewportBackdrop,
            syncEnvironmentDisplay,
            syncDefaultLightsVisibility,
            resetEnvironmentLighting,
            isLocalHdriLoaded,
            isLocalHdriActive,
            isHdriReflectionOnlyEffective,
            applyHdriReflectionOnlyState,
            clearCurrentHdriEnvMap,
            refreshLightProbeFromCurrentHDRI,
            loadHDRI,
            openHdriDB,
            stashHdriFile,
            restoreStashedHdri,
            clearStashedHdri,
            loadLocalHDRIFile,
            applyLocalHDRIToScene,
            applyLocalHDRISettings,
            toggleLocalHDRI,
            clearLocalHDRI,
            syncHdriPanel,
            get currentHdriEnvMap() { return currentHdriEnvMap; },
            get currentHdriRawTexture() { return currentHdriRawTexture; },
            get localHdriObjectUrl() { return localHdriObjectUrl; },
            get localHdriEnvMap() { return localHdriEnvMap; },
            get localHdriRawTexture() { return localHdriRawTexture; },
        };
}

export { createEnvironment };
