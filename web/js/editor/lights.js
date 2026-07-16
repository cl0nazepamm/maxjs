// lights.js - editor scene lights, light linking, helpers, and shadow-origin glue.
import * as THREE from 'three';
import {
    clearUnownedLightLinkMaterialObserver,
    getReflectionPaintNode,
    setLightLinkMaterialObserver,
    setLightLinkMaskDefaults,
} from '../max_lights_node.js';
import {
    createLightLinkMaskApplier,
    deserializeLightLinks,
    getByHandle,
    handleToken,
    normalizeLightLinkMode,
    serializeLightLinks,
} from '../light_linking_core.js';

function createLights(deps = {}) {
        const lightHelperMap = new Map();

        const lightTargetWorld = new THREE.Vector3();

        function setDefaultLightsVisible(visible) {
            const enabled = !deps.isPathTracingMode && !!visible;
            deps.defaultLights.visible = enabled;
            deps.defaultAmbient.visible = enabled;
            deps.defaultKey.visible = enabled;
            deps.defaultFill.visible = enabled;
        }

        // ── Lights Sync ──────────────────────────────────────
        const lightGroup = new THREE.Group();
        lightGroup.name = '__maxjs_lights';
        deps.maxRoot.add(lightGroup);
        const LIGHT_TYPES = ['DirectionalLight', 'PointLight', 'SpotLight', 'RectAreaLight', 'HemisphereLight', 'AmbientLight'];
        const shadowBounds = new THREE.Box3();
        const shadowCenter = new THREE.Vector3();
        const shadowSize = new THREE.Vector3();
        const shadowTarget = new THREE.Vector3();
        const shadowOriginScale = new THREE.Vector3();
        const shadowOriginDir = new THREE.Vector3();
        const shadowOriginLightPos = new THREE.Vector3();
        const lightLocalPos = new THREE.Vector3();
        const lightWorldPos = new THREE.Vector3();
        const lightTargetLocal = new THREE.Vector3();

        function isShadowMapOriginObject(object) {
            const name = String(object?.name || '');
            return /^(?:maxjs[\s_-]*)?(?:(?:shadow[\s_-]*map|shadowmap|shadow)[\s_-]*)origin(?:$|[\s_.:-])/i.test(name);
        }

        function getShadowMapOriginRadiusFromName(name) {
            const match = String(name || '').match(/(?:^|[\s_:-])(?:r|radius|size)?[\s_:=:-]*(\d+(?:\.\d+)?)(?:$|[\s_:-])/i);
            if (!match) return 0;
            const radius = Number(match[1]);
            return Number.isFinite(radius) && radius > 0 ? radius : 0;
        }

        function configureShadowMapOriginObject(object) {
            if (!object) return;
            object.userData ??= {};
            object.userData.maxjsShadowMapOrigin = true;
            object.userData.maxjsVisible = false;
            object.castShadow = false;
            object.receiveShadow = false;
            deps.setObjectSelfVisibleLayer(object, false);
        }

        function findShadowMapOriginObject() {
            for (const object of deps.nodeMap.values()) {
                if (!isShadowMapOriginObject(object)) continue;
                configureShadowMapOriginObject(object);
                return object;
            }
            return null;
        }

        function getShadowMapOriginFocus(object) {
            if (!object) return null;
            object.updateWorldMatrix(true, false);
            const nameRadius = getShadowMapOriginRadiusFromName(object.name);
            shadowBounds.makeEmpty();
            if (object.isMesh || object.isLine || object.isLineSegments) {
                shadowBounds.setFromObject(object);
            }
            object.getWorldPosition(shadowCenter);

            let radius = nameRadius;
            if (!radius && !shadowBounds.isEmpty()) {
                shadowBounds.getCenter(shadowCenter);
                shadowBounds.getSize(shadowSize);
                radius = Math.max(shadowSize.x, shadowSize.y, shadowSize.z) * 0.5;
            }
            if (!radius) {
                object.getWorldScale(shadowOriginScale);
                radius = Math.max(shadowOriginScale.x, shadowOriginScale.y, shadowOriginScale.z, 50);
            }

            return {
                center: shadowCenter,
                radius: Math.max(radius, 1),
                explicit: true,
            };
        }

        function getShadowSceneFocus() {
            const origin = findShadowMapOriginObject();
            if (origin) return getShadowMapOriginFocus(origin);

            shadowBounds.makeEmpty();
            for (const [, mesh] of deps.nodeMap) {
                if (mesh?.userData?.maxjsShadowMapOrigin || isShadowMapOriginObject(mesh)) continue;
                if (!mesh?.isMesh || !mesh.visible) continue;
                shadowBounds.expandByObject(mesh);
            }

            if (shadowBounds.isEmpty()) {
                shadowBounds.min.set(-100, -100, -100);
                shadowBounds.max.set(100, 100, 100);
            }

            shadowBounds.getCenter(shadowCenter);
            shadowBounds.getSize(shadowSize);
            const radius = Math.max(shadowSize.x, shadowSize.y, shadowSize.z, 50);
            return { center: shadowCenter, radius, explicit: false };
        }

        function setObjectWorldPosition(object, worldPosition) {
            const parent = object?.parent;
            if (!object || !worldPosition) return;
            object.position.copy(worldPosition);
            if (parent) {
                parent.updateMatrixWorld(true);
                parent.worldToLocal(object.position);
            }
            object.updateMatrixWorld(true);
        }

        function applyDirectionalShadowOrigin(light, focus) {
            const target = light.userData?.maxjsTarget;
            if (!focus?.explicit || !target) return;

            light.getWorldPosition(lightWorldPos);
            target.getWorldPosition(shadowTarget);
            shadowOriginDir.subVectors(shadowTarget, lightWorldPos);
            if (shadowOriginDir.lengthSq() < 1e-8) return;
            shadowOriginDir.normalize();

            const distance = Math.max(focus.radius * 4, lightWorldPos.distanceTo(shadowTarget), 200);
            shadowOriginLightPos.copy(focus.center).addScaledVector(shadowOriginDir, -distance);
            setObjectWorldPosition(light, shadowOriginLightPos);
            setObjectWorldPosition(target, focus.center);
            shadowTarget.copy(focus.center);
        }

        function updateLightShadowCamera(light, ld) {
            if (!light?.shadow || !light.castShadow) return;

            const focus = getShadowSceneFocus();
            const { radius } = focus;
            const shadowCamera = light.shadow.camera;

            if (ld.type === 0 && shadowCamera?.isOrthographicCamera) {
                applyDirectionalShadowOrigin(light, focus);
                shadowCamera.left = -radius;
                shadowCamera.right = radius;
                shadowCamera.top = radius;
                shadowCamera.bottom = -radius;
                shadowCamera.near = 0.1;
                light.getWorldPosition(lightWorldPos);
                shadowCamera.far = Math.max(radius * 8, lightWorldPos.distanceTo(shadowTarget), 200);
                shadowCamera.updateProjectionMatrix();
            } else if (ld.type === 1 && shadowCamera?.isPerspectiveCamera) {
                shadowCamera.near = Math.max(radius * 0.01, 0.1);
                shadowCamera.far = ld.distance > 0 ? ld.distance : Math.max(radius * 6, 200);
                shadowCamera.updateProjectionMatrix();
            } else if (ld.type === 2 && shadowCamera?.isPerspectiveCamera) {
                shadowCamera.near = Math.max(radius * 0.01, 0.1);
                shadowCamera.far = ld.distance > 0 ? ld.distance : Math.max(radius * 6, 200);
                shadowCamera.fov = THREE.MathUtils.radToDeg((ld.angle ?? Math.PI / 4) * 2);
                shadowCamera.updateProjectionMatrix();
            }

            light.shadow.needsUpdate = true;
        }

        function createLightHelper(light, type) {
            let helper = null;
            const sz = 2;
            switch (type) {
            case 0: helper = new THREE.DirectionalLightHelper(light, sz); break;
            case 1: helper = new THREE.PointLightHelper(light, sz); break;
            case 2: helper = new THREE.SpotLightHelper(light); break;
            case 4: helper = new THREE.HemisphereLightHelper(light, sz); break;
            }
            if (helper) {
                helper.userData.maxjsExcludeFromRuntimeSnapshot = true;
                helper.visible = deps.lightHelpersVisible;
                lightGroup.add(helper);
            }
            return helper;
        }

        function clearLightHelpers() {
            for (const [, helper] of lightHelperMap) {
                if (helper.parent) helper.parent.remove(helper);
                helper.dispose?.();
            }
            lightHelperMap.clear();
        }

        function updateLightHelpers() {
            for (const [, helper] of lightHelperMap) {
                helper.update?.();
            }
        }

        function setLightHelpersVisible(v) {
            deps.lightHelpersVisible = !!v;
            for (const [, helper] of lightHelperMap) {
                helper.visible = deps.lightHelpersVisible;
            }
            const btn = document.getElementById('btnLightHelpers');
            if (btn) btn.classList.toggle('active', deps.lightHelpersVisible);
        }

        function clearLights() {
            clearLightHelpers();
            for (const [, light] of deps.lightHandleMap) {
                const target = light.userData?.maxjsTarget;
                if (target?.parent) target.parent.remove(target);
                if (light.parent) light.parent.remove(light);
                if (light.dispose) light.dispose();
            }
            deps.lightHandleMap.clear();
            while (lightGroup.children.length) {
                const c = lightGroup.children[0];
                lightGroup.remove(c);
                if (c.dispose) c.dispose();
            }
        }

        function getLightParentObject(light) {
            const parentHandle = Number(light?.userData?.maxjsParentHandle);
            const parent = Number.isFinite(parentHandle) && parentHandle > 0
                ? deps.nodeMap.get(parentHandle)
                : null;
            if (!parent || parent === light) return lightGroup;
            for (let cursor = parent; cursor; cursor = cursor.parent) {
                if (cursor === light) return lightGroup;
            }
            return parent;
        }

        function syncLightParent(light, ld) {
            if (!light) return lightGroup;
            light.userData ??= {};
            if (Object.prototype.hasOwnProperty.call(ld, 'p')) {
                const parentHandle = Number(ld.p);
                light.userData.maxjsParentHandle =
                    Number.isFinite(parentHandle) && parentHandle > 0 ? parentHandle : 0;
            } else {
                light.userData.maxjsParentHandle = Number(light.userData.maxjsParentHandle) || 0;
            }
            const parent = getLightParentObject(light);
            if (light.parent !== parent) parent.add(light);
            const target = light.userData.maxjsTarget;
            if (target && target.parent !== parent) parent.add(target);
            return parent;
        }

        function setLightPositionFromMaxRoot(light, pos) {
            if (!light || !Array.isArray(pos)) return;
            lightLocalPos.set(pos[0], pos[1], pos[2]);
            const parent = light.parent || lightGroup;
            if (parent !== lightGroup) {
                deps.maxRoot.updateMatrixWorld(true);
                parent.updateMatrixWorld(true);
                lightWorldPos.copy(lightLocalPos);
                deps.maxRoot.localToWorld(lightWorldPos);
                lightLocalPos.copy(lightWorldPos);
                parent.worldToLocal(lightLocalPos);
            }
            light.position.copy(lightLocalPos);
        }

        function setLightTargetFromData(light, ld) {
            const target = light.userData?.maxjsTarget;
            if (!target) return;
            // Fixed distance — three.js normalizes (target - position) internally,
            // only the direction matters here. Previously recomputed scene bounds
            // per call via getShadowSceneFocus(), which iterated every mesh and
            // hitched animation playback with parented lights.
            const targetDistance = 1000;
            lightTargetLocal.set(
                ld.pos[0] + ld.dir[0] * targetDistance,
                ld.pos[1] + ld.dir[1] * targetDistance,
                ld.pos[2] + ld.dir[2] * targetDistance
            );
            lightTargetWorld.copy(lightTargetLocal);
            deps.maxRoot.updateMatrixWorld(true);
            deps.maxRoot.localToWorld(lightTargetWorld);
            shadowTarget.copy(lightTargetWorld);

            const parent = target.parent || lightGroup;
            if (parent !== lightGroup) {
                parent.updateMatrixWorld(true);
                target.position.copy(lightTargetWorld);
                parent.worldToLocal(target.position);
            } else {
                target.position.copy(lightTargetLocal);
            }
            target.updateMatrixWorld();
        }

        // NIR emitter tagging for the spectral tracer (collectLights reads
        // userData.emitterClass / userData.colorTemp). Two Max-side channels:
        //   1. userProps string, if the sync carries it for lights:
        //      "emitterClass=ir" / "=led" / "=sodium" / "=incandescent",
        //      optional "colorTemp=2856".
        //   2. NAME tagging — works with the sync as-is: a light whose name
        //      contains "_ir"/"ir_", "_led", "_sodium"/"_lps", "_inc"/"_halogen"
        //      (case-insensitive) gets the class. Rename in Max → tagged.
        function applyLightEmitterClass(light, ld) {
            let cls;
            let temp;
            const props = typeof ld.userProps === 'string' ? ld.userProps : '';
            if (props) {
                const mc = /emitterClass\s*=\s*([a-z_]+)/i.exec(props);
                if (mc) cls = mc[1].toLowerCase();
                const mt = /colorTemp\s*=\s*([0-9.]+)/i.exec(props);
                if (mt) temp = Number(mt[1]);
            }
            if (!cls && light.name) {
                const n = `_${light.name.toLowerCase().replace(/[\s\-.]+/g, '_')}_`;
                if (/_ir_|_nir_|_illuminator_/.test(n)) cls = 'ir';
                else if (/_led_/.test(n)) cls = 'led';
                else if (/_sodium_|_lps_/.test(n)) cls = 'sodium';
                else if (/_inc_|_incandescent_|_halogen_|_tungsten_/.test(n)) cls = 'incandescent';
            }
            if (cls) light.userData.emitterClass = cls;
            else delete light.userData.emitterClass;
            if (Number.isFinite(temp)) light.userData.colorTemp = temp;
        }

        function applyLightData(light, ld) {
            light.userData ??= {};
            light.userData.maxjsTypeId = ld.type;
            if (ld.h != null) light.userData.maxjsHandle = ld.h;
            if (ld.name) light.name = ld.name;
            syncLightParent(light, ld);
            applyLightEmitterClass(light, ld);

            const isRuntimeOverridden = (property) =>
                ld.h != null && deps.layerManager.hasObjectPropertyOverride?.(ld.h, property) === true;

            const visible = ld.v == null ? true : !!ld.v;
            light.userData.maxjsVisible = visible;
            light.visible = true;
            light.layers?.set?.(visible ? 0 : deps.MAXJS_SELF_HIDDEN_LAYER);
            if (light.userData.maxjsTarget) light.userData.maxjsTarget.visible = true;

            if (light.color && Array.isArray(ld.color)) {
                light.color.setRGB(ld.color[0], ld.color[1], ld.color[2]);
            }
            if ('intensity' in light && Number.isFinite(ld.intensity)) {
                light.userData.maxjsAuthoredIntensity = ld.intensity;
                light.intensity = visible ? ld.intensity : 0;
            }
            if (Number.isFinite(ld.volContrib)) {
                light.userData.volContrib = ld.volContrib;
            } else {
                delete light.userData.volContrib;
            }

            switch (ld.type) {
            case 0:
                setLightPositionFromMaxRoot(light, ld.pos);
                setLightTargetFromData(light, ld);
                break;
            case 1:
                setLightPositionFromMaxRoot(light, ld.pos);
                light.distance = ld.distance || 0;
                light.decay = ld.decay ?? 2;
                break;
            case 2:
                setLightPositionFromMaxRoot(light, ld.pos);
                light.distance = ld.distance || 0;
                light.decay = ld.decay ?? 2;
                light.angle = ld.angle ?? Math.PI / 4;
                light.penumbra = ld.penumbra ?? 0.1;
                setLightTargetFromData(light, ld);
                break;
            case 3:
                setLightPositionFromMaxRoot(light, ld.pos);
                light.width = ld.width || 20;
                light.height = ld.height || 20;
                lightTargetLocal.set(
                    ld.pos[0] + ld.dir[0],
                    ld.pos[1] + ld.dir[1],
                    ld.pos[2] + ld.dir[2]
                );
                lightTargetWorld.copy(lightTargetLocal);
                deps.maxRoot.updateMatrixWorld(true);
                deps.maxRoot.localToWorld(lightTargetWorld);
                light.updateMatrixWorld(true);
                light.lookAt(lightTargetWorld);
                break;
            case 4:
                setLightPositionFromMaxRoot(light, ld.pos);
                light.groundColor.setRGB(
                    ld.groundColor?.[0] ?? 0.2666666667,
                    ld.groundColor?.[1] ?? 0.2666666667,
                    ld.groundColor?.[2] ?? 0.2666666667
                );
                break;
            case 5:
                break;
            }

            if (light.shadow) {
                light.castShadow = visible && !!ld.castShadow;
                if (light.castShadow) {
                    light.shadow.bias = ld.shadowBias ?? -0.0001;
                    light.shadow.radius = ld.shadowRadius ?? 1;
                    const mapSz = ld.shadowMapSize ?? 1024;
                    light.shadow.mapSize.set(mapSz, mapSz);
                    updateLightShadowCamera(light, ld);
                }
            }
            if (Object.prototype.hasOwnProperty.call(ld, 'map') && !isRuntimeOverridden('map')) {
                light.map = ld.map ?? null;
                light.needsUpdate = true;
            }
            if (ld.h != null) deps.layerManager.applyObjectPropertyOverrides?.(ld.h, light);
        }

        function createLightFromData(ld) {
            let light;
            switch (ld.type) {
            case 0:
                light = new THREE.DirectionalLight(0xffffff, 1);
                light.userData.maxjsTarget = light.target;
                lightGroup.add(light.target);
                break;
            case 1:
                light = new THREE.PointLight(0xffffff, 1, 0, 2);
                break;
            case 2:
                light = new THREE.SpotLight(0xffffff, 1, 0, Math.PI / 4, 0.1, 2);
                light.userData.maxjsTarget = light.target;
                lightGroup.add(light.target);
                break;
            case 3:
                light = new THREE.RectAreaLight(0xffffff, 1, ld.width || 20, ld.height || 20);
                break;
            case 4:
                light = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
                break;
            case 5:
                light = new THREE.AmbientLight(0xffffff, 1);
                break;
            default:
                return null;
            }

            applyLightData(light, ld);
            return light;
        }

        function finalizeLightState(lightsData) {
            let appliedLightCount = 0;
            let mainDirectionalLight = null;

            for (const ld of lightsData) {
                const light = createLightFromData(ld);
                if (!light) continue;
                if (!light.parent) lightGroup.add(light);
                if (ld.h != null) {
                    deps.lightHandleMap.set(ld.h, light);
                    const helper = createLightHelper(light, ld.type);
                    if (helper) lightHelperMap.set(ld.h, helper);
                    light.userData ??= {};
                    light.userData.maxjsLightId = -1;
                    light.userData.maxjsLightLinked = false;
                }
                if (light.userData?.maxjsVisible !== false) {
                    appliedLightCount++;
                    if (!mainDirectionalLight && ld.type === 0) mainDirectionalLight = light;
                }
            }

            deps.syncDefaultLightsVisibility();
            if (deps.maxjsFx.setMainLight) {
                deps.maxjsFx.setMainLight(mainDirectionalLight || (deps.defaultLights.visible ? deps.defaultKey : null));
            }
            deps.markLightProbeLightsDirty();
            deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
        }

        function sceneLightsSignature(lightsData) {
            return JSON.stringify(Array.isArray(lightsData) ? lightsData : []);
        }

        function applyLights(lightsData) {
            const signature = sceneLightsSignature(lightsData);
            if (signature === deps.lastLightsSignature) return false;
            clearLights();
            finalizeLightState(lightsData);
            lightLinking.reapply();
            deps.refreshSkyFromLinkedSun();
            deps.lastLightsSignature = signature;
            return true;
        }

        // ── Light Linking ────────────────────────────────────
        // Per-mesh 64-bit fast masks plus overflow links and per-material HDRI
        // intensity. Portable state is handle-first with legacy name fallback.

        const lightLinking = (() => {
            // lightHandle -> { mode: 'include'|'exclude', objects: Set<nodeHandle> }
            const links = new Map();
            const materialObserverOwner = {};
            const observedMaterials = new Set();
            let observerSweepSet = null;
            let observerSweepQueued = false;
            // materialName -> float (0..1+) HDRI intensity. Keyed by Max material
            // name so it survives handle churn and scene rebuilds.
            const envIntensityByName = new Map();
            const envBaseIntensityByMaterial = new WeakMap();

            function forEachRenderableMesh(fn) {
                const seen = new WeakSet();
                for (const [h, mesh] of deps.nodeMap) {
                    if (!mesh?.isMesh) continue;
                    seen.add(mesh);
                    fn(handleToken(h), mesh);
                }
                deps.scene?.traverse?.((mesh) => {
                    if (!mesh?.isMesh || seen.has(mesh)) return;
                    seen.add(mesh);
                    const handle = mesh.userData?.maxjsHandle
                        ?? mesh.userData?.maxjsSourceHandle
                        ?? mesh.userData?.maxjsSource
                        ?? '';
                    fn(handleToken(handle), mesh);
                });
            }

            function prepareMaterialObserver(material) {
                const materials = Array.isArray(material) ? material : [material];
                for (const entry of materials) {
                    if (!entry) continue;
                    observerSweepSet?.add(entry);
                    if (observedMaterials.has(entry)) continue;
                    observedMaterials.add(entry);
                    setLightLinkMaterialObserver(entry, true, materialObserverOwner);
                }
            }

            function releaseMaterialObservers() {
                for (const material of observedMaterials) {
                    setLightLinkMaterialObserver(material, false, materialObserverOwner);
                }
                observedMaterials.clear();
            }

            function queueMaterialObserverSweep() {
                if (observerSweepQueued) return;
                observerSweepQueued = true;
                queueMicrotask(() => {
                    observerSweepQueued = false;
                    if (!specializedLightingActive) return;
                    const currentMaterials = new Set();
                    observerSweepSet = currentMaterials;
                    forEachRenderableMesh((_handle, mesh) => prepareMaterialObserver(mesh.material));
                    observerSweepSet = null;
                    sweepMaterialObservers(currentMaterials);
                });
            }

            function replaceRenderableMaterial(_previous, next) {
                if (!specializedLightingActive) return;
                // A material can be shared by many renderables. Prepare the new
                // material immediately, then release only after a scene-wide
                // sweep proves the old material is no longer referenced.
                prepareMaterialObserver(next);
                queueMaterialObserverSweep();
            }

            function sweepMaterialObservers(currentMaterials) {
                for (const material of [...observedMaterials]) {
                    if (currentMaterials.has(material)) continue;
                    setLightLinkMaterialObserver(material, false, materialObserverOwner);
                    observedMaterials.delete(material);
                }
            }

            const maskApplier = createLightLinkMaskApplier({
                lightHandleMap: deps.lightHandleMap,
                forEachRenderableMesh,
                onPrepareMesh: (mesh) => prepareMaterialObserver(mesh.material),
                onOverflow: (overflowCount, activeCount) => {
                    console.warn(
                        `[max.js] ${activeCount} linked lights active; ${overflowCount} use the per-light fallback beyond the 64-light batched mask.`,
                    );
                },
            });
            let specializedLightingActive = false;

            function materialNameOf(material) {
                const value = String(
                    material?.userData?.maxjsSourceMaterialName ??
                    material?.name ??
                    ''
                ).trim();
                return value || 'default';
            }

            let lightingParamRefreshQueued = false;
            function notifyLightingParamChanged() {
                if (lightingParamRefreshQueued) return;
                lightingParamRefreshQueued = true;
                requestAnimationFrame(() => {
                    lightingParamRefreshQueued = false;
                    deps.maxjsFx.markOutputChanged?.();
                });
            }

            function lightHandleByName(name) {
                for (const [h, light] of deps.lightHandleMap) {
                    if (light.name === name) return handleToken(h);
                }
                return null;
            }
            function forEachMaterialByName(materialName, fn) {
                const seen = new Set();
                forEachRenderableMesh((_h, mesh) => {
                    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    for (const mat of materials) {
                        if (!mat || seen.has(mat)) continue;
                        seen.add(mat);
                        if (materialNameOf(mat) === materialName) fn(mat, mesh);
                    }
                });
            }

            function applyEnvIntensities() {
                if (envIntensityByName.size === 0) return;
                for (const [materialName, value] of envIntensityByName) {
                    forEachMaterialByName(materialName, (mat) => {
                        if (!envBaseIntensityByMaterial.has(mat)) {
                            envBaseIntensityByMaterial.set(
                                mat,
                                Number.isFinite(mat.envMapIntensity) ? mat.envMapIntensity : 1.0,
                            );
                        }
                        mat.envMapIntensity = value;
                    });
                }
            }

            function clearEnvIntensityOverrides() {
                for (const [materialName] of envIntensityByName) {
                    forEachMaterialByName(materialName, (mat) => {
                        const base = envBaseIntensityByMaterial.get(mat);
                        if (Number.isFinite(base)) mat.envMapIntensity = base;
                        envBaseIntensityByMaterial.delete(mat);
                    });
                }
                envIntensityByName.clear();
            }

            function reapply() {
                const linkedObjectHandles = new Set();
                for (const link of links.values()) {
                    for (const handle of link.objects) linkedObjectHandles.add(handleToken(handle));
                }
                const sceneTopologyChanged = deps.setLightLinkTargetHandles?.(linkedObjectHandles) === true;
                observerSweepSet = new Set();
                const maskState = maskApplier.apply(links);
                const currentObserverMaterials = observerSweepSet;
                observerSweepSet = null;
                if (maskState.activeCount === 0 && specializedLightingActive) {
                    releaseMaterialObservers();
                    forEachRenderableMesh((_handle, mesh) => {
                        clearUnownedLightLinkMaterialObserver(mesh.material);
                    });
                } else if (maskState.activeCount > 0) {
                    sweepMaterialObservers(currentObserverMaterials);
                }
                specializedLightingActive = maskState.activeCount > 0;
                if (specializedLightingActive && deps.isSimpleWebGLPipelineActive()) {
                    deps.restartWithRendererBackend?.('webgl-fallback', {
                        reason: 'light-linking-restore',
                        prompt: false,
                    });
                }
                if (specializedLightingActive && deps.isPathTracingMode) {
                    deps.setSpectralView?.('probes');
                }
                setLightLinkMaskDefaults(
                    deps.renderer,
                    maskState.defaultLo,
                    maskState.defaultHi,
                    maskState.generation,
                );
                applyEnvIntensities();
                window.__maxjsSyncSpectralViewUi?.();
                return { ...maskState, sceneTopologyChanged };
            }

            function notifyLightLinkTopologyChanged() {
                deps.maxjsFx.markSceneChanged?.();
                notifyLightingParamChanged();
            }

            function setLink(lightHandle, mode, objectHandles) {
                const lightKey = handleToken(lightHandle);
                const normalizedMode = normalizeLightLinkMode(mode);
                if (!normalizedMode) {
                    removeLink(lightHandle);
                    return;
                }
                const previous = links.get(lightKey);
                links.set(lightKey, {
                    mode: normalizedMode,
                    objects: new Set(Array.from(objectHandles ?? [], handleToken)),
                });
                const state = reapply();
                if (!previous || previous.mode !== normalizedMode || state.sceneTopologyChanged) {
                    notifyLightLinkTopologyChanged();
                }
                else notifyLightingParamChanged();
                save();
            }

            function removeLink(lightHandle) {
                const removed = links.delete(handleToken(lightHandle));
                reapply();
                if (removed) notifyLightLinkTopologyChanged();
                else notifyLightingParamChanged();
                save();
            }

            function getLink(lightHandle) {
                return links.get(handleToken(lightHandle)) || null;
            }

            function getAllLinks() { return links; }

            // Constrain-to-camera: HDRI rotation tracks camera yaw
            let hdriConstrainToCamera = false;
            let hdriBaseRotationY = 0;
            function getCameraYaw() {
                deps.camera.updateMatrixWorld(true);
                return Math.atan2(
                    deps.camera.matrixWorld.elements[8],
                    deps.camera.matrixWorld.elements[10]
                );
            }
            function getCameraWorldQuaternion(target = new THREE.Quaternion()) {
                deps.camera.updateMatrixWorld(true);
                return deps.camera.getWorldQuaternion(target);
            }
            function setHdriConstrainToCamera(v) {
                hdriConstrainToCamera = !!v;
                if (v) hdriBaseRotationY = deps.scene.environmentRotation.y + getCameraYaw();
                save();
            }
            function getHdriConstrainToCamera() { return hdriConstrainToCamera; }

            let reflectionPaintConstrainToCamera = false;
            const reflectionPaintCameraDirections = new Map();
            const constraintCameraQuat = new THREE.Quaternion();
            const constraintInverseQuat = new THREE.Quaternion();
            function vectorFromPlain(value) {
                if (value?.isVector3) return value.clone();
                if (Array.isArray(value) && value.length >= 3) {
                    return new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0);
                }
                if (value && typeof value === 'object') {
                    return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
                }
                return null;
            }
            function captureReflectionPaintCameraDirections(saved = null) {
                reflectionPaintCameraDirections.clear();
                const savedById = new Map();
                for (const item of (Array.isArray(saved) ? saved : [])) {
                    const id = Number(item?.id);
                    const direction = vectorFromPlain(item?.cameraDirection ?? item?.direction);
                    if (Number.isFinite(id) && direction) savedById.set(id, direction.normalize());
                }
                getCameraWorldQuaternion(constraintCameraQuat);
                constraintInverseQuat.copy(constraintCameraQuat).invert();
                for (const l of getReflectionPaintNode().getLights()) {
                    const savedDir = savedById.get(Number(l.id));
                    if (savedDir) {
                        reflectionPaintCameraDirections.set(Number(l.id), savedDir);
                        continue;
                    }
                    const worldDir = vectorFromPlain(l.direction);
                    if (!worldDir) continue;
                    reflectionPaintCameraDirections.set(
                        Number(l.id),
                        worldDir.normalize().applyQuaternion(constraintInverseQuat).normalize()
                    );
                }
            }
            function setReflectionPaintConstrainToCamera(v) {
                reflectionPaintConstrainToCamera = !!v;
                if (reflectionPaintConstrainToCamera) captureReflectionPaintCameraDirections();
                save({ flush: true });
            }
            function getReflectionPaintConstrainToCamera() { return reflectionPaintConstrainToCamera; }

            // Constrain-to-camera: per-light camera-relative offset
            // lightHandle -> { posOffset: Vector3, targetOffset: Vector3 }
            const lightCameraConstraints = new Map();
            const constraintWorldPos = new THREE.Vector3();
            function vectorFromArray(value) {
                return Array.isArray(value) && value.length >= 3
                    ? new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0)
                    : null;
            }
            function toCameraLocalOffset(worldPosition) {
                deps.camera.updateMatrixWorld(true);
                return deps.camera.worldToLocal(worldPosition.clone());
            }
            function applyWorldPosition(object, worldPosition) {
                if (!object) return;
                if (object.parent) {
                    object.parent.updateMatrixWorld(true);
                    object.position.copy(object.parent.worldToLocal(worldPosition.clone()));
                } else {
                    object.position.copy(worldPosition);
                }
                object.updateMatrixWorld(true);
            }
            function buildCameraConstraintForLight(lightHandle, saved = null) {
                const light = getByHandle(deps.lightHandleMap, lightHandle);
                if (!light) return null;
                light.updateMatrixWorld(true);
                const posOffset = vectorFromArray(saved?.posOffset)
                    || toCameraLocalOffset(light.getWorldPosition(new THREE.Vector3()));
                let targetOffset = vectorFromArray(saved?.targetOffset ?? saved?.dirOffset);
                const target = light.userData?.maxjsTarget || light.target;
                if (!targetOffset && target) {
                    target.updateMatrixWorld(true);
                    targetOffset = toCameraLocalOffset(target.getWorldPosition(new THREE.Vector3()));
                }
                return { posOffset, targetOffset };
            }
            function setLightConstrainToCamera(lightHandle, enabled) {
                const lightKey = handleToken(lightHandle);
                if (enabled) {
                    const constraint = buildCameraConstraintForLight(lightHandle);
                    if (!constraint) return;
                    lightCameraConstraints.set(lightKey, constraint);
                } else {
                    lightCameraConstraints.delete(lightKey);
                }
                save();
            }
            function getLightConstrainToCamera(lightHandle) {
                return lightCameraConstraints.has(handleToken(lightHandle));
            }

            // Called each frame from renderFrame — updates constrained transforms.
            function updateCameraConstraints() {
                if (hdriConstrainToCamera) {
                    const camYaw = getCameraYaw();
                    deps.scene.environmentRotation.y = hdriBaseRotationY - camYaw;
                    deps.scene.backgroundRotation.y = hdriBaseRotationY - camYaw;
                }
                if (reflectionPaintConstrainToCamera) {
                    getCameraWorldQuaternion(constraintCameraQuat);
                    const paint = getReflectionPaintNode();
                    const liveIds = new Set();
                    for (const l of paint.getLights()) {
                        const id = Number(l.id);
                        liveIds.add(id);
                        let localDir = reflectionPaintCameraDirections.get(id);
                        if (!localDir) {
                            const worldDir = vectorFromPlain(l.direction);
                            if (!worldDir) continue;
                            constraintInverseQuat.copy(constraintCameraQuat).invert();
                            localDir = worldDir.normalize().applyQuaternion(constraintInverseQuat).normalize();
                            reflectionPaintCameraDirections.set(id, localDir);
                        }
                        paint.updateLight(id, {
                            direction: localDir.clone().applyQuaternion(constraintCameraQuat).normalize(),
                        });
                    }
                    for (const id of reflectionPaintCameraDirections.keys()) {
                        if (!liveIds.has(id)) reflectionPaintCameraDirections.delete(id);
                    }
                    notifyLightingParamChanged();
                }
                if (lightCameraConstraints.size === 0) return;
                deps.camera.updateMatrixWorld(true);
                for (const [lh, c] of lightCameraConstraints) {
                    const light = getByHandle(deps.lightHandleMap, lh);
                    if (!light) continue;
                    applyWorldPosition(light, deps.camera.localToWorld(constraintWorldPos.copy(c.posOffset)));
                    if (c.targetOffset) {
                        const target = light.userData?.maxjsTarget || light.target;
                        if (target) {
                            applyWorldPosition(target, deps.camera.localToWorld(constraintWorldPos.copy(c.targetOffset)));
                        }
                    }
                }
            }

            function setEnvIntensity(materialName, value) {
                if (!materialName) return;
                const v = Number.isFinite(value) ? value : 1.0;
                if (v !== 1.0) envIntensityByName.set(materialName, v);
                else envIntensityByName.delete(materialName);
                let touched = false;
                forEachMaterialByName(materialName, (mat) => {
                    if (!envBaseIntensityByMaterial.has(mat)) {
                        envBaseIntensityByMaterial.set(
                            mat,
                            Number.isFinite(mat.envMapIntensity) ? mat.envMapIntensity : 1.0,
                        );
                    }
                    if (v !== 1.0) {
                        mat.envMapIntensity = v;
                    } else {
                        const base = envBaseIntensityByMaterial.get(mat);
                        if (Number.isFinite(base)) mat.envMapIntensity = base;
                        envBaseIntensityByMaterial.delete(mat);
                    }
                    touched = true;
                });
                if (touched) notifyLightingParamChanged();
                save();
            }

            function getEnvIntensity(materialName) {
                const v = envIntensityByName.get(materialName);
                return (typeof v === 'number') ? v : 1.0;
            }

            function setReflectionPaintIntensity(value) {
                const paint = getReflectionPaintNode();
                const wasActive = paint.active;
                const v = Number.isFinite(value) ? Math.max(0, value) : 1.0;
                paint.setGlobalIntensity(v);
                if (wasActive !== paint.active) notifyLightLinkTopologyChanged();
                else notifyLightingParamChanged();
                save();
            }

            function getReflectionPaintIntensity() {
                return getReflectionPaintNode().getGlobalIntensity();
            }

            function serialize() {
                const data = {
                    ...serializeLightLinks(links, {
                        lightHandleMap: deps.lightHandleMap,
                        nodeMap: deps.nodeMap,
                    }),
                    env: {},
                    constrain: {},
                };
                data.reflectionPaintIntensity = getReflectionPaintIntensity();
                data.constrain.hdri = hdriConstrainToCamera;
                data.constrain.reflectionPaint = reflectionPaintConstrainToCamera;
                if (reflectionPaintCameraDirections.size > 0) {
                    data.constrain.reflectionPaintDirections = [...reflectionPaintCameraDirections].map(([id, direction]) => ({
                        id,
                        cameraDirection: direction.toArray(),
                    }));
                }
                const constrainedLightNames = [];
                const constrainedLights = [];
                for (const [lh, constraint] of lightCameraConstraints) {
                    const n = getByHandle(deps.lightHandleMap, lh)?.name;
                    if (!n) continue;
                    constrainedLightNames.push(n);
                    constrainedLights.push({
                        name: n,
                        posOffset: constraint.posOffset.toArray(),
                        targetOffset: constraint.targetOffset ? constraint.targetOffset.toArray() : null,
                    });
                }
                if (constrainedLightNames.length) {
                    data.constrain.lights = constrainedLightNames;
                    data.constrain.lightOffsets = constrainedLights;
                }
                for (const [materialName, v] of envIntensityByName) {
                    data.env[materialName] = v;
                }
                return data;
            }

            function save(options = {}) {
                deps.saveStudioState(options);
            }

            function readLegacyStorage() {
                try {
                    const raw = localStorage.getItem(deps.LIGHT_LINK_STORAGE_KEY);
                    return raw ? JSON.parse(raw) : null;
                } catch {
                    return null;
                }
            }

            function applyPayload(data, options = {}) {
                try {
                    const hadSpecializedLighting = specializedLightingActive;
                    links.clear();
                    clearEnvIntensityOverrides();
                    lightCameraConstraints.clear();
                    if (!data || typeof data !== 'object') {
                        const state = reapply();
                        if (hadSpecializedLighting || state.sceneTopologyChanged) {
                            notifyLightLinkTopologyChanged();
                        }
                        return;
                    }
                    const rawEnv = data.env || {};
                    const restoredLinks = deserializeLightLinks(data, {
                        lightHandleMap: deps.lightHandleMap,
                        nodeMap: deps.nodeMap,
                    });
                    for (const [lightHandle, link] of restoredLinks) {
                        links.set(lightHandle, link);
                    }
                    for (const [materialName, v] of Object.entries(rawEnv)) {
                        if (Number.isFinite(v)) envIntensityByName.set(materialName, v);
                    }
                    const rawConstrain = data.constrain || {};
                    hdriConstrainToCamera = !!rawConstrain.hdri;
                    if (hdriConstrainToCamera) hdriBaseRotationY = deps.scene.environmentRotation.y + getCameraYaw();
                    reflectionPaintConstrainToCamera = !!rawConstrain.reflectionPaint;
                    if (reflectionPaintConstrainToCamera) {
                        captureReflectionPaintCameraDirections(rawConstrain.reflectionPaintDirections);
                    }
                    const lightConstraints = Array.isArray(rawConstrain.lightOffsets)
                        ? rawConstrain.lightOffsets
                        : (rawConstrain.lights || []).map(name => ({ name }));
                    for (const item of lightConstraints) {
                        const lName = typeof item === 'string' ? item : item?.name;
                        const lh = lightHandleByName(lName);
                        if (lh == null) continue;
                        const constraint = buildCameraConstraintForLight(lh, item);
                        if (constraint) lightCameraConstraints.set(handleToken(lh), constraint);
                    }
                    if (options.applyReflectionPaintIntensity !== false && Number.isFinite(data.reflectionPaintIntensity)) {
                        getReflectionPaintNode().setGlobalIntensity(data.reflectionPaintIntensity);
                    }
                    const state = reapply();
                    if (hadSpecializedLighting || state.activeCount > 0 || state.sceneTopologyChanged) {
                        notifyLightLinkTopologyChanged();
                    }
                } catch {}
            }

            function restoreFromStorage() {
                applyPayload(readLegacyStorage());
            }

            return {
                reapply, serialize, applyPayload, restoreFromStorage,
                prepareRenderableMaterial: (material) => {
                    if (specializedLightingActive) prepareMaterialObserver(material);
                },
                replaceRenderableMaterial,
                refreshSceneBindings: () => {
                    const state = reapply();
                    if (state.sceneTopologyChanged) notifyLightLinkTopologyChanged();
                    else notifyLightingParamChanged();
                },
                setLink, removeLink, getLink, getAllLinks,
                hasLinks: () => links.size > 0,
                hasActiveLinks: () => specializedLightingActive,
                hasPortableState: () => links.size > 0
                    || envIntensityByName.size > 0
                    || lightCameraConstraints.size > 0
                    || hdriConstrainToCamera
                    || reflectionPaintConstrainToCamera,
                setEnvIntensity, getEnvIntensity,
                setReflectionPaintIntensity, getReflectionPaintIntensity,
                setHdriConstrainToCamera, getHdriConstrainToCamera,
                setReflectionPaintConstrainToCamera, getReflectionPaintConstrainToCamera,
                captureReflectionPaintCameraDirections,
                setLightConstrainToCamera, getLightConstrainToCamera,
                updateCameraConstraints,
            };
        })();

        // ── Light Linking Panel UI ───────────────────────────
        const lightLinkPanel = document.getElementById('lightLinkPanel');
        let lightLinkPanelSelectedTarget = '';

        function setLightLinkPanelVisible(v) {
            deps.lightLinkPanelVisible = !!v;
            lightLinkPanel.classList.toggle('visible', deps.lightLinkPanelVisible);
            lightLinkPanel.toggleAttribute('inert', !deps.lightLinkPanelVisible);
            lightLinkPanel.setAttribute('aria-hidden', String(!deps.lightLinkPanelVisible));
            document.getElementById('btnLightLink').classList.toggle('active', deps.lightLinkPanelVisible);
            if (deps.lightLinkPanelVisible) rebuildLightLinkPanel();
        }

        function rebuildLightLinkPanel(preferredTarget = '') {
            const previousTarget = preferredTarget
                || lightLinkPanelSelectedTarget
                || document.getElementById('ll-light-sel')?.value
                || '';
            const collectSliderMaterials = () => {
                const names = new Set();
                const items = [];
                for (const [, mesh] of deps.nodeMap) {
                    if (!mesh?.isMesh) continue;
                    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    for (const material of materials) {
                        if (!material) continue;
                        const key = String(
                            material.userData?.maxjsSourceMaterialName ??
                            material.name ??
                            'default'
                        ).trim() || 'default';
                        if (names.has(key)) continue;
                        names.add(key);
                        items.push({ key, name: key });
                    }
                }
                items.sort((a, b) => a.name.localeCompare(b.name));
                return items;
            };
            const lights = [];
            for (const [h, light] of deps.lightHandleMap) {
                lights.push({ h, name: light.name || `Light ${h}`, type: light.type });
            }
            const nodes = [];
            for (const [h, mesh] of deps.nodeMap) {
                if (!mesh?.isMesh) continue;
                nodes.push({ h: String(h), name: mesh.name || `Object ${h}` });
            }
            nodes.sort((a, b) => a.name.localeCompare(b.name));

            let html = `<div class="sidepanel-header">` +
                `<div><div class="sidepanel-title">Light Linking</div>` +
                `<div class="sidepanel-subtitle">Mesh links, material intensity</div></div>` +
                `</div>` +
                `<div class="sidepanel-body" style="gap:6px;">`;

            const hdriAvailable = !!deps.scene.environment;
            const reflectionPaintAvailable = getReflectionPaintNode().count > 0;
            if (lights.length === 0 && !hdriAvailable && !reflectionPaintAvailable) {
                html += `<div style="color:#666;padding:8px 0;">No lights or HDRI in scene</div>`;
            } else {
                // Target selector: HDRI first, then individual lights.
                html += `<label style="font-size:10px;color:#888;">Target</label>`;
                html += `<select id="ll-light-sel" style="width:100%;background:#222;color:#ccc;border:1px solid #444;padding:3px;font-size:11px;">`;
                if (hdriAvailable) {
                    html += `<option value="__hdri__">HDRI (per-material intensity)</option>`;
                }
                for (const l of lights) {
                    html += `<option value="${l.h}">${l.name}</option>`;
                }
                if (reflectionPaintAvailable) {
                    html += `<option value="__rp__">Reflection Paint (global intensity)</option>`;
                }
                html += `</select>`;

                // Mode selector (hidden in HDRI mode)
                html += `<div id="ll-mode-row" style="display:flex;gap:4px;margin:4px 0;">`;
                html += `<button id="ll-mode-none" class="ll-mode active" style="flex:1;font-size:10px;padding:3px;">None</button>`;
                html += `<button id="ll-mode-include" class="ll-mode" style="flex:1;font-size:10px;padding:3px;">Include</button>`;
                html += `<button id="ll-mode-exclude" class="ll-mode" style="flex:1;font-size:10px;padding:3px;">Exclude</button>`;
                html += `</div>`;
                html += `<div id="ll-hdri-hint" style="display:none;font-size:10px;color:#888;margin:4px 0;">Drag sliders per material — 0 removes HDRI contribution, 1 = default.</div>`;
                html += `<label id="ll-constrain-row" style="display:none;font-size:10px;color:#aaa;margin:2px 0;cursor:pointer;gap:4px;align-items:center;">`;
                html += `<input type="checkbox" id="ll-constrain-cam" style="margin:0;accent-color:#e8e8e8;"> Constrain to Camera`;
                html += `</label>`;

                // Object list header
                html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">`;
                html += `<label id="ll-list-label" style="font-size:10px;color:#888;">Objects</label>`;
                html += `<div id="ll-bulk-btns" style="display:flex;gap:3px;">`;
                html += `<button id="ll-sel-all" style="font-size:9px;padding:1px 5px;">All</button>`;
                html += `<button id="ll-sel-none" style="font-size:9px;padding:1px 5px;">None</button>`;
                html += `</div></div>`;

                // Object list body — rendered fresh per-selection since items differ
                html += `<div id="ll-obj-list" style="max-height:300px;overflow-y:auto;border:1px solid #333;padding:2px;"></div>`;
            }
            html += `</div>`;
            lightLinkPanel.innerHTML = html;

            if (lights.length === 0 && !hdriAvailable && !reflectionPaintAvailable) return;

            const lightSel = document.getElementById('ll-light-sel');
            const modeRow = document.getElementById('ll-mode-row');
            const hdriHint = document.getElementById('ll-hdri-hint');
            const bulkBtns = document.getElementById('ll-bulk-btns');
            const modeNone = document.getElementById('ll-mode-none');
            const modeInclude = document.getElementById('ll-mode-include');
            const modeExclude = document.getElementById('ll-mode-exclude');
            const objList = document.getElementById('ll-obj-list');
            const listLabel = document.getElementById('ll-list-label');
            let sliderTargets = [];
            const availableTargetValues = new Set();
            if (hdriAvailable) availableTargetValues.add('__hdri__');
            for (const l of lights) availableTargetValues.add(String(l.h));
            if (reflectionPaintAvailable) availableTargetValues.add('__rp__');
            if (availableTargetValues.has(previousTarget)) {
                lightSel.value = previousTarget;
                lightLinkPanelSelectedTarget = previousTarget;
            } else {
                lightLinkPanelSelectedTarget = lightSel.value || '';
            }

            function isHdriMode() { return lightSel.value === '__hdri__'; }
            function isRpMode() { return lightSel.value === '__rp__'; }
            function isSliderMode() { return isHdriMode() || isRpMode(); }
            function getSelectedLight() {
                const v = lightSel.value;
                if (v === '__hdri__' || v === '__rp__') return v;
                return v;
            }

            function getMode() {
                if (modeInclude.classList.contains('active')) return 'include';
                if (modeExclude.classList.contains('active')) return 'exclude';
                return 'none';
            }

            function setActiveMode(mode) {
                modeNone.classList.toggle('active', mode === 'none');
                modeInclude.classList.toggle('active', mode === 'include');
                modeExclude.classList.toggle('active', mode === 'exclude');
                objList.style.opacity = mode === 'none' ? '0.3' : '1';
                objList.style.pointerEvents = mode === 'none' ? 'none' : 'auto';
            }

            function renderObjectList() {
                let inner = '';
                if (isRpMode()) {
                    const v = lightLinking.getReflectionPaintIntensity();
                    sliderTargets = [{ key: '__reflection_paint_global__', name: 'Global Intensity' }];
                    inner += `<div style="display:flex;align-items:center;gap:6px;padding:1px 2px;font-size:10px;">`;
                    inner += `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Global Intensity</span>`;
                    inner += `<input type="range" data-index="0" min="0" max="2" step="0.01" value="${v}" style="width:90px;accent-color:#e8e8e8;">`;
                    inner += `<span data-index="0" style="width:30px;text-align:right;color:#aaa;font-variant-numeric:tabular-nums;">${v.toFixed(2)}</span>`;
                    inner += `</div>`;
                } else if (isHdriMode()) {
                    sliderTargets = collectSliderMaterials();
                    const getV = (key) => lightLinking.getEnvIntensity(key);
                    for (let i = 0; i < sliderTargets.length; i++) {
                        const target = sliderTargets[i];
                        const v = getV(target.key);
                        inner += `<div style="display:flex;align-items:center;gap:6px;padding:1px 2px;font-size:10px;">`;
                        inner += `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${target.name}</span>`;
                        inner += `<input type="range" data-index="${i}" min="0" max="1" step="0.01" value="${v}" style="width:90px;accent-color:#e8e8e8;">`;
                        inner += `<span data-index="${i}" style="width:30px;text-align:right;color:#aaa;font-variant-numeric:tabular-nums;">${v.toFixed(2)}</span>`;
                        inner += `</div>`;
                    }
                } else {
                    sliderTargets = [];
                    for (const n of nodes) {
                        inner += `<label style="display:flex;align-items:center;gap:4px;padding:1px 2px;font-size:10px;cursor:pointer;">`;
                        inner += `<input type="checkbox" data-h="${n.h}" style="margin:0;accent-color:#e8e8e8;"> ${n.name}`;
                        inner += `</label>`;
                    }
                }
                objList.innerHTML = inner;
            }

            const constrainRow = document.getElementById('ll-constrain-row');
            const constrainCam = document.getElementById('ll-constrain-cam');

            function loadLightState() {
                const sel = getSelectedLight();
                if (isSliderMode()) {
                    modeRow.style.display = 'none';
                    hdriHint.style.display = '';
                    listLabel.textContent = isRpMode() ? 'Reflection Paint' : 'Materials';
                    hdriHint.textContent = isRpMode()
                        ? 'Global multiplier for the painted environment overlay.'
                        : 'Drag sliders per material \u2014 0 removes HDRI contribution, 1 = default.';
                    bulkBtns.style.display = 'none';
                    objList.style.opacity = '1';
                    objList.style.pointerEvents = 'auto';
                    constrainRow.style.display = 'flex';
                    constrainCam.checked = isRpMode()
                        ? lightLinking.getReflectionPaintConstrainToCamera()
                        : lightLinking.getHdriConstrainToCamera();
                    renderObjectList();
                    return;
                }
                modeRow.style.display = '';
                hdriHint.style.display = 'none';
                listLabel.textContent = 'Objects';
                bulkBtns.style.display = '';
                constrainRow.style.display = 'flex';
                constrainCam.checked = lightLinking.getLightConstrainToCamera(sel);
                renderObjectList();
                const lh = getSelectedLight();
                const link = lightLinking.getLink(lh);
                if (!link) {
                    setActiveMode('none');
                } else {
                    setActiveMode(link.mode);
                    for (const cb of objList.querySelectorAll('input[type=checkbox]')) {
                        cb.checked = link.objects.has(String(cb.dataset.h));
                    }
                }
            }

            function applyFromUI() {
                if (isSliderMode()) return; // sliders fire their own path
                const lh = getSelectedLight();
                const mode = getMode();
                if (mode === 'none') {
                    lightLinking.removeLink(lh);
                    return;
                }
                const objs = new Set();
                for (const cb of objList.querySelectorAll('input[type=checkbox]')) {
                    if (cb.checked) objs.add(String(cb.dataset.h));
                }
                lightLinking.setLink(lh, mode, objs);
            }

            lightSel.addEventListener('change', () => {
                lightLinkPanelSelectedTarget = lightSel.value;
                loadLightState();
            });

            modeNone.addEventListener('click', () => { setActiveMode('none'); applyFromUI(); });
            modeInclude.addEventListener('click', () => { setActiveMode('include'); applyFromUI(); });
            modeExclude.addEventListener('click', () => { setActiveMode('exclude'); applyFromUI(); });

            objList.addEventListener('input', (ev) => {
                if (!isSliderMode()) return;
                const tgt = ev.target;
                if (tgt?.type !== 'range') return;
                const index = Number.parseInt(tgt.dataset.index, 10);
                const target = sliderTargets[index];
                if (!target) return;
                const v = parseFloat(tgt.value);
                const lbl = tgt.parentElement?.querySelector('span[data-index]');
                if (lbl) lbl.textContent = v.toFixed(2);
                if (isRpMode()) lightLinking.setReflectionPaintIntensity(v);
                else lightLinking.setEnvIntensity(target.key, v);
            });
            objList.addEventListener('change', (ev) => {
                if (isSliderMode()) return;
                applyFromUI();
            });

            document.getElementById('ll-sel-all').addEventListener('click', () => {
                if (isSliderMode()) return;
                for (const cb of objList.querySelectorAll('input[type=checkbox]')) cb.checked = true;
                applyFromUI();
            });
            document.getElementById('ll-sel-none').addEventListener('click', () => {
                if (isSliderMode()) return;
                for (const cb of objList.querySelectorAll('input[type=checkbox]')) cb.checked = false;
                applyFromUI();
            });

            constrainCam.addEventListener('change', () => {
                const sel = getSelectedLight();
                if (isRpMode()) {
                    lightLinking.setReflectionPaintConstrainToCamera(constrainCam.checked);
                } else if (isHdriMode()) {
                    lightLinking.setHdriConstrainToCamera(constrainCam.checked);
                } else {
                    lightLinking.setLightConstrainToCamera(sel, constrainCam.checked);
                }
            });

            loadLightState();
        }

        document.getElementById('btnLightLink')?.addEventListener('click', () => {
            if (deps.isSimpleWebGLPipelineActive()) {
                deps.restartWithRendererBackend?.('webgl-fallback', {
                    reason: 'light-linking',
                    confirmMessage: 'Light Linking uses the max.js TSL lighting path. Restart in TSL_GL now?',
                });
                return;
            }
            if (deps.isPathTracingMode) {
                deps.setSpectralView?.('probes');
                deps.perfHud.setStatus('max.js - switched to the raster view for Light Linking');
            }
            setLightLinkPanelVisible(!deps.lightLinkPanelVisible);
        });

        function applyLightUpdates(lightsData) {
            if (!Array.isArray(lightsData)) return;
            deps.lastLightsSignature = '';

            let appliedLightCount = 0;
            let mainDirectionalLight = null;

            for (const ld of lightsData) {
                const light = deps.lightHandleMap.get(ld.h);
                if (!light || light.userData?.maxjsTypeId !== ld.type || light.type !== LIGHT_TYPES[ld.type]) {
                    applyLights(lightsData);
                    return;
                }

                applyLightData(light, ld);
                if (light.userData?.maxjsVisible !== false) {
                    appliedLightCount++;
                    if (!mainDirectionalLight && ld.type === 0) mainDirectionalLight = light;
                }
            }

            deps.syncDefaultLightsVisibility();
            if (deps.maxjsFx.setMainLight) {
                deps.maxjsFx.setMainLight(mainDirectionalLight || (deps.defaultLights.visible ? deps.defaultKey : null));
            }
            deps.refreshSkyFromLinkedSun();
            deps.markLightProbeLightsDirty();
            deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
        }

        return {
            setDefaultLightsVisible,
            isShadowMapOriginObject,
            getShadowMapOriginRadiusFromName,
            configureShadowMapOriginObject,
            findShadowMapOriginObject,
            getShadowMapOriginFocus,
            getShadowSceneFocus,
            setObjectWorldPosition,
            applyDirectionalShadowOrigin,
            updateLightShadowCamera,
            createLightHelper,
            clearLightHelpers,
            updateLightHelpers,
            setLightHelpersVisible,
            clearLights,
            getLightParentObject,
            syncLightParent,
            setLightPositionFromMaxRoot,
            setLightTargetFromData,
            applyLightEmitterClass,
            applyLightData,
            createLightFromData,
            finalizeLightState,
            sceneLightsSignature,
            applyLights,
            lightLinking,
            setLightLinkPanelVisible,
            rebuildLightLinkPanel,
            applyLightUpdates,
        };
}

export { createLights };
