// materials.js - editor material construction, registry, and lifecycle glue.
import * as THREE from 'three';
import { hashBlur } from 'three/addons/tsl/display/hashBlur.js';
import {
    color as tslColor,
    float as tslFloat,
    linearDepth,
    screenUV,
    texture as tslTexture,
    viewportLinearDepth,
    viewportSharedTexture,
} from 'three/tsl';
import {
    ensureGeometryUv0ForMaterial,
    normalScaleVectorFromDescriptor,
    shouldRouteBlackSpecularToLambert as shouldRouteBlackSpecularToLambertShared,
} from '../material_contract.js';
import { registerViewportNode } from '../fx/viewport_registry.js';

function createMaterials(deps = {}) {
        const {
            fallbackWhiteTexture,
            fallbackFlatNormalTexture,
            fallbackHeightTexture,
            fallbackToonGradientTexture,
            configureGradientTexture,
            textureWithUvChannel,
            resolveLightMapMaxMapChannel,
            createPendingMaterialXMaterial,
            ensureMaterialXTemplateLoaded,
            loadTexture,
            tslCompiler,
            HTML_TEXTURE_AUTO_FIT_KEYS,
            htmlTextureAutoFitEnabled,
            matrixScaleSignature,
            withHTMLAutoFitIdentity,
            loadMapSlot,
            applyOpacityTextureSlot,
            preserveOpacityForHTMLColorMap,
            wantsHTMLTextureOverrideMaterial,
            htmlTextureOverrideIdentity,
            createHTMLTextureOverrideMaterial,
        } = deps;
        const materialCache = new Map();
        const materialXTemplateCache = new Map();
        const materialRegistry = new Map();
        let nextMaterialRegistryId = 1;
        let materialRegistryFrame = 0;
        let materialRegistryStats = {
            uniqueMaterials: 0,
            materialTemplates: 0,
            materialRefs: 0,
            bucketedRefs: 0,
            instanceBuckets: 0,
            maxRefsPerMaterial: 0,
        };
        // ── Material Creation ───────────────────────────────
        function rememberMaterialEmissiveBase(material) {
            if (!material?.emissive) return;
            material.userData ??= {};
            material.userData.maxjsBaseEmissive = [
                material.emissive.r,
                material.emissive.g,
                material.emissive.b,
            ];
            material.userData.maxjsBaseEmissiveIntensity = Number.isFinite(material.emissiveIntensity)
                ? material.emissiveIntensity
                : 1.0;
        }

        function applyMaterialSelectionState(material, selected) {
            // Selection is now handled by outline post-processing pass
            // Just restore base emissive
            if (!material?.emissive) return;
            const base = material.userData?.maxjsBaseEmissive || [0, 0, 0];
            const baseIntensity = Number.isFinite(material.userData?.maxjsBaseEmissiveIntensity)
                ? material.userData.maxjsBaseEmissiveIntensity
                : 1.0;
            material.emissive.setRGB(base[0], base[1], base[2]);
            material.emissiveIntensity = baseIntensity;
        }

        function applyMeshShadowState(mesh) {
            if (!mesh?.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
        }

        function applyNodeProps(mesh, props) {
            if (!props) return;
            // Renderable toggle — works for both meshes and splines
            if (props.rend === 0) applyMaxObjectVisibility(mesh, false);
            if (!mesh?.isMesh) return;
            mesh.castShadow = props.cshadow !== 0;
            mesh.receiveShadow = props.rshadow !== 0;
            const side = props.bcull ? THREE.FrontSide : THREE.DoubleSide;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) {
                if (m && m.side !== side) m.side = side;
                if (!m) continue;
                if (props.opacity != null && props.opacity < 0.999) {
                    m.transparent = true;
                    m.opacity = props.opacity;
                } else if (m.userData?._propsOpacity) {
                    m.transparent = false;
                    m.opacity = 1.0;
                }
                if (!m.userData) m.userData = {};
                m.userData._propsOpacity = props.opacity != null && props.opacity < 0.999;
            }
        }

        function applyJsmodSyncState(mesh, enabled) {
            if (enabled) mesh.userData.jsmod = true;
            else delete mesh.userData.jsmod;
        }

        // Max user-defined properties (Object Properties → User Defined).
        // Full payloads omit the field when empty, so callers on full-sync
        // paths pass nd.userProps directly; partial paths guard on != null.
        function applyUserPropsSyncState(mesh, userProps) {
            if (typeof userProps === 'string' && userProps) mesh.userData.maxjsUserProps = userProps;
            else delete mesh.userData.maxjsUserProps;
        }

        function setObjectSelfVisibleLayer(object, visible) {
            if (!object?.layers?.set) return false;
            const layer = visible ? 0 : deps.MAXJS_SELF_HIDDEN_LAYER;
            const mask = 2 ** layer;
            if (object.layers.mask === mask) return false;
            object.layers.set(layer);
            return true;
        }

        function restoreRenderableMaterialVisibility(object) {
            const materials = Array.isArray(object?.material)
                ? object.material
                : (object?.material ? [object.material] : []);
            let changed = false;
            for (const material of materials) {
                if (!material) continue;
                if (material.visible !== true) {
                    material.visible = true;
                    changed = true;
                }
            }
            return changed;
        }

        function applyMaxObjectVisibility(object, visible) {
            if (!object) return false;
            object.userData ??= {};
            const next = visible !== false;
            let changed = object.userData.maxjsVisible !== next;
            object.userData.maxjsVisible = next;
            if (object.visible !== true) {
                object.visible = true;
                changed = true;
            }
            changed = setObjectSelfVisibleLayer(object, next) || changed;
            changed = restoreRenderableMaterialVisibility(object) || changed;
            return changed;
        }

        function applyBridgeVisibility(mesh, visibleFlag) {
            if (!mesh) return false;
            // three.js Deform meshes follow Max visibility like any other node
            // unless a layer explicitly owns their visibility (clone workflows
            // hiding the Max copy via node.hide()). In-place ctx.deform needs
            // no hide/unhide special-casing at all.
            if (mesh.userData.jsmod
                && (!deps.jsmodVisibilityOwnedByLayer || deps.jsmodVisibilityOwnedByLayer(mesh.userData.maxjsHandle))) return false;
            const visible = visibleFlag == null ? true : !!visibleFlag;
            return applyMaxObjectVisibility(mesh, visible);
        }

        function applyInstanceSyncState(mesh, instOfHandle) {
            if (!mesh) return;
            if (Number.isFinite(instOfHandle) && instOfHandle > 0) mesh.userData.maxjsInstOf = instOfHandle;
            else delete mesh.userData.maxjsInstOf;
        }

        function getSSSRoughnessInfluence(roughness) {
            const r = THREE.MathUtils.clamp(Number.isFinite(roughness) ? roughness : 0.5, 0, 1);
            return {
                attenuationScale: THREE.MathUtils.lerp(0.35, 1.0, r),
                powerScale: THREE.MathUtils.lerp(1.6, 0.55, r),
            };
        }

        function applySSSRoughnessInfluence(material, roughness) {
            if (!material || material.type !== 'MeshSSSNodeMaterial') return;
            const base = material.userData?.maxjsSSSBase || {};
            const baseAttenuation = Number.isFinite(base.attenuation) ? base.attenuation : 0.1;
            const basePower = Number.isFinite(base.power) ? base.power : 2.0;
            const influence = getSSSRoughnessInfluence(roughness);
            const nextAttenuation = baseAttenuation * influence.attenuationScale;
            const nextPower = Math.max(0.01, basePower * influence.powerScale);
            // This is reached from applyMaterialScalar, which runs on every delta
            // carrying nd.mat and on every frame of a material.roughness track.
            // Rebuilding two TSL nodes and bumping the version unconditionally
            // meant a node-graph recompile per delta on SSS materials — the
            // pipeline-churn shape that has frozen this viewer before. Only
            // touch the graph when the derived values actually move.
            material.userData ??= {};
            const applied = material.userData.maxjsSSSRoughnessApplied;
            if (applied
                && Math.abs(applied.attenuation - nextAttenuation) < 1e-6
                && Math.abs(applied.power - nextPower) < 1e-6) {
                return;
            }
            material.userData.maxjsSSSRoughnessApplied = { attenuation: nextAttenuation, power: nextPower };
            material.thicknessAttenuationNode = tslFloat(nextAttenuation);
            material.thicknessPowerNode = tslFloat(nextPower);
            material.needsUpdate = true;
        }

        function applySSSMaterialNodes(material, md) {
            if (!material || typeof material !== 'object') return;

            const sssColor = Array.isArray(md.sssColor) && md.sssColor.length === 3
                ? new THREE.Color(md.sssColor[0], md.sssColor[1], md.sssColor[2])
                : new THREE.Color(1, 1, 1);
            let thicknessColorNode = tslColor(sssColor);

            if (md.sssMap) {
                const sssMap = loadTexture(md.sssMap, THREE.SRGBColorSpace, md.sssMapXf, fallbackWhiteTexture);
                thicknessColorNode = tslTexture(sssMap).rgb.mul(thicknessColorNode);
            }

            material.thicknessColorNode = thicknessColorNode;
            material.thicknessDistortionNode = tslFloat(md.sssDistortion ?? 0.1);
            material.thicknessAmbientNode = tslFloat(md.sssAmbient ?? 0.0);
            material.thicknessScaleNode = tslFloat(md.sssScale ?? 10.0);
            material.userData ??= {};
            material.userData.maxjsSSSBase = {
                attenuation: md.sssAttenuation ?? 0.1,
                power: md.sssPower ?? 2.0,
            };
            applySSSRoughnessInfluence(material, md.rough ?? material.roughness ?? 0.5);
        }

        const utilityMaterialModels = new Set([

            'MeshDepthMaterial',
            'MeshBackdropNodeMaterial',
            'MeshLambertMaterial',
            'MeshMatcapMaterial',
            'MeshNormalMaterial',
            'MeshPhongMaterial',
        ]);

        function createBackdropUtilityMaterial(md) {
            const material = new THREE.MeshBasicNodeMaterial();
            const opacity = Math.min(1.0, Math.max(0.0, md.opacity ?? 1.0));
            const tintStrength = Math.max(0.0, md.mapS ?? 1.0);
            const blurStrength = Math.max(0.0, md.rough ?? 0.5);
            const pixelGrid = Math.max(8.0, (1.0 - Math.min(1.0, blurStrength)) * 128.0);
            const backdropMode = md.backdropMode ?? 0;
            const depthDistance = viewportLinearDepth.distance(linearDepth());
            const depthAlphaNode = depthDistance.oneMinus().smoothstep(0.90, 2.0).mul(10.0).saturate();
            const blurAmountNode = depthDistance.smoothstep(0.0, 0.6).mul(blurStrength * 40.0).clamp().mul(0.1);

            let tintNode = tslColor(new THREE.Color(md.color[0], md.color[1], md.color[2])).mul(tslFloat(tintStrength));
            let colorMapNode = null;

            if (md.map) {
                const tintMap = loadTexture(md.map, THREE.SRGBColorSpace, md.mapXf, fallbackWhiteTexture);
                colorMapNode = tslTexture(tintMap);
                tintNode = colorMapNode.rgb.mul(tintNode);
            }

            let flatOpacityNode = tslFloat(opacity);
            if (md.opMap) {
                const alphaMap = loadTexture(md.opMap, THREE.LinearSRGBColorSpace, md.opMapXf, fallbackWhiteTexture);
                flatOpacityNode = flatOpacityNode.mul(tslTexture(alphaMap).r.mul(tslFloat(md.opMapS ?? 1.0)));
            }
            const depthOpacityNode = depthAlphaNode.mul(flatOpacityNode);

            switch (backdropMode) {
            case 1:
                material.backdropNode = depthAlphaNode;
                material.opacityNode = depthOpacityNode;
                break;
            case 2:
                material.backdropNode = colorMapNode ? colorMapNode.rgb.mul(tslFloat(tintStrength)) : hashBlur(registerViewportNode(viewportSharedTexture()), tslFloat(0.05));
                material.opacityNode = colorMapNode ? flatOpacityNode.mul(colorMapNode.a) : flatOpacityNode;
                break;
            case 3:
                material.backdropNode = registerViewportNode(viewportSharedTexture(screenUV.mul(pixelGrid).floor().div(pixelGrid)));
                material.opacityNode = flatOpacityNode;
                break;
            case 0:
            default:
                // Frosted glass: depth-based blur + tint (matches webgpu_backdrop_area example)
                material.backdropNode = hashBlur(registerViewportNode(viewportSharedTexture()), blurAmountNode)
                    .add(depthAlphaNode.mix(tintNode.mul(0.3), 0));
                // No opacityNode — let backdropNode handle the compositing
                break;
            }
            material.side = md.side === 0 ? THREE.FrontSide : THREE.DoubleSide;
            material.transparent = true;
            material.depthWrite = false;
            return material;
        }

        // TSL coerce/buildTSLParams/compat-warn helpers moved to js/tsl_materials.js.

        function normalizeMaxVertexColorChannel(channel = 0) {
            if (typeof channel === 'string') {
                const token = channel.trim().toLowerCase();
                if (token === 'color' || token === 'rgb') return 0;
                if (token === 'shading' || token === 'illum' || token === 'illumination') return -1;
                if (token === 'alpha') return -2;
                const parsed = Number.parseInt(token, 10);
                if (Number.isFinite(parsed)) return parsed;
                return 0;
            }
            if (!Number.isFinite(channel)) return 0;
            return Math.trunc(channel);
        }

        function maxVertexColorAttributeName(channel = 0) {
            const normalized = normalizeMaxVertexColorChannel(channel);
            if (normalized === 0) return 'color';
            if (normalized === -1) return 'maxjs_vc_shading';
            if (normalized === -2) return 'maxjs_vc_alpha';
            return `maxjs_vc_${normalized}`;
        }

        // TSL compat-namespace + material builders moved to js/tsl_materials.js
        // (tslCompiler.createTSLMaterial / createMissingTSLMaterial).

        function createUtilityMaterial(runtimeModelName, md, materialContext = null) {
            if (runtimeModelName === 'MeshBackdropNodeMaterial') {
                return createBackdropUtilityMaterial(md);
            }

            let material;
            switch (runtimeModelName) {
            case 'MeshDepthMaterial':
                material = new THREE.MeshDepthMaterial();
                break;
            case 'MeshMatcapMaterial':
                material = new THREE.MeshMatcapMaterial();
                break;
            case 'MeshNormalMaterial':
                material = new THREE.MeshNormalMaterial();
                break;
            case 'MeshPhongMaterial':
                material = new THREE.MeshPhongMaterial();
                break;
            case 'MeshLambertMaterial':
            default:
                material = new THREE.MeshLambertMaterial();
                break;
            }

            material.side = md.side === 0 ? THREE.FrontSide : THREE.DoubleSide;
            material.opacity = md.opacity ?? 1.0;
            material.transparent = !!md.transparent || material.opacity < 0.999;
            if ('depthWrite' in material && md.depthWrite != null) material.depthWrite = !!md.depthWrite;
            if ('depthTest' in material && md.depthTest != null) material.depthTest = !!md.depthTest;
            if ('alphaTest' in material && Number.isFinite(md.alphaTest)) material.alphaTest = md.alphaTest;

            if ('color' in material && Array.isArray(md.color)) {
                material.color.setRGB(md.color[0], md.color[1], md.color[2]);
            }
            if ('emissive' in material) {
                if (Array.isArray(md.em)) {
                    material.emissive.setRGB(md.em[0], md.em[1], md.em[2]);
                }
                material.emissiveIntensity = md.emI ?? material.emissiveIntensity ?? 1.0;
            }
            if ('envMapIntensity' in material && md.envI != null) material.envMapIntensity = md.envI;
            if ('reflectivity' in material && md.reflectivity != null) material.reflectivity = md.reflectivity;
            if ('refractionRatio' in material && md.refractionRatio != null) material.refractionRatio = md.refractionRatio;
            if ('flatShading' in material) material.flatShading = !!md.flat;
            if ('wireframe' in material) material.wireframe = !!md.wireframe;
            if ('fog' in material && md.fog != null) material.fog = !!md.fog;
            if ('shininess' in material && md.shininess != null) material.shininess = md.shininess;
            if ('specular' in material && Array.isArray(md.spec)) {
                material.specular.setRGB(md.spec[0], md.spec[1], md.spec[2]);
            }
            if ('combine' in material && md.combine != null) {
                const combineModes = [THREE.MultiplyOperation, THREE.MixOperation, THREE.AddOperation];
                material.combine = combineModes[md.combine] ?? THREE.MultiplyOperation;
            }
            if ('normalMapType' in material && md.normalMapType != null) {
                material.normalMapType = md.normalMapType === 1 ? THREE.ObjectSpaceNormalMap : THREE.TangentSpaceNormalMap;
            }
            if ('depthPacking' in material && md.depthPacking != null) {
                const depthPackingModes = [
                    THREE.BasicDepthPacking,
                    THREE.RGBADepthPacking,
                    THREE.RGBDepthPacking,
                    THREE.RGDepthPacking,
                ];
                material.depthPacking = depthPackingModes[md.depthPacking] ?? THREE.BasicDepthPacking;
            }
            if (md.normScl != null && 'normalScale' in material) {
                material.normalScale = normalScaleVectorFromDescriptor(md, THREE) ?? material.normalScale;
            }
            if (md.bumpS != null && 'bumpScale' in material) material.bumpScale = md.bumpS;
            if (md.dispS != null && 'displacementScale' in material) material.displacementScale = md.dispS;
            if (md.dispB != null && 'displacementBias' in material) material.displacementBias = md.dispB;
            if (md.aoI != null && 'aoMapIntensity' in material) material.aoMapIntensity = md.aoI;
            if (md.lmI != null && 'lightMapIntensity' in material) material.lightMapIntensity = md.lmI;

            // Apply texture maps (all slots support TSL Texture)
            const applyMap = (key, prop, cs, xf, fb) => {
                const tex = loadMapSlot(md, key, cs, xf, fb, materialContext);
                if (tex && prop in material) material[prop] = tex;
                return tex;
            };
            const W = fallbackWhiteTexture, N = fallbackFlatNormalTexture, H = fallbackHeightTexture;
            preserveOpacityForHTMLColorMap(material, applyMap('map', 'map', THREE.SRGBColorSpace, 'mapXf', W));
            applyMap('normMap',    'normalMap',              THREE.LinearSRGBColorSpace,   'normMapXf',    N);
            applyMap('bumpMap',    'bumpMap',                THREE.NoColorSpace,           'bumpMapXf',    H);
            applyMap('ccMap',      'clearcoatMap',           THREE.LinearSRGBColorSpace,   'ccMapXf',      W);
            applyMap('ccRoughMap', 'clearcoatRoughnessMap',  THREE.LinearSRGBColorSpace,   'ccRoughMapXf', W);
            applyMap('ccNormMap',  'clearcoatNormalMap',     THREE.LinearSRGBColorSpace,   'ccNormMapXf',  N);
            applyMap('dispMap',    'displacementMap',        THREE.NoColorSpace,           'dispMapXf',    H);
            applyMap('aoMap',      'aoMap',                  THREE.LinearSRGBColorSpace,   'aoMapXf',      W);
            applyMap('emMap',      'emissiveMap',            THREE.SRGBColorSpace,         'emMapXf',      W);
            applyMap('transMap',   'transmissionMap',        THREE.LinearSRGBColorSpace,   'transMapXf',   W);
            const lightMapChannel = resolveLightMapMaxMapChannel(md);
            const lmTex = loadMapSlot(md, 'lmMap', THREE.LinearSRGBColorSpace, 'lmMapXf', W, materialContext, lightMapChannel);
            if (lmTex && 'lightMap' in material) material.lightMap = lmTex;
            if (lmTex) {
                material.lightMap = textureWithUvChannel(lmTex, lightMapChannel, 2);
                deps.applyWebGpuLightMapUvContext(material, lightMapChannel);
                material.lightMapIntensity = md.lmI ?? material.lightMapIntensity ?? 1.0;
            }
            applyMap('matcapMap',  'matcap',                 THREE.SRGBColorSpace,         'matcapMapXf',  W);
            applyMap('specMap',    'specularMap',            THREE.LinearSRGBColorSpace,   'specMapXf',    W);
            applyMap('sheenColMap',   'sheenColorMap',       THREE.SRGBColorSpace,         'sheenColMapXf',   W);
            applyMap('sheenRoughMap', 'sheenRoughnessMap',   THREE.LinearSRGBColorSpace,   'sheenRoughMapXf', W);
            applyOpacityTextureSlot(material, loadMapSlot(md, 'opMap', THREE.LinearSRGBColorSpace, 'opMapXf', W, materialContext));

            rememberMaterialEmissiveBase(material);
            material.needsUpdate = true;
            return material;
        }

        function shouldRouteBlackSpecularToLambert(requestedModelName, md) {
            return shouldRouteBlackSpecularToLambertShared(requestedModelName, md);
        }

        function materialIdentityValue(value) {
            if (Array.isArray(value)) return value.map(materialIdentityValue);
            if (!value || typeof value !== 'object') return value;
            const normalized = {};
            for (const key of Object.keys(value).sort()) {
                if (key === 'name') continue;
                const child = value[key];
                if (child === undefined) continue;
                normalized[key] = materialIdentityValue(child);
            }
            return normalized;
        }

        function materialIdentityKey(md) {
            return JSON.stringify(materialIdentityValue(md ?? null));
        }

        function materialTemplateCacheKey(requestedModelName, runtimeModelName, md) {
            return JSON.stringify([requestedModelName, runtimeModelName, materialIdentityValue(md ?? null)]);
        }

        function getMaterialPayloads(nd) {
            if (nd?.mats && nd?.groups) return nd.mats.filter(Boolean);
            if (nd?.mat) return [nd.mat];
            return [null];
        }

        function countMaterialTextureSlots(md) {
            if (!md || typeof md !== 'object') return 0;
            let count = 0;
            for (const [key, value] of Object.entries(md)) {
                if (typeof value !== 'string' || value.length === 0) continue;
                if (key === 'model' || key === 'name' || key === 'materialXFile' || key === 'materialXInline') continue;
                if (key.endsWith('Map') || key.endsWith('Tex') || key.endsWith('Path') || key.endsWith('File')) count++;
            }
            return count;
        }

        function getOrCreateMaterialRegistryEntry(md) {
            const key = md ? materialIdentityKey(md) : '__maxjs_default_material__';
            let entry = materialRegistry.get(key);
            if (!entry) {
                entry = {
                    id: nextMaterialRegistryId++,
                    key,
                    model: md?.model || 'MeshStandardMaterial',
                    displayName: md?.name || 'default',
                    names: new Set(),
                    textureSlots: countMaterialTextureSlots(md),
                    refCount: 0,
                    bucketedRefCount: 0,
                    lastSeenFrame: 0,
                };
                materialRegistry.set(key, entry);
            }
            if (md?.name) {
                entry.displayName = md.name;
                entry.names.add(md.name);
            }
            entry.model = md?.model || entry.model || 'MeshStandardMaterial';
            entry.textureSlots = countMaterialTextureSlots(md);
            return entry;
        }

        function refreshMaterialRegistry(nodes, bucketPlan = null) {
            materialRegistryFrame++;
            let materialRefs = 0;
            let bucketedRefs = 0;
            let maxRefsPerMaterial = 0;
            for (const entry of materialRegistry.values()) {
                entry.refCount = 0;
                entry.bucketedRefCount = 0;
            }
            for (const nd of nodes || []) {
                for (const md of getMaterialPayloads(nd)) {
                    const entry = getOrCreateMaterialRegistryEntry(md);
                    entry.refCount++;
                    entry.lastSeenFrame = materialRegistryFrame;
                    materialRefs++;
                }
            }
            for (const group of bucketPlan?.groups?.values?.() || []) {
                const entry = materialRegistry.get(group.materialKey);
                if (!entry) continue;
                entry.bucketedRefCount += group.nodes.length;
                bucketedRefs += group.nodes.length;
            }
            for (const [key, entry] of [...materialRegistry.entries()]) {
                if (entry.lastSeenFrame !== materialRegistryFrame) {
                    materialRegistry.delete(key);
                    continue;
                }
                maxRefsPerMaterial = Math.max(maxRefsPerMaterial, entry.refCount);
            }
            materialRegistryStats = {
                uniqueMaterials: materialRegistry.size,
                materialTemplates: materialCache.size + materialXTemplateCache.size,
                materialRefs,
                bucketedRefs,
                instanceBuckets: bucketPlan?.groups?.size ?? deps.maxInstanceBuckets.size,
                maxRefsPerMaterial,
            };
            return materialRegistryStats;
        }

        function materialRegistryHudStats() {
            return {
                materialCount: materialRegistryStats.uniqueMaterials,
                materialTemplateCount: materialRegistryStats.materialTemplates,
                instanceBucketCount: materialRegistryStats.instanceBuckets,
            };
        }

        function resolveSnapshotMaterialRefs(snapshot) {
            if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.materials)) return snapshot;
            const materialById = new Map();
            for (const entry of snapshot.materials) {
                const id = Number(entry?.id ?? entry?.i);
                const material = entry?.mat ?? entry?.material;
                if (Number.isFinite(id) && material && typeof material === 'object') {
                    materialById.set(id, material);
                }
            }
            if (materialById.size === 0) return snapshot;
            for (const nd of snapshot.nodes) {
                if (!nd || typeof nd !== 'object') continue;
                if (nd.mat == null && nd.matRef != null) {
                    const mat = materialById.get(Number(nd.matRef));
                    if (mat) nd.mat = mat;
                }
                if (!Array.isArray(nd.mats) && Array.isArray(nd.matRefs)) {
                    const mats = [];
                    for (const ref of nd.matRefs) {
                        const mat = materialById.get(Number(ref));
                        if (mat) mats.push(mat);
                    }
                    if (mats.length > 0) nd.mats = mats;
                }
            }
            return snapshot;
        }

        function createMaterial(md, materialContext = null) {
            const requestedModelName = md.model || 'MeshStandardMaterial';
            const registryEntry = getOrCreateMaterialRegistryEntry(md);
            if (wantsHTMLTextureOverrideMaterial(md)) {
                const runtimeModelName = 'HTMLTextureOverrideMaterial';
                const key = materialTemplateCacheKey(requestedModelName, runtimeModelName, htmlTextureOverrideIdentity(md, materialContext));
                let template = materialCache.get(key);
                if (!template) {
                    template = createHTMLTextureOverrideMaterial(md, materialContext);
                    if (!template) {
                        template = new THREE.MeshBasicMaterial({
                            color: 0xff00ff,
                            side: md.side === 0 ? THREE.FrontSide : THREE.DoubleSide,
                            toneMapped: false,
                        });
                    }
                    template.userData ??= {};
                    template.userData.maxjsMaterialRegistryId = registryEntry.id;
                    template.userData.maxjsMaterialIdentityKey = registryEntry.key;
                    template.userData.maxjsRequestedMaterialModel = requestedModelName;
                    template.userData.maxjsMaterialModel = runtimeModelName;
                    template.userData.maxjsSourceMaterialName = md.name || template.name || 'default';
                    if (md.name) template.name = md.name;
                    materialCache.set(key, template);
                }
                const material = template.clone();
                material.userData = { ...(template.userData || {}) };
                material.userData.maxjsMaterialRegistryId = registryEntry.id;
                material.userData.maxjsMaterialIdentityKey = registryEntry.key;
                material.userData.maxjsSourceMaterialName = md.name || material.name || 'default';
                if (md.name) material.name = md.name;
                return material;
            }
            const forceLambertForBlackSpecular = shouldRouteBlackSpecularToLambert(requestedModelName, md);
            const wantsMaterialXMaterial = requestedModelName === 'MaterialXMaterial';
            const wantsUtilityMaterial = forceLambertForBlackSpecular || utilityMaterialModels.has(requestedModelName);
            const wantsToonMaterial = requestedModelName === 'MeshToonMaterial';
            const wantsSSSMaterial = requestedModelName === 'MeshSSSNodeMaterial';
            const wantsTSLMaterial = requestedModelName === 'MeshTSLNodeMaterial';
            const hasMaterialXSource = Boolean(md.materialXInline || md.materialXFile);
            if (wantsTSLMaterial && md.materialXBridgeConnected && !hasMaterialXSource) {
                const sourceName = md.materialXBridgeSourceName || 'connected source material';
                const reason = md.materialXBridgeError || 'auto-compile produced no MaterialX payload';
                console.error(`[MaterialX] Auto-compile bridge failed for ${sourceName}: ${reason}`);
            }
            const wantsAdvancedMaterial =
                requestedModelName === 'MeshPhysicalMaterial' ||
                requestedModelName === 'MeshStandardNodeMaterial';
            const canUseBackdropUtility =
                requestedModelName === 'MeshBackdropNodeMaterial' &&
                deps.rendererBackendLabel === 'WebGPU' &&
                typeof THREE.MeshBasicNodeMaterial === 'function' &&
                typeof hashBlur === 'function';
            const hasUtilityCtor =
                wantsUtilityMaterial &&
                requestedModelName !== 'MeshBackdropNodeMaterial' &&
                typeof THREE[requestedModelName] === 'function';
            const canUseToonMaterial = wantsToonMaterial && typeof THREE.MeshToonMaterial === 'function';
            const isPlainWebGLMaterialBackend = String(deps.rendererBackendLabel || '').startsWith('WebGL');
            const canUseNodeMaterialBackend = !isPlainWebGLMaterialBackend;
            const canUseSSSMaterial =
                wantsSSSMaterial &&
                canUseNodeMaterialBackend &&
                typeof THREE.MeshSSSNodeMaterial === 'function' &&
                typeof tslColor === 'function' &&
                typeof tslFloat === 'function' &&
                typeof tslTexture === 'function';
            const runtimeModelName = (wantsMaterialXMaterial && canUseNodeMaterialBackend)
                ? 'MaterialXMaterial'
                : forceLambertForBlackSpecular
                ? 'MeshLambertMaterial'
                : wantsUtilityMaterial
                ? ((hasUtilityCtor || canUseBackdropUtility) ? requestedModelName : 'MeshLambertMaterial')
                : (canUseToonMaterial
                ? 'MeshToonMaterial'
                : (canUseSSSMaterial
                    ? 'MeshSSSNodeMaterial'
                    : ((wantsAdvancedMaterial || wantsSSSMaterial || wantsTSLMaterial || wantsMaterialXMaterial)
                        ? 'MeshPhysicalMaterial'
                        : 'MeshStandardMaterial')));
            // Exclude tslParams from cache key — param changes should update
            // existing uniforms, not trigger a full material rebuild.
            const cacheableBaseMd = (wantsTSLMaterial && md.tslParams)
                ? Object.assign({}, md, { tslParams: undefined })
                : md;
            const cacheableMd = withHTMLAutoFitIdentity(cacheableBaseMd, materialContext);
            const key = materialTemplateCacheKey(requestedModelName, runtimeModelName, cacheableMd);
            let template = materialCache.get(key);
            if (!template && wantsMaterialXMaterial) {
                template = materialXTemplateCache.get(key);
            }

            if (!template) {
                if (wantsMaterialXMaterial && canUseNodeMaterialBackend) {
                    template = createPendingMaterialXMaterial(md);
                    materialXTemplateCache.set(key, template);
                    ensureMaterialXTemplateLoaded(key, template, md);
                } else if (wantsTSLMaterial && canUseNodeMaterialBackend && hasMaterialXSource) {
                    // TSL material with MaterialX source — use MaterialXLoader
                    template = createPendingMaterialXMaterial(md);
                    materialXTemplateCache.set(key, template);
                    ensureMaterialXTemplateLoaded(key, template, md);
                } else if (wantsTSLMaterial && canUseNodeMaterialBackend && md.tslCode) {
                    template = tslCompiler.createTSLMaterial(md);
                } else if (wantsTSLMaterial && canUseNodeMaterialBackend) {
                    template = tslCompiler.createMissingTSLMaterial(md);
                } else if (wantsUtilityMaterial) {
                    template = createUtilityMaterial(runtimeModelName, md, materialContext);
                } else {
                    const params = {
                        color: new THREE.Color(md.color[0], md.color[1], md.color[2]),
                        side: md.side === 0 ? THREE.FrontSide : THREE.DoubleSide,
                    };

                    if (!wantsToonMaterial) {
                        params.roughness = md.rough ?? 0.5;
                        params.metalness = md.metal ?? 0.0;
                        params.envMapIntensity = md.envI ?? 1.0;
                    }

                    if (md.opacity != null && md.opacity < 0.999) {
                        params.transparent = true;
                        params.opacity = md.opacity;
                    }
                    if (Number.isFinite(md.alphaTest) && md.alphaTest > 0) {
                        params.alphaTest = md.alphaTest;
                    }
                    if (md.transparent === true) params.transparent = true;
                    if (md.depthWrite != null) params.depthWrite = !!md.depthWrite;
                    if (md.depthTest != null) params.depthTest = !!md.depthTest;

                    if (wantsAdvancedMaterial || wantsSSSMaterial || wantsTSLMaterial || wantsMaterialXMaterial) {
                        // `reflectivity` is not a stored field on MeshPhysicalMaterial —
                        // it is an alias setter onto `ior`. Material.setValues applies
                        // params in insertion order, so it MUST go in before ior or it
                        // overwrites the authored IOR (reflectivity 0.5 => ior 1.5, which
                        // silently pinned every glass/water/gem IOR to 1.5).
                        if (md.reflectivity != null) params.reflectivity = md.reflectivity;
                        if (Array.isArray(md.specularColor)) {
                            params.specularColor = new THREE.Color(md.specularColor[0], md.specularColor[1], md.specularColor[2]);
                        }
                        if (md.specularIntensity != null) {
                            params.specularIntensity = md.specularIntensity;
                            // specularIntensity 0 = no reflections at all; also kill env reflections + set IOR 1.0
                            if (md.specularIntensity < 0.001) {
                                params.envMapIntensity = 0;
                                params.ior = 1.0;
                            }
                        }
                        if (md.specIntMap) params.specularIntensityMap = loadTexture(md.specIntMap, THREE.LinearSRGBColorSpace, md.specIntMapXf, fallbackWhiteTexture);
                        if (md.specColMap) params.specularColorMap = loadTexture(md.specColMap, THREE.SRGBColorSpace, md.specColMapXf, fallbackWhiteTexture);
                        if (md.clearcoat != null) params.clearcoat = md.clearcoat;
                        if (md.clearcoatRoughness != null) params.clearcoatRoughness = md.clearcoatRoughness;
                        if (md.ccMap) params.clearcoatMap = loadTexture(md.ccMap, THREE.LinearSRGBColorSpace, md.ccMapXf, fallbackWhiteTexture);
                        if (md.ccRoughMap) params.clearcoatRoughnessMap = loadTexture(md.ccRoughMap, THREE.LinearSRGBColorSpace, md.ccRoughMapXf, fallbackWhiteTexture);
                        if (md.ccNormMap) params.clearcoatNormalMap = loadTexture(md.ccNormMap, THREE.LinearSRGBColorSpace, md.ccNormMapXf, fallbackFlatNormalTexture);
                        if (md.sheen != null) params.sheen = md.sheen;
                        if (md.sheenRoughness != null) params.sheenRoughness = md.sheenRoughness;
                        if (Array.isArray(md.sheenColor)) {
                            params.sheenColor = new THREE.Color(md.sheenColor[0], md.sheenColor[1], md.sheenColor[2]);
                        }
                        if (md.sheenColMap) params.sheenColorMap = loadTexture(md.sheenColMap, THREE.SRGBColorSpace, md.sheenColMapXf, fallbackWhiteTexture);
                        if (md.sheenRoughMap) params.sheenRoughnessMap = loadTexture(md.sheenRoughMap, THREE.LinearSRGBColorSpace, md.sheenRoughMapXf, fallbackWhiteTexture);
                        if (md.iridescence != null) params.iridescence = md.iridescence;
                        if (md.iridescenceIOR != null) params.iridescenceIOR = md.iridescenceIOR;
                        if (md.transmission != null) params.transmission = md.transmission;
                        if (md.transMap) params.transmissionMap = loadTexture(md.transMap, THREE.LinearSRGBColorSpace, md.transMapXf, fallbackWhiteTexture);
                        if (md.ior != null && !(md.specularIntensity != null && md.specularIntensity < 0.001)) params.ior = md.ior;
                        if (md.thickness != null) params.thickness = md.thickness;
                        if (md.dispersion != null) params.dispersion = md.dispersion;
                        if (Array.isArray(md.attenuationColor)) {
                            params.attenuationColor = new THREE.Color(md.attenuationColor[0], md.attenuationColor[1], md.attenuationColor[2]);
                        }
                        if (md.attenuationDistance != null && md.attenuationDistance > 0) {
                            params.attenuationDistance = md.attenuationDistance;
                        }
                        if (md.anisotropy != null) params.anisotropy = md.anisotropy;
                        if ((md.transmission ?? 0) > 0) params.transparent = true;
                    }

                    const hasEmissiveColor = Array.isArray(md.em) && md.em.length === 3 &&
                        md.em.some(value => Math.abs(value) > 1.0e-5);

                    if (md.em && md.emI > 0) {
                        params.emissive = new THREE.Color(md.em[0], md.em[1], md.em[2]);
                        params.emissiveIntensity = md.emI;
                    }

                    if (md.emMap) {
                        if (!params.emissive) {
                            params.emissive = hasEmissiveColor
                                ? new THREE.Color(md.em[0], md.em[1], md.em[2])
                                : new THREE.Color(1, 1, 1);
                        }
                        if (params.emissiveIntensity == null || params.emissiveIntensity <= 0) {
                            params.emissiveIntensity = md.emMapS ?? 1.0;
                        }
                    }

                    if (md.normScl != null) params.normalScale = normalScaleVectorFromDescriptor(md, THREE);
                    if (md.bumpS != null) params.bumpScale = md.bumpS;
                    if (md.dispS != null) params.displacementScale = md.dispS;
                    if (md.dispB != null) params.displacementBias = md.dispB;
                    if (md.aoI != null) params.aoMapIntensity = md.aoI;

                    if (canUseToonMaterial) {
                        template = new THREE.MeshToonMaterial(params);
                    } else if (canUseSSSMaterial) {
                        template = new THREE.MeshSSSNodeMaterial(params);
                    } else if (wantsAdvancedMaterial || wantsSSSMaterial || wantsTSLMaterial || wantsMaterialXMaterial) {
                        template = new THREE.MeshPhysicalMaterial(params);
                    } else {
                        template = new THREE.MeshStandardMaterial(params);
                    }

                    // Textures (all slots support TSL Texture)
                    {
                        const apply = (key, prop, cs, xf, fb) => {
                            const tex = loadMapSlot(md, key, cs, xf, fb, materialContext);
                            if (tex) template[prop] = tex;
                            return tex;
                        };
                        const W = fallbackWhiteTexture, N = fallbackFlatNormalTexture, H = fallbackHeightTexture;
                        preserveOpacityForHTMLColorMap(template, apply('map', 'map', THREE.SRGBColorSpace, 'mapXf', W));
                        if (!wantsToonMaterial) {
                            apply('roughMap', 'roughnessMap',  THREE.LinearSRGBColorSpace, 'roughMapXf', W);
                            apply('metalMap', 'metalnessMap',  THREE.LinearSRGBColorSpace, 'metalMapXf', W);
                        }
                        apply('normMap',  'normalMap',         THREE.LinearSRGBColorSpace, 'normMapXf',  N);
                        apply('bumpMap',  'bumpMap',           THREE.NoColorSpace,         'bumpMapXf',  H);
                        apply('dispMap',  'displacementMap',   THREE.NoColorSpace,         'dispMapXf',  H);
                        apply('aoMap',    'aoMap',             THREE.LinearSRGBColorSpace, 'aoMapXf',    W);
                        apply('emMap',    'emissiveMap',       THREE.SRGBColorSpace,       'emMapXf',    W);
                        applyOpacityTextureSlot(template, loadMapSlot(md, 'opMap', THREE.LinearSRGBColorSpace, 'opMapXf', W, materialContext));
                        if ('transmissionMap' in template)
                            apply('transMap', 'transmissionMap', THREE.LinearSRGBColorSpace, 'transMapXf', W);
                    }
                    if (canUseToonMaterial) {
                        const gradTex = loadMapSlot(md, 'gradMap', THREE.NoColorSpace, null, fallbackToonGradientTexture, materialContext);
                        template.gradientMap = gradTex
                            ? configureGradientTexture(gradTex)
                            : fallbackToonGradientTexture;
                    }

                    // Lightmap
                    {
                        const lightMapChannel = resolveLightMapMaxMapChannel(md);
                        const lmTex = loadMapSlot(md, 'lmMap', THREE.LinearSRGBColorSpace, 'lmMapXf', fallbackWhiteTexture, materialContext, lightMapChannel);
                        if (lmTex) {
                            template.lightMap = textureWithUvChannel(lmTex, lightMapChannel, 2);
                            deps.applyWebGpuLightMapUvContext(template, lightMapChannel);
                            template.lightMapIntensity = md.lmI ?? 1.0;
                        }
                    }

                    if (canUseSSSMaterial) {
                        applySSSMaterialNodes(template, md);
                    }
                }
                template.userData ??= {};
                template.userData.maxjsMaterialRegistryId = registryEntry.id;
                template.userData.maxjsMaterialIdentityKey = registryEntry.key;
                template.userData.maxjsRequestedMaterialModel = requestedModelName;
                template.userData.maxjsMaterialModel = runtimeModelName;
                template.userData.maxjsUtilityMaterialFallback =
                    wantsUtilityMaterial && !(hasUtilityCtor || canUseBackdropUtility);
                template.userData.maxjsLambertFromBlackSpecular = forceLambertForBlackSpecular;
                template.userData.maxjsToonMaterialFallback =
                    wantsToonMaterial && !canUseToonMaterial;
                template.userData.maxjsSSSMaterialFallback =
                    wantsSSSMaterial && !canUseSSSMaterial;
                template.userData.maxjsSourceMaterialName = md.name || template.name || 'default';
                if (md.name) template.name = md.name;

                rememberMaterialEmissiveBase(template);
                template.needsUpdate = true;
                materialCache.set(key, template);

            } else if (wantsMaterialXMaterial) {
                materialCache.set(key, template);
            }

            if ((wantsMaterialXMaterial || (wantsTSLMaterial && hasMaterialXSource)) && canUseNodeMaterialBackend) {
                return template;
            }

            // TSL material reuse: update uniforms from latest params without rebuild
            if (wantsTSLMaterial && template.userData?.tslParams && md.tslParams) {
                const stored = template.userData.tslParams;
                for (const [k, v] of Object.entries(md.tslParams)) {
                    const u = stored[k];
                    if (!u) continue;
                    if (typeof v === 'number') u.value = v;
                    else if (Array.isArray(v) && u.value?.isColor) u.value.setRGB(v[0]??0, v[1]??0, v[2]??0);
                    else if (typeof v === 'boolean') u.value = v ? 1.0 : 0.0;
                }
                return template;
            }

            const material = template.clone();
            material.userData = { ...(template.userData || {}) };
            material.userData.maxjsMaterialRegistryId = registryEntry.id;
            material.userData.maxjsMaterialIdentityKey = registryEntry.key;
            material.userData.maxjsSourceMaterialName = md.name || material.name || 'default';
            if (md.name) material.name = md.name;
            if (material.userData.maxjsHTMLColorMapPreserveOpacity) {
                preserveOpacityForHTMLColorMap(material, material.map);
            }
            rememberMaterialEmissiveBase(material);
            return material;
        }


        function createSceneMaterial(nd, geom = null, mesh = null) {
            let material = null;
            if (nd?.mats && nd?.groups) {
                material = nd.mats.map((m, materialIndex) => createMaterial(m, {
                    geometry: geom,
                    materialIndex,
                    matrixArray: nd?.t,
                }));
            } else if (nd?.mat) {
                material = createMaterial(nd.mat, {
                    geometry: geom,
                    materialIndex: null,
                    matrixArray: nd?.t,
                });
            }
            else {
                const entry = getOrCreateMaterialRegistryEntry(null);
                material = new THREE.MeshStandardMaterial({ color: 0x888888, side: THREE.DoubleSide });
                material.userData ??= {};
                material.userData.maxjsMaterialRegistryId = entry.id;
                material.userData.maxjsMaterialIdentityKey = entry.key;
                material.userData.maxjsSourceMaterialName = 'default';
            }
            return deps.applyBakeOverridesToSceneMaterial(material, nd, geom, mesh);
        }

        function createDefaultSceneMaterial() {
            const entry = getOrCreateMaterialRegistryEntry(null);
            const material = new THREE.MeshStandardMaterial({ color: 0x888888, side: THREE.DoubleSide });
            material.userData ??= {};
            material.userData.maxjsMaterialRegistryId = entry.id;
            material.userData.maxjsMaterialIdentityKey = entry.key;
            material.userData.maxjsSourceMaterialName = 'default';
            return material;
        }

        function materialPayloadHasHTMLAutoFit(md) {
            if (!md || typeof md !== 'object') return false;
            return HTML_TEXTURE_AUTO_FIT_KEYS.some(key => htmlTextureAutoFitEnabled(md, key));
        }

        function nodePayloadHasHTMLAutoFit(nd) {
            if (!nd || typeof nd !== 'object') return false;
            if (materialPayloadHasHTMLAutoFit(nd.mat)) return true;
            return Array.isArray(nd.mats) && nd.mats.some(materialPayloadHasHTMLAutoFit);
        }

        const pendingMaterialDisposals = [];
        function disposeSceneMaterial(material) {
            // Defer disposal to next frame — WebGPU node cache may still reference textures
            if (Array.isArray(material)) {
                for (const item of material) { if (item) pendingMaterialDisposals.push(item); }
            } else if (material) {
                pendingMaterialDisposals.push(material);
            }
        }
        function collectMaterialRefs(material, refs) {
            if (Array.isArray(material)) {
                for (const item of material) if (item) refs.add(item);
            } else if (material) {
                refs.add(material);
            }
        }
        function collectLiveSceneMaterials() {
            const live = new Set();
            for (const mesh of deps.nodeMap.values()) collectMaterialRefs(mesh?.material, live);
            for (const [, bucket] of deps.maxInstanceBuckets) collectMaterialRefs(bucket?.mesh?.material, live);
            for (const [, entry] of deps.hairMeshes) collectMaterialRefs(entry?.mesh?.material, live);
            for (const [, mesh] of deps.forestMeshes) collectMaterialRefs(mesh?.material, live);
            return live;
        }
        function flushMaterialDisposals() {
            if (pendingMaterialDisposals.length === 0) return;
            const live = collectLiveSceneMaterials();
            const disposed = new Set();
            for (const mat of pendingMaterialDisposals) {
                if (!mat || live.has(mat) || disposed.has(mat)) continue;
                mat.dispose?.();
                disposed.add(mat);
            }
            pendingMaterialDisposals.length = 0;
        }

        function createSceneLineMaterial(mat) {
            return new THREE.LineBasicMaterial({
                color: mat?.color ?? new THREE.Color(0xffffff),
            });
        }

        function sceneMaterialSignature(nd, wantsLine) {
            const payload = nd?.mats && nd?.groups
                ? ['multi', nd.mats.map(materialIdentityValue)]
                : (nd?.mat ? ['single', materialIdentityValue(nd.mat)] : ['default']);
            // Bake mode (beauty) is the only state that swaps material *type*; track it
            // so material-type changes still trigger rebuild. Other bake fields (folder,
            // intensity, suffixes) mutate the existing material in place.
            const bakeKey = deps.bakeOverrides.enabled && deps.bakeOverrides.mode === 'beauty' ? 'beauty' : 'live';
            const htmlFitKey = nodePayloadHasHTMLAutoFit(nd) ? `:htmlfit:${matrixScaleSignature(nd?.t)}` : '';
            return `${wantsLine ? 'line' : 'mesh'}:${bakeKey}:${JSON.stringify(payload)}${htmlFitKey}`;
        }

        function isCachedMaterialTemplate(material) {
            if (!material) return false;
            for (const cached of materialCache.values()) if (cached === material) return true;
            for (const cached of materialXTemplateCache.values()) if (cached === material) return true;
            return false;
        }

        function createSceneRenderableMaterial(nd, wantsLine, geom = null, mesh = null) {
            const mat = createSceneMaterial(nd, geom, mesh);
            if (!wantsLine) {
                ensureGeometryUv0ForMaterial(geom, mat);
                return mat;
            }
            const lineMat = createSceneLineMaterial(mat);
            if (!isCachedMaterialTemplate(mat)) disposeSceneMaterial(mat);
            return lineMat;
        }

        function cloneGeometryGroups(geometry) {
            return Array.isArray(geometry?.groups)
                ? geometry.groups.map(group => [group.start, group.count, group.materialIndex])
                : [];
        }

        function applyGeometryGroups(geometry, groups) {
            if (!geometry || !Array.isArray(groups)) return false;
            geometry.clearGroups();
            for (const group of groups) {
                if (!Array.isArray(group) || group.length < 3) continue;
                geometry.addGroup(group[0], group[1], group[2]);
            }
            return true;
        }

        function geometryGroupsMatch(geometry, groups) {
            if (!geometry || !Array.isArray(groups)) return false;
            const current = Array.isArray(geometry.groups) ? geometry.groups : [];
            if (current.length !== groups.length) return false;
            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];
                if (!Array.isArray(group) || group.length < 3) return false;
                const currentGroup = current[i];
                if (!currentGroup
                    || currentGroup.start !== group[0]
                    || currentGroup.count !== group[1]
                    || currentGroup.materialIndex !== group[2]) {
                    return false;
                }
            }
            return true;
        }

        function resolveInstancedNodeGeometry(nd, sourceGeometry, { cloneForJsmod = false } = {}) {
            if (!sourceGeometry) return null;
            if (!Array.isArray(nd?.groups)) return cloneForJsmod ? sourceGeometry.clone() : sourceGeometry;
            if (!cloneForJsmod && geometryGroupsMatch(sourceGeometry, nd.groups)) return sourceGeometry;
            const geometry = sourceGeometry.clone();
            applyGeometryGroups(geometry, nd.groups);
            return geometry;
        }

        function isGeometrySharedByAnotherMesh(geometry, selfMesh) {
            if (!geometry) return false;
            for (const other of deps.nodeMap.values()) {
                if (other !== selfMesh && other.geometry === geometry) return true;
            }
            for (const [, bucket] of deps.maxInstanceBuckets) {
                if (bucket.mesh && bucket.mesh.geometry === geometry) return true;
            }
            return false;
        }

        function syncGeometryGroupsForNode(mesh, geometry, groups) {
            if (!geometry || !Array.isArray(groups)) return geometry;
            if (geometryGroupsMatch(geometry, groups)) return geometry;
            // Groups live on the geometry, but instances share one BufferGeometry.
            // Rewriting them in place would scramble every sibling's material-ID
            // mapping (last node processed wins) — clone for this node instead.
            const target = isGeometrySharedByAnotherMesh(geometry, mesh)
                ? geometry.clone()
                : geometry;
            applyGeometryGroups(target, groups);
            return target;
        }

        function applyFastMaterialPayload(mesh, payload, wantsLine) {
            if (!mesh || !Array.isArray(payload?.groups) || !Array.isArray(payload?.mats)) return false;
            const ndForMaterial = {
                ...(mesh.userData?.maxjsLastNodePayload || {}),
                h: payload.h,
                n: mesh.name,
                t: mesh.matrix?.elements,
                groups: payload.groups,
                mats: payload.mats,
            };
            delete ndForMaterial.mat;
            delete ndForMaterial.matRef;
            delete ndForMaterial.matRefs;
            const changed = ensureSceneRenderableMaterial(mesh, ndForMaterial, wantsLine);
            if (!changed) stampSceneMaterial(mesh, ndForMaterial, wantsLine);
            if (changed) deps.layerManager.applyMaterialOverrides?.(payload.h, mesh);
            return changed;
        }

        function stampSceneMaterial(mesh, nd, wantsLine) {
            mesh.userData ??= {};
            mesh.userData.maxjsMaterialSignature = sceneMaterialSignature(nd, wantsLine);
            mesh.userData.maxjsLastNodePayload = nd;
            mesh.userData.maxjsHasHTMLAutoFit = nodePayloadHasHTMLAutoFit(nd);
        }

        function ensureSceneRenderableMaterial(mesh, nd, wantsLine, { authoritativeMaterial = false } = {}) {
            if (!mesh) return false;
            if (!wantsLine) ensureGeometryUv0ForMaterial(mesh.geometry, mesh.material);
            // Guard: a single-material payload must not collapse a mesh that is
            // still multi/sub-object. On an incremental re-sync (e.g. after undo)
            // the Max side can skip geometry extraction for a node whose geometry
            // is unchanged/instanced — and with it drop the multi-sub groups+mats
            // payload, sending only a single `mat`. The geometry still carries its
            // (>1) material groups, so a lone `mat` can't be the real assignment;
            // rebuilding from it dumps every face onto slot 0 (the "instances lose
            // their material IDs" bug). Keep the existing array.
            //
            // Full scene syncs pass authoritativeMaterial: there the Max side has
            // just re-read GetMtl() for this node, so a single `mat` IS the real
            // assignment (a genuine multi→single reassignment) and must apply —
            // material assignment never re-extracts geometry, so waiting for a
            // single-group geometry payload deadlocked these nodes until a viewer
            // reload. With a single material three.js ignores the group material
            // indices, so the (possibly shared) geometry groups can stay.
            if (!wantsLine
                && Array.isArray(mesh.material) && mesh.material.length > 1
                && Array.isArray(mesh.geometry?.groups) && mesh.geometry.groups.length > 1
                && !(Array.isArray(nd?.mats) && nd.mats.length)
                && !(authoritativeMaterial && nd?.mat)) {
                return false;
            }
            const signature = sceneMaterialSignature(nd, wantsLine);
            if (mesh.material && mesh.userData?.maxjsMaterialSignature === signature) return false;
            const oldMaterial = mesh.material;
            mesh.material = createSceneRenderableMaterial(nd, wantsLine, mesh.geometry, mesh);
            mesh.userData ??= {};
            mesh.userData.maxjsMaterialSignature = signature;
            mesh.userData.maxjsLastNodePayload = nd;
            mesh.userData.maxjsHasHTMLAutoFit = nodePayloadHasHTMLAutoFit(nd);
            disposeSceneMaterial(oldMaterial);
            return true;
        }


        function getMaterialRegistryStats() {
            return materialRegistryStats;
        }

        function getMaterialRegistryEntries() {
            return [...materialRegistry.values()].map((entry) => ({
                id: entry.id,
                model: entry.model,
                displayName: entry.displayName,
                names: [...entry.names],
                textureSlots: entry.textureSlots,
                refCount: entry.refCount,
                bucketedRefCount: entry.bucketedRefCount,
                key: entry.key,
            }));
        }

        return {
            rememberMaterialEmissiveBase,
            applyMaterialSelectionState,
            applyMeshShadowState,
            applyNodeProps,
            applyJsmodSyncState,
            applyUserPropsSyncState,
            setObjectSelfVisibleLayer,
            restoreRenderableMaterialVisibility,
            applyMaxObjectVisibility,
            applyBridgeVisibility,
            applyInstanceSyncState,
            getSSSRoughnessInfluence,
            applySSSRoughnessInfluence,
            applySSSMaterialNodes,
            createBackdropUtilityMaterial,
            normalizeMaxVertexColorChannel,
            maxVertexColorAttributeName,
            createUtilityMaterial,
            materialIdentityValue,
            materialIdentityKey,
            materialTemplateCacheKey,
            getMaterialPayloads,
            countMaterialTextureSlots,
            getOrCreateMaterialRegistryEntry,
            refreshMaterialRegistry,
            materialRegistryHudStats,
            getMaterialRegistryStats,
            getMaterialRegistryEntries,
            resolveSnapshotMaterialRefs,
            shouldRouteBlackSpecularToLambert,
            createMaterial,
            createSceneMaterial,
            createDefaultSceneMaterial,
            materialPayloadHasHTMLAutoFit,
            nodePayloadHasHTMLAutoFit,
            disposeSceneMaterial,
            collectMaterialRefs,
            collectLiveSceneMaterials,
            flushMaterialDisposals,
            createSceneLineMaterial,
            sceneMaterialSignature,
            isCachedMaterialTemplate,
            createSceneRenderableMaterial,
            cloneGeometryGroups,
            applyGeometryGroups,
            geometryGroupsMatch,
            resolveInstancedNodeGeometry,
            isGeometrySharedByAnotherMesh,
            syncGeometryGroupsForNode,
            applyFastMaterialPayload,
            stampSceneMaterial,
            ensureSceneRenderableMaterial,
        };
}

export { createMaterials };
