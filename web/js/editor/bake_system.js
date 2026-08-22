// bake_system.js - runtime bake overrides, lightmap UV handling, and bake panel glue.
import * as THREE from 'three';
import * as THREE_STD from 'three-std';
import * as TSL from 'three/tsl';
import { isSyntheticUv0Attribute } from '../material_contract.js';

function createBakeSystem(deps = {}) {
        const {
            DEFAULT_BAKE_STATE,
            maxMapChannelFromMapName,
            textureWithUvChannel,
            loadBakeTextureFromCandidates,
            bakeExposureScale,
            isDisplayBakedBeautyProxy,
            clearBakeTextureLoadFailures,
            isWebGLTexturePathActive,
            getTextureExtension,
            colorSpaceForTextureExtension,
            textureLoader,
            exrLoader,
            rgbeLoader,
            isCachedMaterialTemplate,
            rememberMaterialEmissiveBase,
            disposeSceneMaterial,
            ensureSceneRenderableMaterial,
            stampSceneMaterial,
            markLightProbeSceneDirty,
            scheduleLightProbeFromCurrentScene,
            requestHostAction,
            bytesToBase64,
            reportBridgeError,
            maxjsDebugWarn,
        } = deps;

        let lastBakeUv2RequestKey = '';
        let bakeUv2RequestTimer = 0;

        function normalizeBakeState(payload) {
            const raw = payload && typeof payload === 'object' ? payload : {};
            const next = { ...DEFAULT_BAKE_STATE, ...raw };
            next.enabled = raw.enabled === true;
            next.mode = next.mode === 'beauty' ? 'beauty' : 'lightmap';
            next.match = ['scene', 'object', 'material'].includes(next.match) ? next.match : 'scene';
            next.folder = stripWrappingQuotes(next.folder);
            next.sceneName = String(next.sceneName || DEFAULT_BAKE_STATE.sceneName).trim() || DEFAULT_BAKE_STATE.sceneName;
            next.lightSuffix = String(next.lightSuffix ?? DEFAULT_BAKE_STATE.lightSuffix);
            next.beautySuffix = String(next.beautySuffix ?? DEFAULT_BAKE_STATE.beautySuffix);
            next.extension = String(next.extension || DEFAULT_BAKE_STATE.extension).replace(/^\./, '') || DEFAULT_BAKE_STATE.extension;
            next.intensity = Number.isFinite(Number(next.intensity)) ? Math.max(0, Number(next.intensity)) : 1.0;
            next.bakeExposure = Number.isFinite(Number(next.bakeExposure)) ? Number(next.bakeExposure) : 0;
            next.proxyDisplay = raw.proxyDisplay === true;
            return next;
        }

        function serializeBakeState() {
            return { ...deps.bakeOverrides };
        }

        function serializeSnapshotBakeState() {
            const state = serializeBakeState();
            if (state.enabled && state.folder) {
                state.folder = normalizeBakeFolderUrl(state.folder);
            }
            return state;
        }

        function bakeStateSignature() {
            return JSON.stringify(deps.bakeOverrides);
        }

        function stripWrappingQuotes(value) {
            let text = String(value ?? '').trim();
            while (text.length >= 2) {
                const first = text[0];
                const last = text[text.length - 1];
                if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                    text = text.slice(1, -1).trim();
                    continue;
                }
                break;
            }
            return text;
        }

        function encodeAssetPath(path) {
            const normalized = String(path ?? '').replace(/\\/g, '/');
            const segments = normalized.split('/').filter((segment, index) => segment.length > 0 || index === 0);
            return segments.map(segment => encodeURIComponent(segment)).join('/');
        }

        function normalizeBakeFolderUrl(folder) {
            const raw = String(folder ?? '').trim();
            if (!raw) return '';
            if (/^https?:\/\//i.test(raw) || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/')) {
                return raw.endsWith('/') ? raw : `${raw}/`;
            }
            if (/^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
                return `https://maxjs-assets.local/${encodeAssetPath(raw).replace(/\/?$/, '/')}`;
            }
            return raw.endsWith('/') ? raw : `${raw}/`;
        }

        function sanitizeBakeFileStem(value) {
            return String(value ?? '')
                .trim()
                .replace(/[\\/:*?"<>|]+/g, '_')
                .replace(/\s+/g, '_')
                .replace(/^_+|_+$/g, '') || 'scene';
        }

        function getMaterialBakeName(material) {
            return String(
                material?.userData?.maxjsSourceMaterialName ??
                material?.name ??
                'material'
            ).trim() || 'material';
        }

        function getBakeTargetName(nd, material, mesh = null) {
            if (deps.bakeOverrides.match === 'object') return mesh?.name || nd?.n || nd?.name || `node_${nd?.h ?? '0'}`;
            if (deps.bakeOverrides.match === 'material') return getMaterialBakeName(material);
            return deps.bakeOverrides.sceneName;
        }

        function getBakeTextureUrl(nd, material, kind, mesh = null, extensionOverride = null) {
            return getBakeTextureCandidates(nd, material, kind, mesh, extensionOverride)[0]?.url || '';
        }

        function bakeFilenameHasExplicitUvChannel(filename) {
            const baseName = String(filename ?? '').replace(/\.[^./\\]+$/, '');
            return /(?:^|[_.\-\s])UV[12](?:$|[_.\-\s])/i.test(baseName);
        }

        function getBakeFilenameCandidates(stem, suffix, extension) {
            const exact = `${stem}${suffix}.${extension}`;
            const names = bakeFilenameHasExplicitUvChannel(exact)
                ? [exact]
                : [
                    `${stem}_UV2.${extension}`,
                    `${stem}_UV1.${extension}`,
                    exact,
                    ...(suffix ? [`${stem}.${extension}`] : []),
                ];
            return [...new Set(names)];
        }

        function getBakeTextureCandidates(nd, material, kind, mesh = null, extensionOverride = null) {
            if (!deps.bakeOverrides.enabled || !deps.bakeOverrides.folder) return [];
            const folder = normalizeBakeFolderUrl(deps.bakeOverrides.folder);
            if (!folder) return [];
            const suffix = kind === 'beauty' ? deps.bakeOverrides.beautySuffix : deps.bakeOverrides.lightSuffix;
            const stem = sanitizeBakeFileStem(getBakeTargetName(nd, material, mesh));
            const extension = String(extensionOverride || deps.bakeOverrides.extension || DEFAULT_BAKE_STATE.extension).replace(/^\./, '');
            return getBakeFilenameCandidates(stem, suffix, extension).map(filename => ({
                filename,
                url: `${folder}${encodeURIComponent(filename)}`,
                maxMapChannel: getBakeMaxMapChannel(filename),
            }));
        }

        function hasGeometryUV2(geom) {
            return !!(geom?.getAttribute?.('uv1') || geom?.getAttribute?.('uv2'));
        }

        function getBakeMaxMapChannel(url = '') {
            return maxMapChannelFromMapName(url, 2);
        }

        function hasGeometryMaxMapChannel(geom, maxMapChannel = 2) {
            const channel = Number.isFinite(Number(maxMapChannel))
                ? Math.max(1, Math.round(Number(maxMapChannel)))
                : 2;
            if (channel === 1) {
                const uv = geom?.getAttribute?.('uv');
                return !!uv && !isSyntheticUv0Attribute(uv);
            }
            if (channel === 2) return hasGeometryUV2(geom);
            return false;
        }

        const webGpuLightMapUvContexts = new WeakMap();

        function restoreWebGpuLightMapUvContext(material) {
            const state = material ? webGpuLightMapUvContexts.get(material) : null;
            if (!state) return false;
            const ownsContext = material.contextNode === state.contextNode;
            webGpuLightMapUvContexts.delete(material);
            if (!ownsContext) return false;
            material.contextNode = state.previousContext ?? null;
            material.needsUpdate = true;
            return true;
        }

        function applyWebGpuLightMapUvContext(material, maxMapChannel = 2) {
            if (!material) return false;
            if (String(deps.rendererBackendLabel || '') !== 'WebGPU') return restoreWebGpuLightMapUvContext(material);
            const channel = Number.isFinite(Number(maxMapChannel))
                ? Math.max(1, Math.round(Number(maxMapChannel)))
                : 2;
            if (channel !== 1) return restoreWebGpuLightMapUvContext(material);
            const lightMap = material.lightMap;
            if (!lightMap?.isTexture || typeof TSL?.replaceDefaultUV !== 'function' || typeof TSL?.uv !== 'function') {
                return restoreWebGpuLightMapUvContext(material);
            }

            const lightMapUuid = lightMap.uuid;
            const previousState = webGpuLightMapUvContexts.get(material);
            if (previousState?.textureUuid === lightMapUuid &&
                previousState?.maxMapChannel === channel &&
                material.contextNode === previousState.contextNode) {
                return false;
            }
            const previousContext = previousState?.previousContext ?? material.contextNode ?? null;
            const contextNode = TSL.replaceDefaultUV((textureNode) => {
                const tex = textureNode?.value;
                if (tex === lightMap || tex?.uuid === lightMapUuid) return TSL.uv(0);
                if (textureNode?.uvNode) return textureNode.uvNode;
                const fallbackChannel = Number.isFinite(Number(tex?.channel))
                    ? Math.max(0, Math.round(Number(tex.channel)))
                    : 0;
                return TSL.uv(fallbackChannel);
            });
            material.contextNode = contextNode;
            webGpuLightMapUvContexts.set(material, { previousContext, contextNode, textureUuid: lightMapUuid, maxMapChannel: channel });
            material.needsUpdate = true;
            return true;
        }

        function markBakeMissingUv(material, maxMapChannel = 2) {
            material.userData ??= {};
            material.userData.maxjsBakeMissingUV = maxMapChannel;
            if (maxMapChannel === 2) material.userData.maxjsBakeMissingUV2 = true;
            else delete material.userData.maxjsBakeMissingUV2;
        }

        function clearBakeMissingUv(material) {
            if (!material?.userData) return;
            delete material.userData.maxjsBakeMissingUV;
            delete material.userData.maxjsBakeMissingUV2;
        }

        function maybeRequestBakeUv2Resync(reason = 'auto') {
            const state = normalizeBakeState(deps.bakeOverrides);
            if (!state.enabled || (state.mode !== 'lightmap' && state.mode !== 'beauty')) return;
            if (!window.chrome?.webview) return;

            const stats = getBakeUv2RequirementStats(state.mode);
            if (stats.required <= 0 || stats.ready >= stats.required) return;

            const key = `${bakeStateSignature()}|${stats.required}|${stats.ready}`;
            if (key === lastBakeUv2RequestKey) return;
            lastBakeUv2RequestKey = key;

            clearTimeout(bakeUv2RequestTimer);
            bakeUv2RequestTimer = setTimeout(() => {
                deps.bridge.send('sync_lightmap_uvs', { reason });
                deps.perfHud.setStatus('max.js - requesting native UV2 bake geometry resync');
            }, 50);
        }

        function createBeautyBakeMaterial(source, texture, url = '', maxMapChannel = 2) {
            const BakeTHREE = isWebGLTexturePathActive() ? THREE_STD : THREE;
            const displayProxy = isDisplayBakedBeautyProxy(url);
            const exposureScale = displayProxy ? 1 : bakeExposureScale();
            const mat = new BakeTHREE.MeshBasicMaterial({
                color: new BakeTHREE.Color(exposureScale, exposureScale, exposureScale),
                map: textureWithUvChannel(texture, maxMapChannel, 2),
                side: source?.side ?? BakeTHREE.FrontSide,
                transparent: !!source?.transparent || (Number.isFinite(source?.opacity) && source.opacity < 1),
                opacity: Number.isFinite(source?.opacity) ? source.opacity : 1,
                alphaMap: source?.alphaMap ?? null,
                depthWrite: source?.depthWrite ?? true,
                depthTest: source?.depthTest ?? true,
                toneMapped: !displayProxy,
            });
            mat.name = source?.name ? `${source.name} bake beauty` : 'bake beauty';
            mat.userData = { ...(source?.userData || {}), maxjsBakeOverride: 'beauty', maxjsBakeUvChannel: maxMapChannel };
            return mat;
        }

        function bakeOverrideOwnerKey(nd, mesh = null) {
            const handle = nd?.h ?? mesh?.userData?.maxjsHandle;
            if (handle != null) return `h:${handle}`;
            return `n:${mesh?.name || nd?.n || nd?.name || ''}`;
        }

        function stampBakeOverrideOwner(material, nd, mesh = null) {
            if (!material) return;
            material.userData ??= {};
            material.userData.maxjsBakeOwnerKey = bakeOverrideOwnerKey(nd, mesh);
            material.userData.maxjsBakeOwnerName = mesh?.name || nd?.n || nd?.name || '';
        }

        function ensureBakeOverrideMaterialInstance(material, nd, mesh = null) {
            if (!material) return material;
            const ownerKey = bakeOverrideOwnerKey(nd, mesh);
            const existingOwnerKey = material.userData?.maxjsBakeOwnerKey;
            const needsClone = isCachedMaterialTemplate(material) ||
                (existingOwnerKey && existingOwnerKey !== ownerKey);
            if (!needsClone) {
                stampBakeOverrideOwner(material, nd, mesh);
                return material;
            }
            const clone = material.clone();
            clone.userData = { ...(material.userData || {}) };
            stampBakeOverrideOwner(clone, nd, mesh);
            rememberMaterialEmissiveBase(clone);
            clone.needsUpdate = true;
            return clone;
        }

        function applyBakeOverrideToMaterial(material, nd, geom, mesh = null) {
            if (!material || !deps.bakeOverrides.enabled) return material;
            if (material.isLineBasicMaterial || material.isLineDashedMaterial) return material;
            const kind = deps.bakeOverrides.mode === 'beauty' ? 'beauty' : 'lightmap';
            if (kind === 'lightmap') material = ensureBakeOverrideMaterialInstance(material, nd, mesh);
            const candidates = getBakeTextureCandidates(nd, material, kind, mesh);
            if (!candidates.length) return material;
            const usableCandidates = candidates.filter(candidate => hasGeometryMaxMapChannel(geom, candidate.maxMapChannel));
            if (!usableCandidates.length) {
                markBakeMissingUv(material, candidates[0]?.maxMapChannel ?? 2);
                return material;
            }

            if (kind === 'beauty') {
                const bake = loadBakeTextureFromCandidates(usableCandidates, THREE.SRGBColorSpace);
                if (!bake) return material;
                material.userData ??= {};
                clearBakeMissingUv(material);
                material.userData.maxjsBakeSourceUrl = bake.url;
                material.userData.maxjsBakeUvChannel = bake.maxMapChannel;
                material.toneMapped = !isDisplayBakedBeautyProxy(bake.url);
                return createBeautyBakeMaterial(material, bake.texture, bake.url, bake.maxMapChannel);
            }

            const bake = loadBakeTextureFromCandidates(usableCandidates, THREE.LinearSRGBColorSpace);
            if (!bake) return material;
            material.lightMap = textureWithUvChannel(bake.texture, bake.maxMapChannel, 2);
            applyWebGpuLightMapUvContext(material, bake.maxMapChannel);
            material.lightMapIntensity = bakeExposureScale();
            material.userData ??= {};
            stampBakeOverrideOwner(material, nd, mesh);
            clearBakeMissingUv(material);
            material.userData.maxjsBakeOverride = 'lightmap';
            material.userData.maxjsBakeSourceUrl = bake.url;
            material.userData.maxjsBakeUvChannel = bake.maxMapChannel;
            material.userData.maxjsBakeTextureChannel = material.lightMap?.channel ?? null;
            material.needsUpdate = true;
            return material;
        }

        function applyBakeOverridesToSceneMaterial(material, nd, geom, mesh = null) {
            if (Array.isArray(material)) {
                return material.map(item => applyBakeOverrideToMaterial(item, nd, geom, mesh));
            }
            return applyBakeOverrideToMaterial(material, nd, geom, mesh);
        }

        // ── Bake Overrides Panel ───────────────────────────
        const bakePanel = document.getElementById('bakePanel');
        let bakePanelVisible = false;
        let bakePersistTimer = 0;
        let lastProjectBakeSignature = '';
        let suppressBakePersistenceDepth = 0;
        const BAKE_STORAGE_KEY = 'maxjs_bake_state';

        function withBakePersistenceSuppressed(fn) {
            suppressBakePersistenceDepth += 1;
            try {
                return fn();
            } finally {
                suppressBakePersistenceDepth = Math.max(0, suppressBakePersistenceDepth - 1);
            }
        }

        function escapeBakeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
            }[ch]));
        }

        function getBakeSceneStats() {
            let meshes = 0;
            let uv1 = 0;
            let uv2 = 0;
            for (const mesh of deps.nodeMap.values()) {
                if (!mesh?.isMesh) continue;
                meshes++;
                if (hasGeometryMaxMapChannel(mesh.geometry, 1)) uv1++;
                if (hasGeometryUV2(mesh.geometry)) uv2++;
            }
            return { meshes, uv1, uv2 };
        }

        function getBakeUv2RequirementStats(kind = deps.bakeOverrides.mode === 'beauty' ? 'beauty' : 'lightmap') {
            let required = 0;
            let ready = 0;
            for (const mesh of deps.nodeMap.values()) {
                const nd = mesh?.userData?.maxjsLastNodePayload;
                if (!mesh?.isMesh || !nd) continue;
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const material of materials) {
                    const needsUv2 = getBakeTextureCandidates(nd, material, kind, mesh)
                        .some(candidate => candidate.maxMapChannel === 2);
                    if (!needsUv2) continue;
                    required++;
                    if (hasGeometryUV2(mesh.geometry)) ready++;
                }
            }
            return { required, ready };
        }

        function mutateLightmapBakeOnMaterial(material, nd, geom, mesh = null) {
            if (!material) return false;
            if (material.isLineBasicMaterial || material.isLineDashedMaterial) return false;
            const wasOverride = material.userData?.maxjsBakeOverride;
            const shouldApply = deps.bakeOverrides.enabled && deps.bakeOverrides.mode === 'lightmap';

            if (!shouldApply) {
                if (wasOverride === 'lightmap') {
                    material.lightMap = null;
                    material.lightMapIntensity = 1.0;
                    restoreWebGpuLightMapUvContext(material);
                    if (material.userData) delete material.userData.maxjsBakeOverride;
                    material.needsUpdate = true;
                    return true;
                }
                return false;
            }

            const candidates = getBakeTextureCandidates(nd, material, 'lightmap', mesh);
            const usableCandidates = candidates.filter(candidate => hasGeometryMaxMapChannel(geom, candidate.maxMapChannel));
            if (!candidates.length || !usableCandidates.length) {
                material.userData ??= {};
                if (!candidates.length) {
                    if (wasOverride === 'lightmap') {
                        material.lightMap = null;
                        material.lightMapIntensity = 1.0;
                        restoreWebGpuLightMapUvContext(material);
                        delete material.userData.maxjsBakeOverride;
                        material.needsUpdate = true;
                        return true;
                    }
                    return false;
                }
                markBakeMissingUv(material, candidates[0]?.maxMapChannel ?? 2);
                return false;
            }

            const bake = loadBakeTextureFromCandidates(usableCandidates, THREE.LinearSRGBColorSpace);
            if (!bake) return false;
            const nextLightMap = textureWithUvChannel(bake.texture, bake.maxMapChannel, 2);
            const intensity = bakeExposureScale();
            const lightMapChanged = material.lightMap !== nextLightMap;
            const intensityChanged = material.lightMapIntensity !== intensity;
            const uvChannelChanged = material.userData?.maxjsBakeUvChannel !== bake.maxMapChannel ||
                material.userData?.maxjsBakeTextureChannel !== (nextLightMap?.channel ?? null);
            material.lightMap = nextLightMap;
            const uvContextChanged = applyWebGpuLightMapUvContext(material, bake.maxMapChannel);
            if (!lightMapChanged && !intensityChanged && !uvChannelChanged && !uvContextChanged && wasOverride === 'lightmap') return false;
            material.lightMapIntensity = intensity;
            material.userData ??= {};
            stampBakeOverrideOwner(material, nd, mesh);
            clearBakeMissingUv(material);
            material.userData.maxjsBakeOverride = 'lightmap';
            material.userData.maxjsBakeSourceUrl = bake.url;
            material.userData.maxjsBakeUvChannel = bake.maxMapChannel;
            material.userData.maxjsBakeTextureChannel = nextLightMap?.channel ?? null;
            if (lightMapChanged || uvChannelChanged || uvContextChanged) material.needsUpdate = true;
            return true;
        }

        function reapplyBakeOverridesToScene() {
            let changed = false;
            const wantsBeauty = deps.bakeOverrides.enabled && deps.bakeOverrides.mode === 'beauty';
            const seenMats = new WeakSet();

            for (const mesh of deps.nodeMap.values()) {
                const nd = mesh?.userData?.maxjsLastNodePayload;
                if (!mesh || !nd) continue;
                const mats = Array.isArray(mesh.material) ? mesh.material : (mesh.material ? [mesh.material] : []);
                const hasBeautyOverride = mats.some(m => m?.userData?.maxjsBakeOverride === 'beauty');

                if (wantsBeauty || hasBeautyOverride) {
                    const wantsLine = mesh.isLine || mesh.isLineSegments;
                    mesh.userData ??= {};
                    mesh.userData.maxjsMaterialSignature = '';
                    const previousMaterial = mesh.material;
                    if (ensureSceneRenderableMaterial(mesh, nd, wantsLine)) {
                        changed = true;
                        deps.lightLinking?.replaceRenderableMaterial?.(previousMaterial, mesh.material);
                        if (nd.h != null) deps.layerManager.applyMaterialOverrides?.(nd.h, mesh);
                    }
                    continue;
                }

                for (let materialIndex = 0; materialIndex < mats.length; materialIndex++) {
                    let m = mats[materialIndex];
                    if (!m) continue;
                    const unique = ensureBakeOverrideMaterialInstance(m, nd, mesh);
                    if (unique !== m) {
                        if (Array.isArray(mesh.material)) mesh.material[materialIndex] = unique;
                        else mesh.material = unique;
                        deps.lightLinking?.replaceRenderableMaterial?.(m, mesh.material);
                        disposeSceneMaterial(m);
                        m = unique;
                        changed = true;
                    }
                    if (seenMats.has(m)) continue;
                    seenMats.add(m);
                    if (mutateLightmapBakeOnMaterial(m, nd, mesh.geometry, mesh)) changed = true;
                }
            }
            if (changed) {
                deps.maxjsFx.markSceneChanged?.();
                deps.maxjsFx.markOutputChanged?.();
                markLightProbeSceneDirty();
                deps.markSpeedballMaterialsDirty();
                scheduleLightProbeFromCurrentScene({ delay: 250 });
            }
            return changed;
        }

        function applyBakeState(payload, { persist = false, rebuild = true, refreshPanel = true, force = false } = {}) {
            const next = normalizeBakeState(payload);
            const prevSignature = bakeStateSignature();
            const nextSignature = JSON.stringify(next);
            const activeEl = document.activeElement;
            const bakePanelEditing = !!(bakePanelVisible && activeEl && bakePanel.contains(activeEl) && activeEl.matches?.('input,select,textarea'));
            if (!force && prevSignature === nextSignature) {
                if (refreshPanel && bakePanelVisible && !bakePanelEditing) rebuildBakePanel();
                return;
            }
            deps.bakeOverrides = next;
            maybeRequestBakeUv2Resync('bake-overrides');
            if (rebuild) reapplyBakeOverridesToScene();
            if (refreshPanel && bakePanelVisible && !bakePanelEditing) rebuildBakePanel();
            if (persist) saveBakeState();
        }

        function saveBakeState() {
            if (suppressBakePersistenceDepth > 0) return;
            const payload = serializeBakeState();
            const signature = JSON.stringify(payload);
            const projectRuntime = deps.projectRuntime;
            if (projectRuntime?.setBakeState) {
                if (signature === lastProjectBakeSignature) return;
                lastProjectBakeSignature = signature;
                clearTimeout(bakePersistTimer);
                bakePersistTimer = setTimeout(() => {
                    bakePersistTimer = 0;
                    void projectRuntime.setBakeState(payload).catch(error => {
                        reportBridgeError('bake state save', error);
                    });
                }, 550);
                return;
            }
            try {
                localStorage.setItem(BAKE_STORAGE_KEY, signature);
            } catch {}
        }

        function restoreBakeState() {
            const projectPayload = deps.projectRuntime?.getBakeState?.();
            if (projectPayload) {
                lastProjectBakeSignature = JSON.stringify(projectPayload);
                withBakePersistenceSuppressed(() => {
                    applyBakeState(projectPayload, { rebuild: true });
                });
                return;
            }
            if (deps.projectRuntime) return;
            try {
                const raw = localStorage.getItem(BAKE_STORAGE_KEY);
                if (raw) {
                    withBakePersistenceSuppressed(() => {
                        applyBakeState(JSON.parse(raw), { rebuild: true });
                    });
                }
            } catch {}
        }

        function syncProjectBakeState() {
            const payload = deps.projectRuntime?.getBakeState?.();
            if (!payload) return;
            const signature = JSON.stringify(payload);
            if (!signature || signature === lastProjectBakeSignature) return;
            lastProjectBakeSignature = signature;
            withBakePersistenceSuppressed(() => {
                applyBakeState(payload, { rebuild: true });
            });
        }

        function setBakePanelVisible(v) {
            bakePanelVisible = !!v;
            bakePanel.classList.toggle('visible', bakePanelVisible);
            bakePanel.toggleAttribute('inert', !bakePanelVisible);
            bakePanel.setAttribute('aria-hidden', String(!bakePanelVisible));
            document.getElementById('btnBakeOverrides')?.classList.toggle('active', bakePanelVisible);
            if (bakePanelVisible) rebuildBakePanel();
        }

        function readBakeStateFromPanel() {
            return normalizeBakeState({
                enabled: bakePanel.querySelector('#bake-enabled')?.checked === true,
                mode: bakePanel.querySelector('#bake-mode')?.value,
                match: bakePanel.querySelector('#bake-match')?.value,
                folder: bakePanel.querySelector('#bake-folder')?.value,
                sceneName: bakePanel.querySelector('#bake-scene')?.value,
                lightSuffix: bakePanel.querySelector('#bake-light-suffix')?.value,
                beautySuffix: bakePanel.querySelector('#bake-beauty-suffix')?.value,
                extension: bakePanel.querySelector('#bake-ext')?.value,
                intensity: parseFloat(bakePanel.querySelector('#bake-intensity')?.value),
                bakeExposure: parseFloat(bakePanel.querySelector('#bake-exposure')?.value),
            });
        }

        function updateBakePanelPreview(next) {
            const intensityLabel = bakePanel.querySelector('#bake-intensity')?.nextElementSibling;
            if (intensityLabel) intensityLabel.textContent = next.intensity.toFixed(2);
            const exposureLabel = bakePanel.querySelector('#bake-exposure')?.nextElementSibling;
            if (exposureLabel) exposureLabel.textContent = `${next.bakeExposure >= 0 ? '+' : ''}${next.bakeExposure.toFixed(1)} EV`;
            const previous = deps.bakeOverrides;
            deps.bakeOverrides = next;
            const sampleLight = getBakeTextureUrl({ n: 'ObjectName', h: 0 }, null, 'lightmap') || 'Set a folder to preview path';
            const sampleBeauty = getBakeTextureUrl({ n: 'ObjectName', h: 0 }, null, 'beauty') || 'Set a folder to preview path';
            deps.bakeOverrides = previous;
            const lightPreview = bakePanel.querySelector('#bake-light-preview');
            const beautyPreview = bakePanel.querySelector('#bake-beauty-preview');
            if (lightPreview) lightPreview.innerHTML = `<span class="bake-path-label">Light</span>${escapeBakeHtml(sampleLight)}`;
            if (beautyPreview) beautyPreview.innerHTML = `<span class="bake-path-label">Beauty</span>${escapeBakeHtml(sampleBeauty)}`;
        }

        function getBakeTargetPreviewRows(limit = 8) {
            const kind = deps.bakeOverrides.mode === 'beauty' ? 'beauty' : 'lightmap';
            const rows = [];
            const seen = new Set();
            for (const mesh of deps.nodeMap.values()) {
                const nd = mesh?.userData?.maxjsLastNodePayload;
                if (!mesh?.isMesh || !nd) continue;
                const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
                const stem = sanitizeBakeFileStem(getBakeTargetName(nd, material, mesh));
                const key = `${stem}|${kind}`;
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push({
                    stem,
                    url: getBakeTextureUrl(nd, material, kind, mesh) || '',
                });
                if (rows.length >= limit) break;
            }
            return rows;
        }

        function renderBakeTargetPreview(rows) {
            if (!rows.length) return '';
            const html = rows.map(row => `
                <div class="bake-target-row">
                    <span class="bake-target-name">${escapeBakeHtml(row.stem)}</span>
                    <span class="bake-target-url">${escapeBakeHtml(row.url)}</span>
                </div>
            `).join('');
            return `<div class="bake-path-preview bake-target-list"><span class="bake-path-label">Targets</span>${html}</div>`;
        }

        function getAllBakeProxyTargets() {
            const rows = [];
            const seen = new Set();
            for (const mesh of deps.nodeMap.values()) {
                const nd = mesh?.userData?.maxjsLastNodePayload;
                if (!mesh?.isMesh || !nd) continue;
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const material of materials) {
                    const stem = sanitizeBakeFileStem(getBakeTargetName(nd, material, mesh));
                    const candidates = getBakeTextureCandidates(nd, material, 'beauty', mesh, 'exr')
                        .filter(candidate => hasGeometryMaxMapChannel(mesh.geometry, candidate.maxMapChannel));
                    for (const candidate of candidates) {
                        const filename = candidate.filename.replace(/\.[^./\\]+$/, '.png');
                        if (seen.has(filename)) continue;
                        seen.add(filename);
                        rows.push({
                            stem,
                            filename,
                            sourceUrl: candidate.url,
                        });
                    }
                }
            }
            rows.sort((a, b) => {
                const knownA = /^(containers?_main|containers?_bg|ground_main|ground_bg|character|bg)$/i.test(a.stem);
                const knownB = /^(containers?_main|containers?_bg|ground_main|ground_bg|character|bg)$/i.test(b.stem);
                if (knownA !== knownB) return knownA ? -1 : 1;
                return a.stem.localeCompare(b.stem, undefined, { sensitivity: 'base' });
            });
            return rows;
        }

        function loadProxySourceTexture(url) {
            return new Promise((resolve, reject) => {
                const ext = getTextureExtension(url);
                const loader = ext === 'exr'
                    ? exrLoader
                    : (ext === 'hdr' ? rgbeLoader : textureLoader);
                loader.load(
                    url,
                    texture => {
                        texture.colorSpace = colorSpaceForTextureExtension(ext, THREE.SRGBColorSpace);
                        texture.needsUpdate = true;
                        resolve(texture);
                    },
                    undefined,
                    error => reject(error || new Error(`Failed to load ${url}`)),
                );
            });
        }

        function cloneProxyTextureForWebGL(texture) {
            if (!texture?.isTexture) return null;
            let result = null;
            if (texture.isDataTexture && texture.image?.data) {
                const image = texture.image;
                result = new THREE_STD.DataTexture(
                    image.data,
                    image.width,
                    image.height,
                    texture.format,
                    texture.type,
                );
                result.unpackAlignment = texture.unpackAlignment;
            } else if (texture.image) {
                result = new THREE_STD.Texture(texture.image);
            }
            if (!result) return null;
            result.colorSpace = texture.colorSpace;
            result.flipY = texture.flipY;
            result.wrapS = result.wrapT = THREE_STD.ClampToEdgeWrapping;
            result.minFilter = THREE_STD.LinearFilter;
            result.magFilter = THREE_STD.LinearFilter;
            result.generateMipmaps = false;
            result.channel = 0;
            result.needsUpdate = true;
            return result;
        }

        let bakeProxyRenderer = null;
        const BAKE_PROXY_MAX_SOURCE_DIMENSION = 8192;
        function getBakeProxyRenderer() {
            if (bakeProxyRenderer) return bakeProxyRenderer;
            bakeProxyRenderer = new THREE_STD.WebGLRenderer({
                antialias: false,
                alpha: false,
                premultipliedAlpha: false,
                preserveDrawingBuffer: false,
            });
            bakeProxyRenderer.outputColorSpace = THREE_STD.SRGBColorSpace;
            bakeProxyRenderer.setPixelRatio(1);
            return bakeProxyRenderer;
        }

        function stdToneMappingForCurrentMode() {
            return {
                None: THREE_STD.NoToneMapping,
                Linear: THREE_STD.LinearToneMapping,
                Reinhard: THREE_STD.ReinhardToneMapping,
                Cineon: THREE_STD.CineonToneMapping,
                AgX: THREE_STD.AgXToneMapping,
                Neutral: THREE_STD.NeutralToneMapping,
            }[deps.currentToneMapping] ?? THREE_STD.NeutralToneMapping;
        }

        async function renderBakeTextureProxy(target) {
            const source = await loadProxySourceTexture(target.sourceUrl);
            const image = source.image || {};
            const sourceWidth = Math.max(1, Number(image.width) || 1);
            const sourceHeight = Math.max(1, Number(image.height) || 1);
            const width = Math.round(sourceWidth);
            const height = Math.round(sourceHeight);
            if (width > BAKE_PROXY_MAX_SOURCE_DIMENSION || height > BAKE_PROXY_MAX_SOURCE_DIMENSION) {
                throw new Error(`Bake proxy source is ${width}x${height}; PNG proxy export preserves source size and supports up to ${BAKE_PROXY_MAX_SOURCE_DIMENSION}px per side`);
            }

            const proxyTexture = cloneProxyTextureForWebGL(source);
            if (!proxyTexture) throw new Error(`Unsupported proxy source texture: ${target.sourceUrl}`);

            const rendererProxy = getBakeProxyRenderer();
            const previousTarget = rendererProxy.getRenderTarget();
            const previousToneMapping = rendererProxy.toneMapping;
            const previousExposure = rendererProxy.toneMappingExposure;
            const previousOutputColorSpace = rendererProxy.outputColorSpace;
            rendererProxy.setSize(width, height, false);
            rendererProxy.outputColorSpace = THREE_STD.SRGBColorSpace;
            rendererProxy.toneMapping = stdToneMappingForCurrentMode();
            rendererProxy.toneMappingExposure = deps.currentExposure;

            const sceneProxy = new THREE_STD.Scene();
            const cameraProxy = new THREE_STD.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            const exposureScale = bakeExposureScale();
            const materialProxy = new THREE_STD.MeshBasicMaterial({
                color: new THREE_STD.Color(exposureScale, exposureScale, exposureScale),
                map: proxyTexture,
                toneMapped: true,
            });
            const meshProxy = new THREE_STD.Mesh(new THREE_STD.PlaneGeometry(2, 2), materialProxy);
            sceneProxy.add(meshProxy);

            const renderTarget = new THREE_STD.WebGLRenderTarget(width, height, {
                format: THREE_STD.RGBAFormat,
                type: THREE_STD.UnsignedByteType,
                depthBuffer: false,
                stencilBuffer: false,
            });
            renderTarget.texture.colorSpace = THREE_STD.SRGBColorSpace;

            try {
                rendererProxy.setRenderTarget(renderTarget);
                rendererProxy.clear(true, true, true);
                rendererProxy.render(sceneProxy, cameraProxy);
                const rgba = new Uint8Array(width * height * 4);
                rendererProxy.readRenderTargetPixels(renderTarget, 0, 0, width, height, rgba);
                const rgb = new Uint8Array(width * height * 3);
                for (let y = 0; y < height; y++) {
                    const srcRow = height - 1 - y;
                    for (let x = 0; x < width; x++) {
                        const src = (srcRow * width + x) * 4;
                        const dst = (y * width + x) * 3;
                        rgb[dst + 0] = rgba[src + 0];
                        rgb[dst + 1] = rgba[src + 1];
                        rgb[dst + 2] = rgba[src + 2];
                    }
                }
                return { width, height, rgb };
            } finally {
                rendererProxy.setRenderTarget(previousTarget);
                rendererProxy.toneMapping = previousToneMapping;
                rendererProxy.toneMappingExposure = previousExposure;
                rendererProxy.outputColorSpace = previousOutputColorSpace;
                renderTarget.dispose();
                materialProxy.dispose();
                meshProxy.geometry.dispose();
                proxyTexture.dispose?.();
                source.dispose?.();
            }
        }

        let bakeProxyExportActive = false;
        async function encodeBeautyBakeProxyMaps() {
            if (bakeProxyExportActive) return;
            if (!window.chrome?.webview) {
                reportBridgeError('bake proxy encode', 'Available only inside max.js');
                return;
            }
            const current = bakePanelVisible ? readBakeStateFromPanel() : deps.bakeOverrides;
            if (current.mode !== 'beauty') {
                reportBridgeError('bake proxy encode', 'Switch Bake Overrides mode to Beauty first');
                return;
            }
            if (!current.folder) {
                reportBridgeError('bake proxy encode', 'Set a bake folder first');
                return;
            }

            applyBakeState(current, { persist: true, rebuild: true, refreshPanel: false, force: true });
            const targets = getAllBakeProxyTargets();
            if (targets.length === 0) {
                reportBridgeError('bake proxy encode', 'No UV1/UV2 beauty bake targets found');
                return;
            }

            bakeProxyExportActive = true;
            if (bakePanelVisible) rebuildBakePanel();
            try {
                let written = 0;
                let skipped = 0;
                for (let i = 0; i < targets.length; i++) {
                    const target = targets[i];
                    deps.perfHud.setStatus(`max.js - encoding beauty proxy ${i + 1}/${targets.length}: ${target.filename}`);
                    try {
                        const rendered = await renderBakeTextureProxy(target);
                        await requestHostAction('bake_proxy_image_write', {
                            folder: current.folder,
                            filename: target.filename,
                            width: rendered.width,
                            height: rendered.height,
                            rgbBase64: bytesToBase64(rendered.rgb),
                        }, 120000);
                        written++;
                    } catch (error) {
                        skipped++;
                        maxjsDebugWarn(
                            `[max.js bake proxy] skipped ${target.filename} from ${target.sourceUrl}:`,
                            error,
                        );
                    }
                }
                if (written <= 0) {
                    throw new Error(`No beauty proxy maps were written (${skipped} skipped)`);
                }

                applyBakeState({ ...deps.bakeOverrides, extension: 'png', proxyDisplay: true }, {
                    persist: true,
                    rebuild: true,
                    refreshPanel: true,
                    force: true,
                });
                deps.perfHud.setStatus(`max.js - encoded ${written} display-baked PNG beauty proxies${skipped ? ` (${skipped} skipped)` : ''}`);
            } catch (error) {
                reportBridgeError('bake proxy encode', error);
            } finally {
                bakeProxyExportActive = false;
                if (bakePanelVisible) rebuildBakePanel();
            }
        }

        function isBakeTextInput(el) {
            return el?.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'text';
        }

        function updateBakeStateFromPanel(event) {
            const next = readBakeStateFromPanel();
            updateBakePanelPreview(next);
            if (event?.type === 'input' && isBakeTextInput(event.target)) return;
            applyBakeState(next, { persist: true, rebuild: true, refreshPanel: false });
        }

        function rebuildBakePanel() {
            const b = normalizeBakeState(deps.bakeOverrides);
            const stats = getBakeSceneStats();
            const sampleLight = getBakeTextureUrl({ n: 'ObjectName', h: 0 }, null, 'lightmap') || 'Set a folder to preview path';
            const sampleBeauty = getBakeTextureUrl({ n: 'ObjectName', h: 0 }, null, 'beauty') || 'Set a folder to preview path';
            const targetRows = getBakeTargetPreviewRows();
            const targetPreview = renderBakeTargetPreview(targetRows);
            bakePanel.innerHTML = `
                <div class="sidepanel-header">
                    <div><div class="sidepanel-title">Bake Overrides</div>
                    <div class="sidepanel-subtitle">UV1/UV2 bake maps</div></div>
                    <button id="bake-hide" type="button">Hide</button>
                </div>
                <div class="sidepanel-body">
                    <section class="fx-section">
                        <div class="fx-section-title"><span>Runtime Bake Source</span></div>
                        <div class="bake-grid">
                            <label class="fx-check"><span>Enabled</span><input id="bake-enabled" type="checkbox" ${b.enabled ? 'checked' : ''}></label>
                            <label class="bake-field"><span>Mode</span><select id="bake-mode"><option value="lightmap"${b.mode === 'lightmap' ? ' selected' : ''}>Lightmap</option><option value="beauty"${b.mode === 'beauty' ? ' selected' : ''}>Beauty</option></select></label>
                            <label class="bake-field"><span>Match</span><select id="bake-match"><option value="scene"${b.match === 'scene' ? ' selected' : ''}>Scene atlas</option><option value="object"${b.match === 'object' ? ' selected' : ''}>Object name</option><option value="material"${b.match === 'material' ? ' selected' : ''}>Material name</option></select></label>
                            <label class="bake-field"><span>Folder</span><input id="bake-folder" type="text" value="${escapeBakeHtml(b.folder)}" placeholder="F:\\bakes\\ or ./bakes/"></label>
                        </div>
                    </section>
                    <section class="fx-section">
                        <div class="fx-section-title"><span>Naming</span></div>
                        <div class="bake-grid">
                            <label class="bake-field"><span>Scene Stem</span><input id="bake-scene" type="text" value="${escapeBakeHtml(b.sceneName)}"></label>
                            <label class="bake-field"><span>Light Suffix</span><input id="bake-light-suffix" type="text" value="${escapeBakeHtml(b.lightSuffix)}"></label>
                            <label class="bake-field"><span>Beauty Suffix</span><input id="bake-beauty-suffix" type="text" value="${escapeBakeHtml(b.beautySuffix)}"></label>
                            <label class="bake-field"><span>Ext</span><input id="bake-ext" type="text" value="${escapeBakeHtml(b.extension)}"></label>
                            <label class="bake-field"><span>Intensity</span><span class="bake-range"><input id="bake-intensity" class="fx-range" type="range" min="0" max="4" step="0.05" value="${b.intensity}"><span class="bake-value">${b.intensity.toFixed(2)}</span></span></label>
                            <label class="bake-field"><span>Exposure</span><span class="bake-range"><input id="bake-exposure" class="fx-range" type="range" min="-6" max="6" step="0.1" value="${b.bakeExposure}"><span class="bake-value">${b.bakeExposure >= 0 ? '+' : ''}${b.bakeExposure.toFixed(1)} EV</span></span></label>
                            <button id="bake-reset-look" class="bake-reset-look" type="button">Reset Look</button>
                        </div>
                    </section>
                    <section class="fx-section">
                        <div class="fx-section-title"><span>Status</span></div>
                        <div class="bake-status-row">
                            <div class="bake-stat"><span>Meshes</span><strong>${stats.meshes}</strong></div>
                            <div class="bake-stat"><span>UV1 Ready</span><strong>${stats.uv1}</strong></div>
                            <div class="bake-stat"><span>UV2 Ready</span><strong>${stats.uv2}</strong></div>
                        </div>
                        <div id="bake-light-preview" class="bake-path-preview"><span class="bake-path-label">Light</span>${escapeBakeHtml(sampleLight)}</div>
                        <div id="bake-beauty-preview" class="bake-path-preview"><span class="bake-path-label">Beauty</span>${escapeBakeHtml(sampleBeauty)}</div>
                        ${targetPreview}
                        <div class="bake-actions">
                            <button id="bake-reapply" type="button">Reapply</button>
                            <button id="bake-sync" type="button">Sync UV2</button>
                            <button id="bake-proxy" type="button" ${bakeProxyExportActive ? 'disabled' : ''}>Encode PNG Proxy</button>
                        </div>
                    </section>
                </div>`;
            bakePanel.querySelector('#bake-hide')?.addEventListener('click', () => setBakePanelVisible(false));
            bakePanel.querySelector('#bake-reset-look')?.addEventListener('click', () => {
                const intensity = bakePanel.querySelector('#bake-intensity');
                const exposure = bakePanel.querySelector('#bake-exposure');
                if (intensity) intensity.value = DEFAULT_BAKE_STATE.intensity;
                if (exposure) exposure.value = DEFAULT_BAKE_STATE.bakeExposure;
                const next = readBakeStateFromPanel();
                updateBakePanelPreview(next);
                applyBakeState(next, { persist: true, rebuild: true, refreshPanel: false, force: true });
            });
            bakePanel.querySelector('#bake-reapply')?.addEventListener('click', () => {
                clearBakeTextureLoadFailures();
                applyBakeState(readBakeStateFromPanel(), { persist: true, rebuild: true, refreshPanel: false, force: true });
                deps.perfHud.setStatus('max.js - bake overrides reapplied');
            });
            bakePanel.querySelector('#bake-sync')?.addEventListener('click', () => {
                lastBakeUv2RequestKey = '';
                deps.bridge.send('sync_lightmap_uvs', { reason: 'manual' });
                deps.perfHud.setStatus('max.js - requested full scene sync for UV2/lightmaps');
            });
            bakePanel.querySelector('#bake-proxy')?.addEventListener('click', () => {
                void encodeBeautyBakeProxyMaps();
            });
            for (const el of bakePanel.querySelectorAll('input,select')) {
                if (isBakeTextInput(el) || el.id === 'bake-intensity' || el.id === 'bake-exposure') {
                    el.addEventListener('input', updateBakeStateFromPanel);
                }
                el.addEventListener('change', updateBakeStateFromPanel);
            }
        }

        document.getElementById('btnBakeOverrides')?.addEventListener('click', () => {
            setBakePanelVisible(!bakePanelVisible);
        });


        return {
            normalizeBakeState,
            serializeBakeState,
            serializeSnapshotBakeState,
            bakeStateSignature,
            stripWrappingQuotes,
            encodeAssetPath,
            normalizeBakeFolderUrl,
            sanitizeBakeFileStem,
            getMaterialBakeName,
            getBakeTargetName,
            getBakeTextureUrl,
            bakeFilenameHasExplicitUvChannel,
            getBakeFilenameCandidates,
            getBakeTextureCandidates,
            hasGeometryUV2,
            getBakeMaxMapChannel,
            hasGeometryMaxMapChannel,
            restoreWebGpuLightMapUvContext,
            applyWebGpuLightMapUvContext,
            markBakeMissingUv,
            clearBakeMissingUv,
            maybeRequestBakeUv2Resync,
            createBeautyBakeMaterial,
            bakeOverrideOwnerKey,
            stampBakeOverrideOwner,
            ensureBakeOverrideMaterialInstance,
            applyBakeOverrideToMaterial,
            applyBakeOverridesToSceneMaterial,
            withBakePersistenceSuppressed,
            escapeBakeHtml,
            getBakeSceneStats,
            getBakeUv2RequirementStats,
            mutateLightmapBakeOnMaterial,
            reapplyBakeOverridesToScene,
            applyBakeState,
            saveBakeState,
            restoreBakeState,
            syncProjectBakeState,
            setBakePanelVisible,
            readBakeStateFromPanel,
            updateBakePanelPreview,
            getBakeTargetPreviewRows,
            renderBakeTargetPreview,
            getAllBakeProxyTargets,
            loadProxySourceTexture,
            cloneProxyTextureForWebGL,
            getBakeProxyRenderer,
            stdToneMappingForCurrentMode,
            renderBakeTextureProxy,
            encodeBeautyBakeProxyMaps,
            isBakeTextInput,
            updateBakeStateFromPanel,
            rebuildBakePanel,
        };
}

export { createBakeSystem };
