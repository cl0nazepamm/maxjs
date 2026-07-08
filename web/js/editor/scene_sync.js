// scene_sync.js - editor scene sync, geometry updates, binary deltas, and instance buckets.
import * as THREE from 'three';
import { applyDeltaFrame } from '../protocol.js';
import {
    attachSkinAttributes,
    binInRange,
    buildSkinnedMeshFromNd as buildSkinnedMeshFromBinary,
    geometryFromNodeBinary,
    typedArrayCanStore,
    updateFloatGeometryAttribute,
    updateGeometryIndexAttribute,
} from '../scene_binary.js';
import { gpuRecomputeNormals, gpuNormalsInvalidate, isGpuNormalsDisabled } from '../gpu_normals.js';
import { maxTimeline } from '../maxjs_timeline.js';
import { copyMaxComponentsToWorld } from '../scene_space.js';

function createSceneSync(deps = {}) {
        let gpuNormalsAnnounced = false;
        let firstSync = true;
        let lastMaxInstanceBucketSignature = '';
        // Host wiring: binary shared-buffer routes (zero-copy geometry) are
        // registered per payload type here; the window/webview event listeners
        // live in host_bridge.installHostWiring().
        deps.hostBridge.onSharedBuffer('delta_bin', (buf, meta) => {
                        handleBinaryDelta(buf, meta);
        });
        deps.hostBridge.onSharedBuffer('geo_fast', (buf, meta) => {
                        // Real-time vertex update — in-place when topology matches
                        const mesh = deps.nodeMap.get(meta.h);
                        if (mesh) {
                            if (meta.jsmod != null) deps.applyJsmodSyncState(mesh, meta.jsmod === true);
                            if (!mesh.userData.jsmod) {
                            const pos = mesh.geometry.getAttribute('position');
                            const wantsLine = !!meta.spline;
                            const hasLine = !!(mesh.isLine || mesh.isLineSegments);
                            const vertCount = meta.vN / 3;
                            const hasIncomingIndex = meta.iOff != null && meta.iN != null;
                            const idxCount = hasIncomingIndex ? meta.iN : 0;
                            const existingIdx = mesh.geometry.getIndex();
                            const skipBounds = !!(meta.skipBounds || meta.compactChannels);
                            const sameTopology = wantsLine === hasLine
                                && pos
                                && pos.count === vertCount
                                && (!hasIncomingIndex || (existingIdx && existingIdx.count === idxCount));
                            const incomingVertexColors = normalizeVertexColorDescriptors(meta.vc);
                            const oldGroups = deps.cloneGeometryGroups(mesh.geometry);
                            const applyIncomingGroups = () => {
                                if (deps.applyGeometryGroups(mesh.geometry, meta.groups)) return;
                                if (oldGroups.length && (!Array.isArray(mesh.geometry.groups) || mesh.geometry.groups.length === 0)) {
                                    deps.applyGeometryGroups(mesh.geometry, oldGroups);
                                }
                            };
                            const applyIncomingMaterial = () => {
                                deps.applyFastMaterialPayload(mesh, meta, wantsLine);
                            };

                            if (sameTopology) {
                                // Hot path: copy positions into existing GPU buffer
                                updateFloatGeometryAttribute(mesh.geometry, 'position', buf, meta.vOff, meta.vN, 3);

                                if (hasIncomingIndex && existingIdx) {
                                    updateGeometryIndexAttribute(mesh.geometry, buf, meta.iOff, meta.iN);
                                    // Index contents changed in place — the GPU
                                    // normal adjacency cache is keyed by geometry
                                    // and must not survive a connectivity rewrite.
                                    gpuNormalsInvalidate(mesh.geometry);
                                }

                                if (meta.uvOff != null && meta.uvN) {
                                    updateFloatGeometryAttribute(mesh.geometry, 'uv', buf, meta.uvOff, meta.uvN, 2);
                                }

                                if (meta.nOff != null && meta.nN) {
                                    updateFloatGeometryAttribute(mesh.geometry, 'normal', buf, meta.nOff, meta.nN, 3);
                                } else if (skipBounds) {
                                    // Position-only deform update: rebuild normals in
                                    // a WebGPU compute pass instead of leaving them
                                    // frozen. No-op on the WebGL fallback backend.
                                    if (!gpuRecomputeNormals(deps.renderer, mesh) &&
                                        gpuNormalsAnnounced && isGpuNormalsDisabled()) {
                                        // Compute path died at runtime — tell the
                                        // plugin to resume CPU normal streaming.
                                        gpuNormalsAnnounced = false;
                                        window.chrome?.webview?.postMessage({ type: 'gpu_normals', enabled: false });
                                    }
                                }

                                setGeometryVertexColorAttributes(mesh.geometry, incomingVertexColors, buf);

                                // skipBounds signals a deformation-only fast update:
                                // bounding volumes are the hot path cost for skinned
                                // meshes at 60fps and drive nothing visible here
                                // (frustum culling is off).
                                if (!skipBounds) {
                                    mesh.geometry.computeBoundingBox();
                                    mesh.geometry.computeBoundingSphere();
                                }
                                applyIncomingGroups();
                            } else {
                                if (!hasIncomingIndex) return;
                                // Topology changed — full rebuild
                                const oldUv = mesh.geometry.getAttribute('uv');
                                const oldNormal = mesh.geometry.getAttribute('normal');
                                const verts = new Float32Array(new Float32Array(buf, meta.vOff, meta.vN));
                                const idx = new Uint32Array(new Int32Array(buf, meta.iOff, meta.iN));
                                const geom = new THREE.BufferGeometry();
                                geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
                                geom.setIndex(new THREE.BufferAttribute(idx, 1));
                                if (meta.uvOff != null && meta.uvN) {
                                    const uvs = new Float32Array(new Float32Array(buf, meta.uvOff, meta.uvN));
                                    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
                                } else if (meta.compactChannels && oldUv && oldUv.count === vertCount) {
                                    geom.setAttribute('uv', oldUv.clone());
                                }
                                if (meta.nOff != null && meta.nN) {
                                    const norms = new Float32Array(new Float32Array(buf, meta.nOff, meta.nN));
                                    geom.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
                                } else if (meta.compactChannels && oldNormal && oldNormal.count === vertCount) {
                                    geom.setAttribute('normal', oldNormal.clone());
                                } else if (!meta.compactChannels) {
                                    geom.computeVertexNormals();
                                }
                                setGeometryVertexColorAttributes(geom, incomingVertexColors, buf);
                                if (meta.compactChannels) {
                                    if (mesh.geometry.boundingBox) geom.boundingBox = mesh.geometry.boundingBox.clone();
                                    if (mesh.geometry.boundingSphere) geom.boundingSphere = mesh.geometry.boundingSphere.clone();
                                } else {
                                    geom.computeBoundingSphere();
                                }
                                mesh.geometry.dispose();
                                mesh.geometry = geom;
                                applyIncomingGroups();
                                if (meta.nOff == null && meta.compactChannels) {
                                    // Rebuilt topology carried no normals (cloned
                                    // stale ones above) — refresh them on the GPU.
                                    gpuRecomputeNormals(deps.renderer, mesh);
                                }
                            }
                            applyIncomingMaterial();
                            // Geometry data on the same Object3D — no pipeline
                            // rebuild needed regardless of which branch ran.
                            deps.maxjsFx?.markGeometryDataDirty?.();
                            deps.markLightProbeSceneDirty();
                            deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
                            deps.schedulePathTracingLiveRebuild();
                            }
                        }
        });
        deps.hostBridge.onSharedBufferFallback((buf, meta) => {
                        handleBinaryScene(buf, meta);
        });

        function finalizeSceneNode(mesh, nd) {
            if (nd?.h != null && getMaxInstanceBucketForHandle(nd.h)) {
                return updateMaxInstanceBucketNode(nd.h, nd);
            }
            if (mesh && nd && nd.h != null) mesh.userData.maxjsHandle = nd.h;
            deps.applyJsmodSyncState(mesh, !!nd.jsmod);
            deps.applyUserPropsSyncState(mesh, nd.userProps);
            deps.applyInstanceSyncState(mesh, nd.instOf);
            const visibilityChanged = deps.applyBridgeVisibility(mesh, nd.vis);
            mesh.frustumCulled = false;
            if (!nd.spline) deps.applyMeshShadowState(mesh);
            deps.applyNodeProps(mesh, nd.props);
            const transformChanged = applyTransform(mesh, nd.t);
            applySelection(mesh, nd.s);
            return !!(visibilityChanged || transformChanged);
        }

        function applyIncrementalNodeUpdate(mesh, nd, handleOverride = null) {
            if (!mesh || !nd) return;
            const handle = handleOverride ?? nd.h ?? null;
            if (handle != null && getMaxInstanceBucketForHandle(handle)) {
                updateMaxInstanceBucketNode(handle, nd);
                return;
            }
            if (handle != null) mesh.userData.maxjsHandle = handle;
            if (nd.helper === true) mesh.userData.maxjsHelper = true;
            if (Object.prototype.hasOwnProperty.call(nd, 'p')) syncNodeParent(mesh, nd);
            if (nd.jsmod != null) deps.applyJsmodSyncState(mesh, nd.jsmod === true);
            if (nd.userProps != null) deps.applyUserPropsSyncState(mesh, nd.userProps);
            if (nd.vis != null) deps.applyBridgeVisibility(mesh, nd.vis);
            if (isFiniteArray(nd.t, 16)) {
                const hadHTMLAutoFit = !!mesh.userData?.maxjsHasHTMLAutoFit;
                const oldScaleSignature = hadHTMLAutoFit
                    ? deps.matrixScaleSignature(mesh.userData?.maxjsLastNodePayload?.t)
                    : '';
                applyTransform(mesh, nd.t);
                if (hadHTMLAutoFit) {
                    const lastPayload = mesh.userData?.maxjsLastNodePayload;
                    if (lastPayload) {
                        lastPayload.t = nd.t;
                        if (deps.matrixScaleSignature(nd.t) !== oldScaleSignature) {
                            deps.ensureSceneRenderableMaterial(mesh, lastPayload, !!lastPayload.spline);
                        }
                    }
                }
            }
            if (nd.s != null) applySelection(mesh, nd.s);
            // Max never intends scalar pushes for Multi/Sub nodes (a single
            // color/rough/metal set would smear across every sub-material).
            // Guard here too: a delta can land while the mesh is still
            // multi-material mid-reassignment, before the full sync applies.
            if (nd.mat && mesh.material
                && !(Array.isArray(mesh.material) && mesh.material.length > 1)) {
                applyMaterialScalar(mesh, nd.mat);
            }
        }

        function buildNodeGeometryRefCounts() {
            const counts = new Map();
            for (const mesh of deps.nodeMap.values()) {
                const geom = mesh?.geometry;
                if (!geom) continue;
                counts.set(geom, (counts.get(geom) || 0) + 1);
            }
            return counts;
        }

        function retainGeometryRef(refCounts, geom) {
            if (!refCounts || !geom) return;
            refCounts.set(geom, (refCounts.get(geom) || 0) + 1);
        }

        function releaseGeometryRef(refCounts, geom) {
            if (!refCounts || !geom) return;
            const next = (refCounts.get(geom) || 0) - 1;
            if (next <= 0) {
                refCounts.delete(geom);
                geom.dispose?.();
            } else {
                refCounts.set(geom, next);
            }
        }

        function disposeMaxInstanceBuckets() {
            for (const [, bucket] of deps.maxInstanceBuckets) {
                if (bucket.mesh?.parent) bucket.mesh.parent.remove(bucket.mesh);
                // Geometry is shared with the source mesh. Materials are owned
                // per bucket so sibling buckets cannot overwrite each other's
                // assignments through a shared source material.
                if (bucket.ownsMaterial) deps.disposeSceneMaterial(bucket.mesh?.material);
            }
            deps.maxInstanceBuckets.clear();
            deps.maxInstanceHandleToBucket.clear();
            lastMaxInstanceBucketSignature = '';
            // Restore visibility on nodes that were hidden by bucket merge
            for (const [, mesh] of deps.nodeMap) {
                if (mesh && !mesh.visible && mesh.userData?.maxjsInstOf) {
                    mesh.visible = true;
                }
            }
        }

        function getMaxInstanceBucketForHandle(handle) {
            const bucketKey = deps.maxInstanceHandleToBucket.get(handle);
            return bucketKey ? deps.maxInstanceBuckets.get(bucketKey) ?? null : null;
        }

        const maxInstanceMatrixScratch = new THREE.Matrix4();

        function matrixArraysAlmostEqual(a, b, eps = 1.0e-7) {
            if (!a || !b || a.length < 16 || b.length < 16) return false;
            for (let i = 0; i < 16; i++) {
                if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > eps) return false;
            }
            return true;
        }

        function updateMaxInstanceBucketVisibility(bucket) {
            if (!bucket?.mesh) return;
            // Compact: rebuild instance matrices with only visible entries
            let slot = 0;
            for (const handle of bucket.handles) {
                bucket.handleToIndex.set(handle, -1);
                if (bucket.visible.get(handle) === false) continue;
                const xf = bucket.transforms.get(handle);
                if (xf) maxInstanceMatrixScratch.fromArray(xf);
                else maxInstanceMatrixScratch.identity();
                bucket.handleToIndex.set(handle, slot);
                bucket.mesh.setMatrixAt(slot, maxInstanceMatrixScratch);
                slot++;
            }
            bucket.mesh.count = slot;
            bucket.mesh.visible = slot > 0;
            bucket.mesh.instanceMatrix.needsUpdate = true;
        }

        function updateMaxInstanceBucketTransform(handle, matrixArray) {
            const bucket = getMaxInstanceBucketForHandle(handle);
            if (!bucket || !isFiniteArray(matrixArray, 16)) return false;
            const idx = bucket.handleToIndex.get(handle);
            if (idx == null) return false;
            const previous = bucket.transforms.get(handle);
            if (matrixArraysAlmostEqual(previous, matrixArray)) return false;
            if (previous) {
                for (let i = 0; i < 16; i++) previous[i] = matrixArray[i];
            } else {
                bucket.transforms.set(handle, Array.from(matrixArray));
            }
            if (bucket.visible.get(handle) === false || idx < 0) return false;
            maxInstanceMatrixScratch.fromArray(matrixArray);
            bucket.mesh.setMatrixAt(idx, maxInstanceMatrixScratch);
            bucket.mesh.instanceMatrix.needsUpdate = true;
            return true;
        }

        function updateMaxInstanceBucketNode(handle, nd) {
            const bucket = getMaxInstanceBucketForHandle(handle);
            if (!bucket) return false;
            let changed = false;
            if (nd.vis != null) {
                const nextVisible = !!nd.vis;
                if (bucket.visible.get(handle) !== nextVisible) {
                    bucket.visible.set(handle, nextVisible);
                    updateMaxInstanceBucketVisibility(bucket);
                    changed = true;
                }
            }
            if (isFiniteArray(nd.t, 16)) {
                if (updateMaxInstanceBucketTransform(handle, nd.t)) changed = true;
            }
            if (nd.mat) {
                const materialSignature = deps.materialIdentityKey(nd.mat);
                if (bucket.lastMaterialScalarSignature !== materialSignature) {
                    applyMaterialScalar(bucket.mesh, nd.mat);
                    bucket.lastMaterialScalarSignature = materialSignature;
                    bucket.materialKey = materialSignature;
                    changed = true;
                }
            }
            return changed;
        }

        function createMaxInstanceBucketMaterial(group, sourceMesh) {
            const materialPayload = group?.nodes?.[0] ?? null;
            return deps.createSceneRenderableMaterial(materialPayload, false, sourceMesh?.geometry ?? null, null);
        }

        function computeMaxInstanceBucketGroups(nodes) {
            const groups = new Map();
            if (!deps.performanceSettings.optimizeMaxInstances) return groups;
            for (const nd of nodes) {
                if (!Number.isFinite(nd?.instOf) || nd.instOf <= 0) continue;
                if (nd.jsmod || nd.spline || nd.skin || nd.groups || nd.mats) continue;
                const sourceHandle = nd.instOf;
                const materialKey = nd.mat ? deps.materialIdentityKey(nd.mat) : '__default__';
                const bucketKey = `${sourceHandle}|${materialKey}`;
                if (!groups.has(bucketKey)) {
                    groups.set(bucketKey, {
                        key: bucketKey,
                        sourceHandle,
                        materialKey,
                        nodes: [],
                    });
                }
                groups.get(bucketKey).nodes.push(nd);
            }
            for (const [key, group] of [...groups.entries()]) {
                if (group.nodes.length < Math.max(1, deps.performanceSettings.maxInstanceBucketThreshold)) {
                    groups.delete(key);
                }
            }
            return groups;
        }

        function planMaxInstanceBuckets(snapshotNodes) {
            const bucketGroups = computeMaxInstanceBucketGroups(snapshotNodes);
            const nodeByHandle = new Map();
            for (const nd of snapshotNodes) nodeByHandle.set(nd.h, nd);
            let signature = '';
            const bucketHandles = new Set();
            if (bucketGroups.size > 0) {
                const parts = [];
                for (const group of bucketGroups.values()) {
                    const handles = group.nodes.map((nd) => nd.h).sort((a, b) => a - b);
                    for (const handle of handles) bucketHandles.add(handle);
                    const sourceMaterialSig = deps.sceneMaterialSignature(nodeByHandle.get(group.sourceHandle), false);
                    parts.push(`${group.key}@${sourceMaterialSig}#${group.nodes.length}:${handles.join(',')}`);
                }
                parts.sort();
                signature = parts.join('||');
            }
            return { groups: bucketGroups, signature, handles: bucketHandles };
        }

        function buildMaxInstanceBuckets(snapshotNodes, bucketPlan = null) {
            const plan = bucketPlan ?? planMaxInstanceBuckets(snapshotNodes);
            const bucketGroups = plan.groups;
            const signature = plan.signature;

            if (signature === lastMaxInstanceBucketSignature) {
                // Composition unchanged — keep existing buckets, let per-handle
                // transform / visibility / material updates flow through
                // updateMaxInstanceBucketNode without reallocating meshes.
                return false;
            }

            disposeMaxInstanceBuckets();
            lastMaxInstanceBucketSignature = signature;
            if (bucketGroups.size === 0) return true;

            for (const group of bucketGroups.values()) {
                const sourceMesh = deps.nodeMap.get(group.sourceHandle);
                if (!sourceMesh?.geometry || sourceMesh.isLine || sourceMesh.isLineSegments || sourceMesh.isSkinnedMesh) continue;
                const bucketMaterial = createMaxInstanceBucketMaterial(group, sourceMesh);
                const mesh = new THREE.InstancedMesh(sourceMesh.geometry, bucketMaterial, group.nodes.length);
                mesh.matrixAutoUpdate = false;
                mesh.frustumCulled = false;
                mesh.castShadow = !!sourceMesh.castShadow;
                mesh.receiveShadow = !!sourceMesh.receiveShadow;
                mesh.name = `max_instances_${group.sourceHandle}_x${group.nodes.length}`;

                const bucket = {
                    mesh,
                    materialKey: group.materialKey,
                    sourceHandle: group.sourceHandle,
                    handles: new Set(),
                    handleToIndex: new Map(),
                    transforms: new Map(),
                    visible: new Map(),
                    lastMaterialScalarSignature: group.nodes[0]?.mat ? deps.materialIdentityKey(group.nodes[0].mat) : '',
                    ownsMaterial: true,
                };

                group.nodes.forEach((nd, index) => {
                    bucket.handles.add(nd.h);
                    bucket.handleToIndex.set(nd.h, index);
                    bucket.transforms.set(nd.h, isFiniteArray(nd.t, 16) ? Array.from(nd.t) : null);
                    bucket.visible.set(nd.h, nd.vis == null ? true : !!nd.vis);
                    const matrix = new THREE.Matrix4();
                    if (isFiniteArray(nd.t, 16)) matrix.fromArray(nd.t);
                    else matrix.identity();
                    mesh.setMatrixAt(index, matrix);
                    deps.maxInstanceHandleToBucket.set(nd.h, group.key);
                    const original = deps.nodeMap.get(nd.h);
                    if (original && original !== sourceMesh) original.visible = false;
                });

                updateMaxInstanceBucketVisibility(bucket);
                deps.maxRoot.add(mesh);
                deps.maxInstanceBuckets.set(group.key, bucket);
            }
            return true;
        }

        function profileSceneNodes(nodes) {
            if (!deps.debugMode || deps.buildMode === 'release' || !deps.isSceneProfilingEnabled()) return;
            const stats = [];
            for (const nd of nodes) {
                const mesh = deps.nodeMap.get(nd.h);
                if (!mesh) continue;
                const verts = nd.geo?.vN || nd.v?.length || 0;
                const matCount = Array.isArray(mesh.material) ? mesh.material.length : 1;
                const geom = mesh.geometry;
                const triCount = geom?.index
                    ? Math.floor(geom.index.count / 3)
                    : Math.floor((geom?.attributes?.position?.count || 0) / 3);
                stats.push({
                    name: nd.n || `h:${nd.h}`,
                    handle: nd.h,
                    verts: Math.floor(verts / 3),
                    tris: triCount,
                    materials: matCount,
                    instOf: nd.instOf || 0,
                    skinned: !!nd.skin,
                    spline: !!nd.spline,
                });
            }
            if (stats.length === 0) return;
            stats.sort((a, b) => b.tris - a.tris);
            const top = stats.slice(0, 10);
            console.groupCollapsed(`[max.js Profile] ${stats.length} nodes, top 10 by tri count`);
            console.table(top);
            const totalTris = stats.reduce((s, n) => s + n.tris, 0);
            const totalVerts = stats.reduce((s, n) => s + n.verts, 0);
            console.log(`Total: ${totalVerts} verts, ${totalTris} tris, ${stats.length} nodes`);
            const materialStats = deps.getMaterialRegistryStats();
            console.log('[max.js Profile] material registry', {
                uniqueMaterials: materialStats.uniqueMaterials,
                materialTemplates: materialStats.materialTemplates,
                materialRefs: materialStats.materialRefs,
                bucketedRefs: materialStats.bucketedRefs,
                instanceBuckets: materialStats.instanceBuckets,
                maxRefsPerMaterial: materialStats.maxRefsPerMaterial,
            });
            console.groupEnd();
        }

        function findSnapshotSkySunDirection(lightsData) {
            const directional = (Array.isArray(lightsData) ? lightsData : [])
                .filter(light => light?.type === 0 && light.v !== false && light.v !== 0 && Array.isArray(light.dir));
            if (!directional.length) return null;
            const named = directional.find((light) => {
                const name = String(light.name || '').toLowerCase();
                return /\b(sun|sunlight|solar|daylight)\b/.test(name)
                    || name.includes('sun')
                    || name.includes('solar')
                    || name.includes('daylight');
            });
            const light = named || (directional.length === 1 ? directional[0] : null);
            if (!light) return null;
            const dir = light.dir;
            const world = copyMaxComponentsToWorld(
                new THREE.Vector3(),
                -Number(dir[0]),
                -Number(dir[1]),
                -Number(dir[2]),
            );
            return world.lengthSq() > 1.0e-8 ? world.normalize().toArray() : null;
        }

        function withSnapshotLinkedSkySun(env, lightsData) {
            if (!env?.sky) return env;
            const sunDirectionWorld = findSnapshotSkySunDirection(lightsData);
            if (!sunDirectionWorld) return env;
            return {
                ...env,
                sky: {
                    ...env.sky,
                    sunDirectionWorld,
                    sunLinkedLight: true,
                },
            };
        }

        function finalizeSceneSnapshot(snapshot, transport, applyStart, producerBytes, options = {}) {
            deps.resolveSnapshotMaterialRefs(snapshot);
            if (snapshot.camera) deps.applyCamera(snapshot.camera);
            const snapshotEnv = withSnapshotLinkedSkySun(snapshot.env, snapshot.lights);
            if (snapshotEnv?.sky) {
                deps.applySky(snapshotEnv.sky);
            } else if (snapshotEnv?.hdri) {
                deps.removeSky();
                deps.loadHDRI(snapshotEnv);
            } else if (snapshotEnv?.enabled === false || snapshotEnv?.type === 'none') {
                deps.removeAuthoredEnvironment();
            }
            if (snapshot.fog) deps.maxjsFx.setFogFromScene(snapshot.fog);
            const lightsChanged = snapshot.lights ? deps.applyLights(snapshot.lights) : false;
            if (snapshot.sceneCameras) deps.updateSceneCameraList(snapshot.sceneCameras, snapshot.lockedCamera);
            deps.reconcileSplats(snapshot.splats ?? []);
            deps.audioSystem?.applyAudios(snapshot.audios ?? []);
            deps.gltfSystem?.applyGLTFs(snapshot.gltfs ?? []);
            deps.webappSystem?.applyWebApps(snapshot.webapps ?? []);
            deps.applyHairInstances(snapshot.hairInstances ?? []);
            deps.applyForestInstances(snapshot.forestInstances ?? [], options.binaryBuffer ?? null);
            deps.applyVolumes(snapshot.volumes ?? []);
            const bucketPlan = options.bucketPlan ?? planMaxInstanceBuckets(snapshot.nodes);
            deps.refreshMaterialRegistry(snapshot.nodes, bucketPlan);
            const bucketChanged = buildMaxInstanceBuckets(snapshot.nodes, bucketPlan);
            profileSceneNodes(snapshot.nodes);
            deps.scene.updateMatrixWorld(options.forceWorldUpdate === true);
            const sceneChanged = !!(options.sceneChanged || bucketChanged);
            if (sceneChanged) {
                deps.lightLinking.refreshSceneBindings?.();
                deps.markLightProbeSceneDirty();
            } else if (lightsChanged) {
                deps.markLightProbeLightsDirty();
                deps.maxjsFx.markOutputChanged?.();
            }
            if (sceneChanged || lightsChanged) {
                deps.scheduleLightProbeFromCurrentScene();
            }
            if (deps.pathTracingFx.isEnabled?.()) {
                deps.resetPathTracingStartupWarmup();
                deps.markPathTracingSceneDirtyNow();
            }
            // Full snapshot can add/remove many meshes — cheap scene refresh.
            // Effect toggles, env, and deps.renderer size have their own dedicated
            // entry points, so a full pipeline rebuild is unnecessary here.
            if (sceneChanged) deps.maxjsFx.markSceneChanged?.();
            options.afterWorldUpdate?.();
            deps.syncHaloProbeVolumes();

            if (firstSync && snapshot.nodes.length > 0) {
                firstSync = false;
                if (!deps.camLock) deps.fitCamera();
            }
            const applyMs = performance.now() - applyStart;
            deps.markInitialSync();
            deps.updateSyncHud({
                transport,
                frameId: snapshot.frame ?? 0,
                producerBytes,
                decodeMs: 0,
                applyMs,
            });
        }


        // ── Scene Sync ──────────────────────────────────────
        deps.bridge.on('scene', msg => {
            deps.resolveSnapshotMaterialRefs(msg);
            deps.setTransportMode('json');
            const applyStart = performance.now();
            const incoming = new Set(msg.nodes.map(n => n.h));
            const bucketPlan = planMaxInstanceBuckets(msg.nodes);
            const stableBucketHandles = bucketPlan.signature === lastMaxInstanceBucketSignature
                ? bucketPlan.handles
                : null;
            let sceneChanged = false;
            let transformsChanged = false;

            for (const [handle, mesh] of deps.nodeMap) {
                if (!incoming.has(handle)) {
                    removeMaxNodeObject(mesh);
                    mesh.geometry?.dispose?.();
                    deps.disposeSceneMaterial(mesh.material);
                    deps.nodeMap.delete(handle);
                    sceneChanged = true;
                }
            }

            for (const nd of msg.nodes) {
                let mesh = deps.nodeMap.get(nd.h);
                if (nd.helper === true) {
                    ensureTransformOnlyNode(nd, mesh);
                    transformsChanged = true;
                    continue;
                }

                if (stableBucketHandles?.has(nd.h) && getMaxInstanceBucketForHandle(nd.h)) {
                    if (updateMaxInstanceBucketNode(nd.h, nd)) transformsChanged = true;
                    if (mesh) {
                        deps.applyJsmodSyncState(mesh, !!nd.jsmod);
                        deps.applyUserPropsSyncState(mesh, nd.userProps);
                        deps.applyInstanceSyncState(mesh, nd.instOf);
                        if (nd.s != null) applySelection(mesh, nd.s);
                    }
                    continue;
                }

                const jsmodFlag = !!nd.jsmod;
                // jsmod flag: layers own vertices — skip geo rebuild for existing meshes
                const jsmodSkipGeo = jsmodFlag && mesh;
                const instSrcMesh = nd.instOf ? deps.nodeMap.get(nd.instOf) : null;

                // Geometry: only rebuild if vertex data is present (skip for cached nodes)
                let geom = mesh?.geometry;
                if (nd.instOf && !nd.v) {
                    const srcGeom = instSrcMesh?.geometry;
                    if (srcGeom) geom = deps.resolveInstancedNodeGeometry(nd, srcGeom, { cloneForJsmod: jsmodFlag });
                } else if (nd.v && nd.i && !jsmodSkipGeo) {
                    geom = buildGeometry(nd.v, nd.i, nd.uv, nd.norm, {
                        isLine: !!nd.spline,
                        vertexColors: nd.vc,
                        uv2s: nd.uv2,
                    });
                    deps.applyGeometryGroups(geom, nd.groups);
                } else if (geom && nd.groups) {
                    // Never rewrites groups on a geometry other meshes share.
                    geom = deps.syncGeometryGroupsForNode(mesh, geom, nd.groups);
                }

                const wantsLine = !!nd.spline;
                const hasLineRenderable = !!(mesh?.isLine || mesh?.isLineSegments);
                const renderableTypeMismatch = !!mesh && wantsLine !== hasLineRenderable;
                if (renderableTypeMismatch) {
                    removeMaxNodeObject(mesh);
                    mesh.geometry?.dispose?.();
                    deps.disposeSceneMaterial(mesh.material);
                    deps.nodeMap.delete(nd.h);
                    mesh = null;
                    sceneChanged = true;
                }

                if (mesh) {
                    if (!jsmodSkipGeo && geom && geom !== mesh.geometry) {
                        // Old geometry may be shared with instance siblings —
                        // only dispose it once no other mesh references it.
                        if (!deps.isGeometrySharedByAnotherMesh(mesh.geometry, mesh)) {
                            mesh.geometry.dispose();
                        }
                        mesh.geometry = geom;
                    }
                    if (deps.ensureSceneRenderableMaterial(mesh, nd, wantsLine, { authoritativeMaterial: true })) {
                        sceneChanged = true;
                        deps.layerManager.applyMaterialOverrides?.(nd.h, mesh);
                    }
                } else {
                    if (!geom) continue;
                    const material = deps.createSceneRenderableMaterial(nd, wantsLine, geom);
                    if (wantsLine) {
                        mesh = new THREE.LineSegments(geom, material);
                    } else {
                        mesh = new THREE.Mesh(geom, material);
                    }
                    mesh.matrixAutoUpdate = false;
                    mesh.name = nd.n;
                    mesh.frustumCulled = false;
                    mesh.userData.maxjsHandle = nd.h;
                    deps.stampSceneMaterial(mesh, nd, wantsLine);
                    syncNodeParent(mesh, nd);
                    deps.nodeMap.set(nd.h, mesh);
                    sceneChanged = true;
                    deps.layerManager.applyMaterialOverrides?.(nd.h, mesh);
                }

                syncNodeParent(mesh, nd);
                if (finalizeSceneNode(mesh, nd)) transformsChanged = true;
            }

            if (transformsChanged || sceneChanged) deps.layerManager.markRuntimeTransformsDirty?.();
            finalizeSceneSnapshot(msg, 'json', applyStart, msg.stats?.producerBytes ?? 0, {
                bucketPlan,
                sceneChanged,
            });
        });

        deps.bridge.on('geo_fast', msg => {
            const mesh = deps.nodeMap.get(msg.h);
            if (!mesh) return;
            if (msg.jsmod != null) deps.applyJsmodSyncState(mesh, msg.jsmod === true);
            if (mesh.userData.jsmod) return;  // layers own vertices
            const wantsLine = !!msg.spline;
            const hasLine = !!(mesh.isLine || mesh.isLineSegments);
            const oldGroups = deps.cloneGeometryGroups(mesh.geometry);

            // Type changed (spline ↔ mesh) — need full rebuild, can't just swap geometry
            if (wantsLine !== hasLine) {
                const oldMaterial = mesh.material;
                const previousPayload = mesh.userData?.maxjsLastNodePayload || {};
                const previousName = mesh.name;
                const previousMatrix = mesh.matrix?.clone?.();
                const previousMatrixWorld = mesh.matrixWorld?.clone?.();
                removeMaxNodeObject(mesh);
                mesh.geometry?.dispose?.();
                const geom = buildGeometry(msg.v, msg.i, msg.uv, msg.norm, {
                    isLine: wantsLine,
                    vertexColors: msg.vc,
                });
                if (!deps.applyGeometryGroups(geom, msg.groups) && oldGroups.length) {
                    deps.applyGeometryGroups(geom, oldGroups);
                }
                let newMesh;
                let material = null;
                let materialPayload = null;
                if (Array.isArray(msg.groups) && Array.isArray(msg.mats)) {
                    materialPayload = {
                        ...previousPayload,
                        h: msg.h,
                        n: previousName,
                        t: previousMatrix?.elements,
                        groups: msg.groups,
                        mats: msg.mats,
                    };
                    delete materialPayload.mat;
                    delete materialPayload.matRef;
                    delete materialPayload.matRefs;
                    material = deps.createSceneRenderableMaterial(materialPayload, wantsLine, geom, mesh);
                }
                if (wantsLine) {
                    newMesh = new THREE.LineSegments(geom, material || new THREE.LineBasicMaterial({ color: 0xffffff }));
                } else {
                    newMesh = new THREE.Mesh(geom, material || new THREE.MeshStandardMaterial());
                }
                newMesh.matrixAutoUpdate = false;
                newMesh.name = previousName;
                newMesh.frustumCulled = false;
                newMesh.userData.maxjsHandle = msg.h;
                newMesh.userData.maxjsLastNodePayload = previousPayload;
                if (previousMatrix) newMesh.matrix.copy(previousMatrix);
                if (previousMatrixWorld) newMesh.matrixWorld.copy(previousMatrixWorld);
                deps.maxRoot.add(newMesh);
                deps.nodeMap.set(msg.h, newMesh);
                if (materialPayload) deps.stampSceneMaterial(newMesh, materialPayload, wantsLine);
                deps.disposeSceneMaterial(oldMaterial);
                // Renderable-type swap (mesh ↔ line) — scene structure changed,
                // refresh the post-pass hide list / toon cache. Cheap.
                deps.maxjsFx.markSceneChanged?.();
                deps.markLightProbeSceneDirty();
                deps.scheduleLightProbeFromCurrentScene();
                deps.schedulePathTracingLiveRebuild();
                return;
            }

            const oldUv = mesh.geometry?.getAttribute?.('uv');
            const oldNormal = mesh.geometry?.getAttribute?.('normal');
            const oldBoundingBox = mesh.geometry?.boundingBox?.clone?.();
            const oldBoundingSphere = mesh.geometry?.boundingSphere?.clone?.();
            const geom = buildGeometry(msg.v, msg.i, msg.uv, msg.norm, {
                isLine: wantsLine,
                vertexColors: msg.vc,
                skipNormalCompute: !!msg.compactChannels,
                skipBoundsCompute: !!msg.compactChannels,
            });
            if (!deps.applyGeometryGroups(geom, msg.groups) && oldGroups.length) {
                deps.applyGeometryGroups(geom, oldGroups);
            }
            if (msg.compactChannels) {
                const vertCount = Math.floor((msg.v?.length || 0) / 3);
                if (!msg.uv && oldUv && oldUv.count === vertCount) {
                    geom.setAttribute('uv', oldUv.clone());
                }
                if (!msg.norm && oldNormal && oldNormal.count === vertCount) {
                    geom.setAttribute('normal', oldNormal.clone());
                }
                if (oldBoundingBox) geom.boundingBox = oldBoundingBox;
                if (oldBoundingSphere) geom.boundingSphere = oldBoundingSphere;
            }
            mesh.geometry.dispose();
            mesh.geometry = geom;
            deps.applyFastMaterialPayload(mesh, msg, wantsLine);
            // Vertex / topology data on the same Object3D — no scene-structure
            // refresh, no pipeline rebuild. pass(scene, camera) picks up the new
            // BufferGeometry attributes on the next frame automatically.
            deps.maxjsFx.markGeometryDataDirty?.();
            deps.markLightProbeSceneDirty();
            deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
            deps.schedulePathTracingLiveRebuild();
        });

        // ── Transform Sync (+ material scalars, ~6fps) ──────
        deps.bridge.on('xform', msg => {
            const applyStart = performance.now();
            let visibilityChanged = false;
            let giSurfaceChanged = false;
            let pathTraceSceneChanged = false;
            for (const nd of msg.nodes) {
                const mesh = deps.nodeMap.get(nd.h);
                if (nd.vis != null) visibilityChanged = true;
                if (mesh) {
                    applyIncrementalNodeUpdate(mesh, nd);
                    if (nd.t || nd.mat || nd.vis != null) {
                        pathTraceSceneChanged = true;
                        giSurfaceChanged = true;
                    }
                }
                if (nd.t) {
                    deps.applyHairTransform(nd.h, nd.t);
                    pathTraceSceneChanged = true;
                }
                if (nd.vis != null) {
                    deps.applyHairVisibility(nd.h, nd.vis);
                    pathTraceSceneChanged = true;
                }
            }
            if (msg.lights) {
                applyLightUpdates(msg.lights);
                pathTraceSceneChanged = true;
            }
            if (msg.splats) {
                deps.applySplatUpdates(msg.splats);
                pathTraceSceneChanged = true;
            }
            if (msg.audios) deps.audioSystem?.applyAudioUpdates(msg.audios);
            if (msg.gltfs) {
                deps.gltfSystem?.applyGLTFUpdates(msg.gltfs);
                pathTraceSceneChanged = true;
            }
            if (msg.camera) deps.applyCamera(msg.camera);
            if (visibilityChanged) {
                // Visibility flip changes the post-pass hide list — cheap refresh.
                deps.maxjsFx.markSceneChanged?.();
            }
            if (giSurfaceChanged) {
                deps.markLightProbeSceneDirty();
                deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
            }
            if (pathTraceSceneChanged) deps.schedulePathTracingLiveRebuild();
            const applyMs = performance.now() - applyStart;
            deps.updateSyncHud({
                transport: 'json',
                frameId: msg.frame ?? 0,
                producerBytes: msg.stats?.producerBytes ?? 0,
                decodeMs: 0,
                applyMs,
            });
        });

        // ── Binary Scene Handler (SharedBuffer) ──────────────
        function handleBinaryScene(buffer, meta) {
            if (meta.type !== 'scene_bin') return;
            deps.resolveSnapshotMaterialRefs(meta);
            deps.setTransportMode('binary-scene');
            const applyStart = performance.now();
            const incoming = new Set(meta.nodes.map(n => n.h));
            const bucketPlan = planMaxInstanceBuckets(meta.nodes);
            const stableBucketHandles = bucketPlan.signature === lastMaxInstanceBucketSignature
                ? bucketPlan.handles
                : null;
            let sceneChanged = false;
            let transformsChanged = false;
            const geometryRefCounts = buildNodeGeometryRefCounts();

            // Remove deleted — collect first, then dispose non-shared geometries
            const toRemove = [];
            for (const [handle, mesh] of deps.nodeMap) {
                if (!incoming.has(handle)) toRemove.push(handle);
            }
            for (const handle of toRemove) {
                const mesh = deps.nodeMap.get(handle);
                removeMaxNodeObject(mesh);
                releaseGeometryRef(geometryRefCounts, mesh?.geometry);
                deps.disposeSceneMaterial(mesh?.material);
                deps.nodeMap.delete(handle);
                sceneChanged = true;
            }

            // Geometry cache for instance sharing within this sync
            const geoByHandle = new Map();

            for (const nd of meta.nodes) {
                let mesh = deps.nodeMap.get(nd.h);
                if (nd.helper === true) {
                    ensureTransformOnlyNode(nd, mesh);
                    transformsChanged = true;
                    continue;
                }

                if (stableBucketHandles?.has(nd.h) && getMaxInstanceBucketForHandle(nd.h)) {
                    if (updateMaxInstanceBucketNode(nd.h, nd)) transformsChanged = true;
                    if (mesh) {
                        deps.applyJsmodSyncState(mesh, !!nd.jsmod);
                        deps.applyUserPropsSyncState(mesh, nd.userProps);
                        deps.applyInstanceSyncState(mesh, nd.instOf);
                        if (nd.s != null) applySelection(mesh, nd.s);
                    }
                    continue;
                }

                const jsmodFlag = !!nd.jsmod;
                const instSrcMesh = nd.instOf ? deps.nodeMap.get(nd.instOf) : null;
                const sharesInstGeom = !!(mesh && instSrcMesh && mesh.geometry === instSrcMesh.geometry);
                // jsmod: skip host geo swap unless instanced mesh still shares master geometry (layers need a unique buffer)
                const jsmodSkipGeo = jsmodFlag && mesh && !sharesInstGeom;

                // Instance: share geometry from the source node (no new BufferGeometry)
                let geom = mesh?.geometry;
                if (nd.instOf && !nd.geo) {
                    const srcGeom = geoByHandle.get(nd.instOf) || instSrcMesh?.geometry;
                    if (srcGeom) geom = deps.resolveInstancedNodeGeometry(nd, srcGeom, { cloneForJsmod: jsmodFlag });
                } else if (nd.geo && !jsmodSkipGeo) {
                    geom = geometryFromNodeBinary(nd, buffer);
                    if (!geom) continue;
                    setGeometryVertexColorAttributes(geom, nd.geo.vc, buffer);
                    // Add material groups for Multi/Sub
                    deps.applyGeometryGroups(geom, nd.groups);
                    attachSkinAttributes(geom, nd, buffer);
                } else if (geom && nd.groups) {
                    // Geometry unchanged, but keep groups/material indexing synced.
                    // Never rewrites groups on a geometry other meshes share.
                    geom = deps.syncGeometryGroupsForNode(mesh, geom, nd.groups);
                }

                // Cache geometry for instance sharing (always, not just when new geo arrives)
                if (geom) geoByHandle.set(nd.h, geom);

                const wantsLine = !!nd.spline;
                if (mesh && nd.skin && !mesh.isSkinnedMesh && !wantsLine) {
                    removeMaxNodeObject(mesh);
                    releaseGeometryRef(geometryRefCounts, mesh?.geometry);
                    deps.disposeSceneMaterial(mesh.material);
                    deps.nodeMap.delete(nd.h);
                    mesh = null;
                    sceneChanged = true;
                }
                const hasLineRenderable = !!(mesh?.isLine || mesh?.isLineSegments);
                const renderableTypeMismatch = !!mesh && wantsLine !== hasLineRenderable;
                if (renderableTypeMismatch) {
                    removeMaxNodeObject(mesh);
                    releaseGeometryRef(geometryRefCounts, mesh?.geometry);
                    deps.disposeSceneMaterial(mesh.material);
                    deps.nodeMap.delete(nd.h);
                    mesh = null;
                    sceneChanged = true;
                }

                if (mesh) {
                    if (!jsmodSkipGeo && geom && geom !== mesh.geometry) {
                        releaseGeometryRef(geometryRefCounts, mesh.geometry);
                        retainGeometryRef(geometryRefCounts, geom);
                        mesh.geometry = geom;
                        if (deps.nodePayloadHasHTMLAutoFit(nd)) {
                            mesh.userData.maxjsMaterialSignature = null;
                        }
                    }
                    if (deps.ensureSceneRenderableMaterial(mesh, nd, wantsLine, { authoritativeMaterial: true })) {
                        sceneChanged = true;
                        deps.layerManager.applyMaterialOverrides?.(nd.h, mesh);
                    }
                } else {
                    if (!geom) continue;
                    const material = deps.createSceneRenderableMaterial(nd, wantsLine, geom);
                    if (wantsLine) {
                        mesh = new THREE.LineSegments(geom, material);
                    } else if (nd.skin) {
                        mesh = buildSkinnedMeshFromBinary({ nd, geom, material, buffer, nodeMap: deps.nodeMap });
                        if (!mesh) mesh = new THREE.Mesh(geom, material);
                    } else {
                        mesh = new THREE.Mesh(geom, material);
                    }
                    mesh.matrixAutoUpdate = false;
                    mesh.name = nd.n;
                    mesh.frustumCulled = false;
                    mesh.userData.maxjsHandle = nd.h;
                    deps.stampSceneMaterial(mesh, nd, wantsLine);
                    syncNodeParent(mesh, nd);
                    deps.nodeMap.set(nd.h, mesh);
                    retainGeometryRef(geometryRefCounts, mesh.geometry);
                    sceneChanged = true;
                    deps.layerManager.applyMaterialOverrides?.(nd.h, mesh);
                }

                syncNodeParent(mesh, nd);
                if (finalizeSceneNode(mesh, nd)) transformsChanged = true;
            }

            if (transformsChanged || sceneChanged) deps.layerManager.markRuntimeTransformsDirty?.();
            finalizeSceneSnapshot(meta, 'binary-scene', applyStart, meta.stats?.producerBytes ?? buffer.byteLength, {
                binaryBuffer: buffer,
                bucketPlan,
                sceneChanged,
                afterWorldUpdate() {
                    // Recalculate skeleton boneInverses for NEWLY created skinned meshes
                    // (only needed once — after the mesh is in the scene hierarchy under maxBasisRoot).
                    for (const mesh of deps.nodeMap.values()) {
                        if (mesh?.isSkinnedMesh && mesh.skeleton && !mesh.userData._skelBound) {
                            mesh.skeleton.calculateInverses();
                            mesh.bind(mesh.skeleton, mesh.matrixWorld);
                            mesh.userData._skelBound = true;
                        }
                    }
                    deps.animationSystem?.invalidateTargets();
                },
            });
        }

        function handleBinaryDelta(buffer, meta) {
            let runtimeTransformsChanged = false;
            let giSurfaceChanged = false;
            let pathTraceSceneChanged = false;
            const result = applyDeltaFrame(buffer, {
                onTransform(nodeHandle, matrix) {
                    const mesh = deps.nodeMap.get(nodeHandle);
                    if (mesh) applyIncrementalNodeUpdate(mesh, { t: matrix }, nodeHandle);
                    if (mesh) {
                        runtimeTransformsChanged = true;
                        giSurfaceChanged = true;
                        pathTraceSceneChanged = true;
                    }
                    deps.applyHairTransform(nodeHandle, matrix);
                },
                onMaterialScalar(nodeHandle, material) {
                    const mesh = deps.nodeMap.get(nodeHandle);
                    if (mesh) {
                        applyIncrementalNodeUpdate(mesh, { mat: material }, nodeHandle);
                        giSurfaceChanged = true;
                        pathTraceSceneChanged = true;
                    }
                },
                onSelection(nodeHandle, selected) {
                    const mesh = deps.nodeMap.get(nodeHandle);
                    if (mesh) applyIncrementalNodeUpdate(mesh, { s: selected }, nodeHandle);
                },
                onVisibility(nodeHandle, visible) {
                    const mesh = deps.nodeMap.get(nodeHandle);
                    if (mesh) {
                        applyIncrementalNodeUpdate(mesh, { vis: visible }, nodeHandle);
                        giSurfaceChanged = true;
                        pathTraceSceneChanged = true;
                    }
                    deps.applyHairVisibility(nodeHandle, visible);
                },
                onCamera(cameraState) {
                    deps.applyCamera(cameraState);
                },
                onLight(handle, ld) {
                    const light = deps.lightHandleMap.get(handle);
                    if (!light) return;
                    const m = ld.matrix;
                    // Reconstruct the JSON-style light data for deps.applyLightData
                    const pos = [m[12], m[13], m[14]];
                    const len = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]) || 1;
                    const dir = [-m[4]/len, -m[5]/len, -m[6]/len];
                    deps.applyLightData(light, {
                        h: handle, type: ld.type,
                        v: ld.visible ? 1 : 0,
                        pos, dir,
                        color: ld.color, intensity: ld.intensity,
                        distance: ld.distance, decay: ld.decay,
                        angle: ld.angle, penumbra: ld.penumbra,
                        width: ld.width, height: ld.height,
                        groundColor: ld.groundColor,
                        castShadow: ld.castShadow,
                        shadowBias: ld.shadowBias, shadowRadius: ld.shadowRadius,
                        shadowMapSize: ld.shadowMapSize,
                        volContrib: ld.volContrib,
                    });
                    if (ld.type === 0) deps.refreshSkyFromLinkedSun();
                    deps.markLightProbeLightsDirty();
                    deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
                    pathTraceSceneChanged = true;
                },
                onSplat(handle, matrix, visible) {
                    if (!deps.splatsSystem.applyTrackedSplatTransform(handle, matrix, visible)) return;
                    pathTraceSceneChanged = true;
                },
                onAudio(handle, matrix, visible) {
                    deps.audioSystem?.applyAudioTransformBinary(handle, matrix, visible);
                },
                onGLTF(handle, matrix, visible) {
                    deps.gltfSystem?.applyGLTFTransformBinary(handle, matrix, visible);
                    pathTraceSceneChanged = true;
                },
                onWebApp(handle, matrix, visible) {
                    deps.webappSystem?.applyWebAppTransformBinary(handle, matrix, visible);
                },
                onTime(td) {
                    maxTimeline.onTime(td);
                },
            });
            if (runtimeTransformsChanged) deps.layerManager.markRuntimeTransformsDirty?.();
            if (giSurfaceChanged) {
                deps.markLightProbeSceneDirty();
                deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
            }
            if (pathTraceSceneChanged) deps.schedulePathTracingLiveRebuild();
            deps.markInitialSync();
            deps.setTransportMode('binary-delta');
            deps.updateSyncHud({
                transport: 'binary-delta',
                frameId: meta.frame ?? result.frameId,
                producerBytes: meta.stats?.producerBytes ?? result.bytes,
                decodeMs: result.decodeMs,
                applyMs: result.applyMs,
            });
        }

        function normalizeVertexColorDescriptors(vertexColors) {
            if (!Array.isArray(vertexColors)) return [];
            return vertexColors.map((entry) => {
                const channel = deps.normalizeMaxVertexColorChannel(entry?.ch ?? entry?.channel ?? 0);
                const name = (typeof entry?.name === 'string' && entry.name.length)
                    ? entry.name
                    : deps.maxVertexColorAttributeName(channel);
                const itemSize = Number.isInteger(entry?.itemSize) && entry.itemSize > 0
                    ? entry.itemSize
                    : 4;
                let valueCount = 0;
                if (Number.isInteger(entry?.n) && entry.n >= 0) valueCount = entry.n;
                else if (Array.isArray(entry?.v) || ArrayBuffer.isView(entry?.v)) valueCount = entry.v.length;
                const count = itemSize > 0 ? Math.floor(valueCount / itemSize) : 0;
                return { ...entry, channel, name, itemSize, count, valueCount };
            }).filter((entry) => entry.count > 0);
        }

        function setGeometryVertexColorAttributes(geometry, vertexColors, buffer = null) {
            if (!geometry) return;
            geometry.userData ??= {};
            const descriptors = normalizeVertexColorDescriptors(vertexColors);
            const previous = Array.isArray(geometry.userData.maxjsVertexColors)
                ? geometry.userData.maxjsVertexColors
                : [];
            const keepNames = new Set(descriptors.map((entry) => entry.name));

            // Only reap missing channels when the incoming payload actually has
            // data. A transient empty VC update (partial tick, slow sync) would
            // otherwise delete every attribute and re-add it next tick —
            // deleteAttribute + setAttribute each invalidate the WebGPU vertex
            // buffer layout and force every material sampling the attribute to
            // rebuild its render pipeline. That pipeline churn is the root of
            // the Inspector's "(not in use)" cascade across SSGI / Bloom / AO.
            if (descriptors.length > 0) {
                for (const entry of previous) {
                    if (!keepNames.has(entry.name)) geometry.deleteAttribute(entry.name);
                }
            }

            for (const entry of descriptors) {
                const current = geometry.getAttribute(entry.name);
                const fastPath = current
                    && current.itemSize === entry.itemSize
                    && current.count === entry.count
                    && typedArrayCanStore(current.array, entry.n || 0);

                if (fastPath) {
                    // In-place update — zero allocation. Copy from the shared
                    // binary buffer view directly into the existing typed array
                    // rather than round-tripping through a standalone copy.
                    if (buffer) {
                        if (!binInRange(buffer, entry.off, entry.n || 0)) {
                            console.warn('[max.js binary] Invalid vertex color range for', entry.name);
                            continue;
                        }
                        current.array.set(new Float32Array(buffer, entry.off, entry.n));
                        current.needsUpdate = true;
                    } else if (Array.isArray(entry.v) || ArrayBuffer.isView(entry.v)) {
                        current.array.set(entry.v);
                        current.needsUpdate = true;
                    }
                    continue;
                }

                // Slow path: itemSize or count mismatch — must create a new
                // BufferAttribute. Pipeline invalidation is unavoidable here,
                // but it only fires on genuine topology changes (new channel,
                // remesh, first-time attach).
                let values = null;
                if (buffer) {
                    if (!binInRange(buffer, entry.off, entry.n || 0)) {
                        console.warn('[max.js binary] Invalid vertex color range for', entry.name);
                        continue;
                    }
                    // Standalone copy — the shared buffer may be released after
                    // this handler returns.
                    values = new Float32Array(new Float32Array(buffer, entry.off, entry.n));
                } else if (Array.isArray(entry.v) || ArrayBuffer.isView(entry.v)) {
                    values = new Float32Array(entry.v);
                } else {
                    continue;
                }

                geometry.setAttribute(entry.name, new THREE.BufferAttribute(values, entry.itemSize));
            }

            geometry.userData.maxjsVertexColors = descriptors.map(({ channel, name, itemSize, count }) => ({
                channel, name, itemSize, count,
            }));
            geometry.userData.maxjsVertexColorChannels = geometry.userData.maxjsVertexColors.map(({ channel, name }) => ({
                channel, name,
            }));
        }

        // ── Geometry Builder ────────────────────────────────
        function buildGeometry(vertices, indices, uvs, normals, options = {}) {
            const isLine = !!options.isLine;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            if (indices?.length) geom.setIndex(new THREE.BufferAttribute(indices, 1));
            if (uvs?.length) geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            if (options.uv2s?.length) {
                const uv2Attr = new THREE.Float32BufferAttribute(options.uv2s, 2);
                geom.setAttribute('uv1', uv2Attr);
                geom.setAttribute('uv2', uv2Attr);
            }
            if (normals?.length) geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
            else if (!isLine && !options.skipNormalCompute) geom.computeVertexNormals();
            setGeometryVertexColorAttributes(geom, options.vertexColors);
            if (!options.skipBoundsCompute) {
                geom.computeBoundingBox();
                geom.computeBoundingSphere();
            }
            return geom;
        }

        function isFiniteArray(values, expectedLength) {
            const isArrayLike = Array.isArray(values) || ArrayBuffer.isView(values);
            if (!isArrayLike || values.length !== expectedLength) return false;
            for (let i = 0; i < values.length; i++) {
                if (!Number.isFinite(values[i])) return false;
            }
            return true;
        }

        const maxNodeParentScratch = {
            raw: new THREE.Matrix4(),
            parentInRoot: new THREE.Matrix4(),
            parentInv: new THREE.Matrix4(),
            rootInv: new THREE.Matrix4(),
        };

        function removeMaxNodeObject(obj) {
            if (!obj) return;
            obj.parent?.remove(obj);
        }

        function getNodeParentObject(nd, obj = null) {
            const parentHandle = Number(nd?.p);
            const parent = Number.isFinite(parentHandle) && parentHandle > 0
                ? deps.nodeMap.get(parentHandle)
                : null;
            if (!parent || parent === obj) return deps.maxRoot;
            for (let cursor = parent; cursor; cursor = cursor.parent) {
                if (cursor === obj) return deps.maxRoot;
            }
            return parent;
        }

        function syncNodeParent(obj, nd) {
            if (!obj) return deps.maxRoot;
            const parent = getNodeParentObject(nd, obj);
            const parentHandle = parent === deps.maxRoot ? 0 : (Number(nd?.p) || 0);
            obj.userData ??= {};
            obj.userData.maxjsParentHandle = parentHandle;
            if (obj.parent !== parent) parent.add(obj);
            return parent;
        }

        function ensureTransformOnlyNode(nd, existing = null) {
            let obj = existing;
            if (obj && obj.userData?.maxjsHelper !== true) {
                removeMaxNodeObject(obj);
                obj.geometry?.dispose?.();
                deps.disposeSceneMaterial(obj.material);
                obj = null;
            }
            if (!obj) {
                obj = new THREE.Object3D();
                obj.matrixAutoUpdate = false;
                obj.frustumCulled = false;
            }
            obj.name = nd.n ?? obj.name ?? '';
            obj.userData ??= {};
            obj.userData.maxjsHandle = nd.h;
            obj.userData.maxjsHelper = true;
            syncNodeParent(obj, nd);
            finalizeSceneNode(obj, nd);
            deps.nodeMap.set(nd.h, obj);
            return obj;
        }

        function applyTransform(mesh, t) {
            if (!isFiniteArray(t, 16)) {
                const alreadyIdentity = matrixArraysAlmostEqual(mesh.matrix.elements, [
                    1, 0, 0, 0,
                    0, 1, 0, 0,
                    0, 0, 1, 0,
                    0, 0, 0, 1,
                ]);
                if (alreadyIdentity) return false;
                mesh.matrix.identity();
                mesh.position.set(0, 0, 0);
                mesh.quaternion.identity();
                mesh.scale.set(1, 1, 1);
                mesh.matrixWorldNeedsUpdate = true;
                return true;
            }
            maxNodeParentScratch.raw.fromArray(t);
            if (mesh.parent && mesh.parent !== deps.maxRoot) {
                deps.maxRoot.updateMatrixWorld(true);
                mesh.parent.updateMatrixWorld(true);
                maxNodeParentScratch.rootInv.copy(deps.maxRoot.matrixWorld).invert();
                maxNodeParentScratch.parentInRoot
                    .copy(maxNodeParentScratch.rootInv)
                    .multiply(mesh.parent.matrixWorld);
                maxNodeParentScratch.parentInv.copy(maxNodeParentScratch.parentInRoot).invert();
                maxNodeParentScratch.raw.premultiply(maxNodeParentScratch.parentInv);
            }
            if (matrixArraysAlmostEqual(mesh.matrix.elements, maxNodeParentScratch.raw.elements)) {
                return false;
            }
            mesh.matrix.copy(maxNodeParentScratch.raw);
            mesh.matrixWorldNeedsUpdate = true;
            return true;
        }

        function applySelection(mesh, selected) {
            mesh.userData.maxjsSelected = !!selected;
            // Toon outline is auto-detected from material type — no manual selection needed
        }

        function applyMaterialScalar(mesh, material, materialIndex = null) {
            const rebuildForBlackSpecularRoute = () => {
                if (!mesh || !material) return false;
                if (materialIndex != null) {
                    if (!Array.isArray(mesh.material)) return false;
                    const oldMaterial = mesh.material[materialIndex] ?? null;
                    if (!oldMaterial) return false;
                    const wantsRoute = deps.shouldRouteBlackSpecularToLambert(material.model || 'MeshStandardMaterial', material);
                    const isRouted = !!oldMaterial.userData?.maxjsLambertFromBlackSpecular;
                    if (wantsRoute === isRouted) return false;
                    const nextMaterials = mesh.material.slice();
                    nextMaterials[materialIndex] = deps.createMaterial(material, {
                        geometry: mesh.geometry,
                        materialIndex,
                        matrixArray: mesh.matrix?.elements,
                    });
                    mesh.material = nextMaterials;
                    if (!deps.isCachedMaterialTemplate(oldMaterial)) deps.disposeSceneMaterial(oldMaterial);
                    return true;
                }
                if (Array.isArray(mesh.material)) return false;
                const oldMaterial = mesh.material;
                const wantsRoute = deps.shouldRouteBlackSpecularToLambert(material.model || 'MeshStandardMaterial', material);
                const isRouted = !!oldMaterial?.userData?.maxjsLambertFromBlackSpecular;
                if (wantsRoute === isRouted) return false;
                mesh.material = deps.createMaterial(material, {
                    geometry: mesh.geometry,
                    materialIndex: null,
                    matrixArray: mesh.matrix?.elements,
                });
                if (!deps.isCachedMaterialTemplate(oldMaterial)) deps.disposeSceneMaterial(oldMaterial);
                return true;
            };
            if (rebuildForBlackSpecularRoute()) {
                if (mesh.userData) mesh.userData.maxjsMaterialSignature = null;
                return;
            }

            const c = material?.color;
            const emissive = material?.emissive;
            const specularColor = material?.specularColor;
            const sheenColor = material?.sheenColor;
            const attenuationColor = material?.attenuationColor;
            let mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            if (materialIndex != null) {
                const selected = Array.isArray(mesh.material)
                    ? mesh.material[materialIndex] ?? null
                    : (materialIndex === 0 ? mesh.material : null);
                mats = selected ? [selected] : [];
            }
            for (const m of mats) {
                if (!m) continue;
                if (m.userData?.maxjsHTMLTextureOverride) continue;
                let materialNeedsUpdate = false;
                let nextTransparent = m.transparent;
                if (c && m.color) m.color.setRGB(c[0], c[1], c[2]);
                if (emissive && m.emissive) m.emissive.setRGB(emissive[0], emissive[1], emissive[2]);
                if (specularColor && 'specularColor' in m && m.specularColor) {
                    m.specularColor.setRGB(specularColor[0], specularColor[1], specularColor[2]);
                }
                if (sheenColor && 'sheenColor' in m && m.sheenColor) {
                    m.sheenColor.setRGB(sheenColor[0], sheenColor[1], sheenColor[2]);
                }
                if (attenuationColor && 'attenuationColor' in m && m.attenuationColor) {
                    m.attenuationColor.setRGB(attenuationColor[0], attenuationColor[1], attenuationColor[2]);
                }
                const roughness = material?.roughness ?? material?.rough;
                const metalness = material?.metalness ?? material?.metal;
                if (roughness != null && 'roughness' in m) {
                    m.roughness = roughness;
                    deps.applySSSRoughnessInfluence(m, roughness);
                }
                if (metalness != null && 'metalness' in m) m.metalness = metalness;
                if (material?.opacity != null) {
                    m.opacity = material.opacity;
                    nextTransparent = !!material.transparent || material.opacity < 0.999;
                }
                if (material?.transparent === true) nextTransparent = true;
                if (material?.depthWrite != null && 'depthWrite' in m) m.depthWrite = !!material.depthWrite;
                if (material?.depthTest != null && 'depthTest' in m) m.depthTest = !!material.depthTest;
                if (Number.isFinite(material?.alphaTest) && 'alphaTest' in m) m.alphaTest = material.alphaTest;
                if (material?.emissiveIntensity != null || material?.emI != null) {
                    if ('emissiveIntensity' in m) m.emissiveIntensity = material?.emissiveIntensity ?? material?.emI;
                }
                if (material?.envMapIntensity != null || material?.envI != null) {
                    if ('envMapIntensity' in m) m.envMapIntensity = material?.envMapIntensity ?? material?.envI;
                }
                if (material?.aoMapIntensity != null || material?.aoI != null) {
                    if ('aoMapIntensity' in m) m.aoMapIntensity = material?.aoMapIntensity ?? material?.aoI;
                }
                if (material?.clearcoat != null && 'clearcoat' in m) m.clearcoat = material.clearcoat;
                if (material?.clearcoatRoughness != null && 'clearcoatRoughness' in m) {
                    m.clearcoatRoughness = material.clearcoatRoughness;
                }
                if (material?.sheen != null && 'sheen' in m) m.sheen = material.sheen;
                if (material?.sheenRoughness != null && 'sheenRoughness' in m) {
                    m.sheenRoughness = material.sheenRoughness;
                }
                if (material?.iridescence != null && 'iridescence' in m) {
                    m.iridescence = material.iridescence;
                }
                if (material?.iridescenceIOR != null && 'iridescenceIOR' in m) {
                    m.iridescenceIOR = material.iridescenceIOR;
                }
                if (material?.transmission != null && 'transmission' in m) {
                    const hadTransmission = (m.transmission ?? 0) > 0;
                    m.transmission = material.transmission;
                    const hasTransmission = material.transmission > 0;
                    if (hadTransmission !== hasTransmission) materialNeedsUpdate = true;
                    if (hasTransmission) nextTransparent = true;
                }
                if (material?.thickness != null && 'thickness' in m) m.thickness = material.thickness;
                if (material?.specularIntensity != null && 'specularIntensity' in m) {
                    m.specularIntensity = material.specularIntensity;
                    if (material.specularIntensity < 0.001) {
                        m.envMapIntensity = 0;
                    }
                }
                // IOR must be set AFTER specularIntensity — Three.js derives F0 from both
                if (material?.ior != null && 'ior' in m) {
                    m.ior = (material.specularIntensity != null && material.specularIntensity < 0.001) ? 1.0 : material.ior;
                }
                if (material?.reflectivity != null && 'reflectivity' in m) {
                    m.reflectivity = material.reflectivity;
                }
                if (material?.dispersion != null && 'dispersion' in m) {
                    m.dispersion = material.dispersion;
                }
                if (material?.attenuationDistance != null && 'attenuationDistance' in m) {
                    m.attenuationDistance = material.attenuationDistance;
                }
                if (material?.anisotropy != null && 'anisotropy' in m) {
                    m.anisotropy = material.anisotropy;
                }
                deps.rememberMaterialEmissiveBase(m);
                deps.applyMaterialSelectionState(m, !!mesh.userData.maxjsSelected);
                if (m.transparent !== nextTransparent) {
                    m.transparent = nextTransparent;
                    materialNeedsUpdate = true;
                }
                if (materialNeedsUpdate) m.needsUpdate = true;
            }
            // The in-place mutation desyncs the live material from the signature
            // stamped at build time. Drop the stamp so the next full sync always
            // rebuilds — a stale signature could match a reverted/reassigned
            // material payload and leave the mutated look stuck until reload.
            if (mesh.userData) mesh.userData.maxjsMaterialSignature = null;
        }


        return {
            finalizeSceneNode,
            applyIncrementalNodeUpdate,
            buildNodeGeometryRefCounts,
            retainGeometryRef,
            releaseGeometryRef,
            disposeMaxInstanceBuckets,
            getMaxInstanceBucketForHandle,
            matrixArraysAlmostEqual,
            updateMaxInstanceBucketVisibility,
            updateMaxInstanceBucketTransform,
            updateMaxInstanceBucketNode,
            createMaxInstanceBucketMaterial,
            computeMaxInstanceBucketGroups,
            planMaxInstanceBuckets,
            buildMaxInstanceBuckets,
            profileSceneNodes,
            findSnapshotSkySunDirection,
            withSnapshotLinkedSkySun,
            finalizeSceneSnapshot,
            handleBinaryScene,
            handleBinaryDelta,
            normalizeVertexColorDescriptors,
            setGeometryVertexColorAttributes,
            buildGeometry,
            isFiniteArray,
            removeMaxNodeObject,
            getNodeParentObject,
            syncNodeParent,
            ensureTransformOnlyNode,
            applyTransform,
            applySelection,
            applyMaterialScalar,
        };
}

export { createSceneSync };
