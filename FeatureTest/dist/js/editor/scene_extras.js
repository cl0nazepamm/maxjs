// scene_extras.js - editor hair and forest instance sync extras.
import * as THREE from 'three';
import {
    binInRange,
    indexArrayFromBinary,
    normalAttributeFromBinary,
    uvAttributeFromBinary,
} from '../scene_binary.js';
import {
    getInstancedMeshBatchSize,
    instanceGroupHasExactMaterialDescriptor,
    instanceGroupKey,
    isExactInstanceMaterialDescriptor,
    isWebGpuInstancingPath,
} from '../instance_batching.js';
import { markOwned, OWNER_MAX } from '../layer_ownership.js';

function createSceneExtras(deps = {}) {
        // ── Hair Fast Sync — re-extracted world-space instances ──
        deps.bridge.on('hair_fast', msg => {
            if (!Array.isArray(msg.groups)) return;
            let pathTraceSceneChanged = false;
            const m = new THREE.Matrix4();
            const c = new THREE.Color();
            for (const grp of msg.groups) {
                const count = grp.count || Math.floor((grp.xforms?.length || 0) / 16);
                if (!count || !Array.isArray(grp.xforms) || grp.xforms.length < count * 16) continue;
                const entry = deps.hairMeshes.get(grp.h);
                if (!entry?.mesh || entry.mesh.count !== count) {
                    // No entry yet, or strand count changed — rebuild just this
                    // handle. Never touch other hair groups (msg.groups is only
                    // the dirty subset from SendHairFastUpdate).
                    disposeHairEntry(grp.h);
                    buildHairEntry(grp);
                    pathTraceSceneChanged = true;
                    continue;
                }
                const instMesh = entry.mesh;
                for (let i = 0; i < count; i++) {
                    m.fromArray(grp.xforms, i * 16);
                    instMesh.setMatrixAt(i, m);
                    if (grp.colors) {
                        c.setRGB(
                            grp.colors[i * 3] ?? 1,
                            grp.colors[i * 3 + 1] ?? 1,
                            grp.colors[i * 3 + 2] ?? 1
                        );
                        instMesh.setColorAt(i, c);
                    }
                }
                instMesh.instanceMatrix.needsUpdate = true;
                if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
                if (grp.vis != null) entry.root.visible = !!grp.vis;
                pathTraceSceneChanged = true;
            }
            if (pathTraceSceneChanged) deps.schedulePathTracingLiveRebuild();
        });

        function createHairBladeGeometry() {
            const rows = 5;
            const positions = [];
            const normals = [];
            const uvs = [];
            const indices = [];

            function appendPlane(angle) {
                const c = Math.cos(angle);
                const s = Math.sin(angle);
                const baseVertex = positions.length / 3;
                const nx = s;
                const ny = 0;
                const nz = c;

                for (let row = 0; row <= rows; row++) {
                    const v = row / rows;
                    const taper = Math.max(0.02, Math.pow(1.0 - v, 0.7));
                    const halfWidth = 0.5 * taper;

                    const lx0 = -halfWidth;
                    const lx1 = halfWidth;
                    const x0 = lx0 * c;
                    const z0 = -lx0 * s;
                    const x1 = lx1 * c;
                    const z1 = -lx1 * s;

                    positions.push(x0, v, z0, x1, v, z1);
                    normals.push(nx, ny, nz, nx, ny, nz);
                    uvs.push(0, v, 1, v);

                    if (row < rows) {
                        const base = baseVertex + row * 2;
                        indices.push(base, base + 1, base + 2);
                        indices.push(base + 1, base + 3, base + 2);
                    }
                }
            }

            appendPlane(0);
            appendPlane(Math.PI * 0.5);

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
            geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geom.setIndex(indices);
            geom.computeBoundingBox();
            geom.computeBoundingSphere();
            return geom;
        }

        const hairBladeGeometry = createHairBladeGeometry();

        function disposeHairEntry(handle) {
            const entry = deps.hairMeshes.get(handle);
            if (!entry) return;
            if (entry.root?.parent) entry.root.parent.remove(entry.root);
            deps.disposeSceneMaterial(entry.mesh?.material);
            deps.hairMeshes.delete(handle);
        }

        function disposeHairInstances() {
            for (const handle of Array.from(deps.hairMeshes.keys())) disposeHairEntry(handle);
        }

        function applyHairTransform(handle, matrixArray) {
            // Hair instance matrices are world-space — transform updates are
            // handled via hair_fast re-extraction, not root group transforms.
            return false;
        }

        function applyHairVisibility(handle, visible) {
            const entry = deps.hairMeshes.get(handle);
            if (!entry?.root) return false;
            const next = !!visible;
            if (entry.root.visible === next) return false;
            entry.root.visible = next;
            return true;
        }

        function buildHairEntry(grp) {
            const count = grp.count || Math.floor((grp.xforms?.length || 0) / 16);
            if (!count || !Array.isArray(grp.xforms) || grp.xforms.length < count * 16) return null;

            let mat = grp.mat ? deps.createMaterial(grp.mat, {
                geometry: hairBladeGeometry,
                materialIndex: null,
            }) : new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                roughness: 0.8,
                metalness: 0.0,
                side: THREE.DoubleSide,
            });
            if (Array.isArray(mat)) {
                mat = mat[0] ?? new THREE.MeshPhysicalMaterial({ color: 0xffffff, side: THREE.DoubleSide });
            }
            mat.side = THREE.DoubleSide;
            mat.vertexColors = true;
            if ((grp.mat?.opacity ?? 1) < 0.999) mat.transparent = true;
            mat.needsUpdate = true;

            const instMesh = new THREE.InstancedMesh(hairBladeGeometry, mat, count);
            instMesh.matrixAutoUpdate = false;
            instMesh.frustumCulled = false;
            instMesh.castShadow = true;
            instMesh.receiveShadow = true;
            instMesh.name = `hair_${grp.h}_x${count}`;

            const m = new THREE.Matrix4();
            const c = new THREE.Color();
            for (let i = 0; i < count; i++) {
                m.fromArray(grp.xforms, i * 16);
                instMesh.setMatrixAt(i, m);

                const colorOff = i * 3;
                const r = grp.colors?.[colorOff + 0] ?? 1.0;
                const g = grp.colors?.[colorOff + 1] ?? 1.0;
                const b = grp.colors?.[colorOff + 2] ?? 1.0;
                c.setRGB(r, g, b);
                instMesh.setColorAt(i, c);
            }
            instMesh.instanceMatrix.needsUpdate = true;
            if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;

            const root = new THREE.Group();
            root.matrixAutoUpdate = false;
            root.name = `hair_root_${grp.h}`;
            root.userData.maxjsHair = true;
            root.visible = grp.vis == null ? true : !!grp.vis;
            root.add(instMesh);
            markOwned(root, OWNER_MAX);
            deps.maxRoot.add(root);

            const entry = { root, mesh: instMesh };
            deps.hairMeshes.set(grp.h, entry);
            return entry;
        }

        function applyHairInstances(groups) {
            const hadHair = deps.hairMeshes.size > 0;
            disposeHairInstances();
            if (!Array.isArray(groups) || groups.length === 0) {
                if (hadHair) deps.scheduleLightProbeFromCurrentScene();
                return;
            }
            for (const grp of groups) buildHairEntry(grp);
            deps.scheduleLightProbeFromCurrentScene();
        }


        let forestBuildSerial = 0;
        const FOREST_INSTANCE_UPLOAD_CHUNK = 4096;

        function getForestBinaryFloatView(buffer, off, n, label) {
            if (!(buffer instanceof ArrayBuffer) || !binInRange(buffer, off, n)) {
                console.warn(`[max.js binary] Invalid ${label} range`);
                return null;
            }
            return new Float32Array(buffer, off, n);
        }

        function getForestGeometryPayload(grp, binaryBuffer) {
            const geo = grp?.geo;
            if (geo && binaryBuffer instanceof ArrayBuffer) {
                const v = getForestBinaryFloatView(binaryBuffer, geo.vOff, geo.vN, 'forest position');
                const i = indexArrayFromBinary(binaryBuffer, geo.iOff, geo.iN, geo.iType, {
                    copy: true,
                    label: 'forest index',
                });
                if (!v || !i) return null;
                const uvAttr = geo.uvOff != null && geo.uvN
                    ? uvAttributeFromBinary(binaryBuffer, geo.uvOff, geo.uvN, geo.uvType, 'forest uv')
                    : null;
                const normalAttr = geo.nOff != null && geo.nN
                    ? normalAttributeFromBinary(binaryBuffer, geo.nOff, geo.nN, geo.nType, 'forest normal')
                    : null;
                return {
                    v: new Float32Array(v),
                    i,
                    uv: null,
                    uvAttr,
                    norm: null,
                    normalAttr,
                };
            }
            if (!grp?.v?.length || !grp?.i?.length) return null;
            // Inline JSON groups (live WebView metadata) carry plain arrays;
            // BufferAttribute needs typed ones — same conversion the
            // host-neutral applier does in vectorPayloadToFloat32/Uint32.
            return {
                v: ArrayBuffer.isView(grp.v) ? grp.v : new Float32Array(grp.v),
                i: ArrayBuffer.isView(grp.i) ? grp.i : new Uint32Array(grp.i),
                uv: !grp.uv?.length || ArrayBuffer.isView(grp.uv) ? grp.uv : new Float32Array(grp.uv),
                uvAttr: null,
                norm: !grp.norm?.length || ArrayBuffer.isView(grp.norm) ? grp.norm : new Float32Array(grp.norm),
                normalAttr: null,
            };
        }

        function getForestTransformPayload(grp, binaryBuffer) {
            if (Number.isInteger(grp?.xformOff) && Number.isInteger(grp?.xformN) && binaryBuffer instanceof ArrayBuffer) {
                const values = getForestBinaryFloatView(binaryBuffer, grp.xformOff, grp.xformN, 'forest transform');
                if (!values) return null;
                const type = String(grp.xformType ?? 'f32m16').trim().toLowerCase();
                return { values, type, stride: type === 'affine12' ? 12 : 16 };
            }
            if (Array.isArray(grp?.xforms) || ArrayBuffer.isView(grp?.xforms)) {
                return { values: grp.xforms, type: 'f32m16', stride: 16 };
            }
            return null;
        }

        function setForestInstanceMatrix(matrix, payload, index) {
            const values = payload.values;
            const off = index * payload.stride;
            if (payload.type === 'affine12') {
                matrix.set(
                    values[off+0], values[off+3], values[off+6],  values[off+9],
                    values[off+1], values[off+4], values[off+7],  values[off+10],
                    values[off+2], values[off+5], values[off+8],  values[off+11],
                    0,             0,             0,              1
                );
                return;
            }
            matrix.set(
                values[off+0], values[off+4], values[off+8],  values[off+12],
                values[off+1], values[off+5], values[off+9],  values[off+13],
                values[off+2], values[off+6], values[off+10], values[off+14],
                values[off+3], values[off+7], values[off+11], values[off+15]
            );
        }

        function writeForestInstanceMatrixAt(target, targetOff, payload, index) {
            const values = payload.values;
            const off = index * payload.stride;
            if (payload.type === 'affine12') {
                target[targetOff + 0] = values[off + 0];
                target[targetOff + 1] = values[off + 1];
                target[targetOff + 2] = values[off + 2];
                target[targetOff + 3] = 0;
                target[targetOff + 4] = values[off + 3];
                target[targetOff + 5] = values[off + 4];
                target[targetOff + 6] = values[off + 5];
                target[targetOff + 7] = 0;
                target[targetOff + 8] = values[off + 6];
                target[targetOff + 9] = values[off + 7];
                target[targetOff + 10] = values[off + 8];
                target[targetOff + 11] = 0;
                target[targetOff + 12] = values[off + 9];
                target[targetOff + 13] = values[off + 10];
                target[targetOff + 14] = values[off + 11];
                target[targetOff + 15] = 1;
                return;
            }
            if (typeof values.subarray === 'function') {
                target.set(values.subarray(off, off + 16), targetOff);
                return;
            }
            for (let i = 0; i < 16; i++) {
                target[targetOff + i] = values[off + i];
            }
        }

        function nextForestBuildFrame() {
            return new Promise(resolve => requestAnimationFrame(resolve));
        }

        function disposeForestBuildMaterial(material, disposedMaterials) {
            const materials = Array.isArray(material) ? material : [material];
            for (const item of materials) {
                if (!item || disposedMaterials.has(item)) continue;
                disposedMaterials.add(item);
                deps.disposeSceneMaterial(item);
            }
        }

        function disposeForestBuildResources(geometry, material) {
            geometry?.dispose?.();
            disposeForestBuildMaterial(material, new Set());
        }

        function usingWebGpuInstanceMaterials() {
            return isWebGpuInstancingPath({ renderer: deps.renderer, backendLabel: deps.rendererBackendLabel });
        }

        function copyInstanceTextureSlot(source, target, fromKey, toKey = fromKey) {
            const url = source?.[fromKey];
            if (typeof url === 'string' && url.length > 0) target[toKey] = url;
            const xf = source?.[`${fromKey}Xf`];
            if (xf != null) target[`${toKey}Xf`] = xf;
        }

        function webGpuSafeInstanceMaterialDescriptor(md) {
            if (!usingWebGpuInstanceMaterials() || !md || typeof md !== 'object') return md;
            if (isExactInstanceMaterialDescriptor(md)) return md;

            const safe = {
                model: 'MeshStandardMaterial',
                name: md.name,
                color: Array.isArray(md.color) ? md.color.slice(0, 3) : [0.8, 0.8, 0.8],
                side: md.side,
                rough: Number.isFinite(md.rough) ? md.rough : 0.65,
                metal: Number.isFinite(md.metal) ? md.metal : 0.0,
                envI: Number.isFinite(md.envI) ? md.envI : 1.0,
            };

            if (md.opacity != null) safe.opacity = md.opacity;
            if (md.transparent === true) safe.transparent = true;
            if (md.depthWrite != null) safe.depthWrite = md.depthWrite;
            if (md.depthTest != null) safe.depthTest = md.depthTest;
            if (Number.isFinite(md.alphaTest) && md.alphaTest > 0) safe.alphaTest = md.alphaTest;
            if (Array.isArray(md.em) && md.emI > 0) {
                safe.em = md.em.slice(0, 3);
                safe.emI = md.emI;
            }

            copyInstanceTextureSlot(md, safe, 'map');
            if (!safe.map) copyInstanceTextureSlot(md, safe, 'diffMap', 'map');
            copyInstanceTextureSlot(md, safe, 'opMap');
            if (!safe.opMap) copyInstanceTextureSlot(md, safe, 'alphaMap', 'opMap');
            if (!safe.opMap) copyInstanceTextureSlot(md, safe, 'opacityMap', 'opMap');

            if (safe.opMap && !(Number.isFinite(safe.alphaTest) && safe.alphaTest > 0)) {
                safe.alphaTest = 0.35;
                safe.transparent = false;
            }

            return safe;
        }

        function dominantForestMaterialIndex(grp) {
            if (!Array.isArray(grp?.groups) || grp.groups.length === 0) return 0;
            let bestIndex = 0;
            let bestCount = -1;
            for (const group of grp.groups) {
                const materialIndex = Number(group?.[2]);
                const indexCount = Number(group?.[1]);
                if (Number.isFinite(materialIndex) && Number.isFinite(indexCount) && indexCount > bestCount) {
                    bestIndex = materialIndex;
                    bestCount = indexCount;
                }
            }
            return bestIndex;
        }

        function shouldCollapseForestMaterialsForWebGpu(grp) {
            if (!usingWebGpuInstanceMaterials()) return false;
            if (String(grp?.kind || '').toLowerCase() === 'railclone') return false;
            if (!Array.isArray(grp?.mats) || !Array.isArray(grp?.groups)) return false;
            if (instanceGroupHasExactMaterialDescriptor(grp)) return false;
            const textureSlots = grp.mats.reduce((sum, material) => sum + deps.countMaterialTextureSlots(material), 0);
            return grp.groups.length > 8 || textureSlots > 4;
        }

        function createForestInstanceMaterial(md, materialContext = null) {
            return deps.createMaterial(webGpuSafeInstanceMaterialDescriptor(md), materialContext);
        }

        function applyForestInstances(groups, binaryBuffer = null) {
            const buildSerial = ++forestBuildSerial;
            const buildStart = performance.now();
            let addedMeshes = 0;
            // Remove old forest meshes
            const removedMeshes = deps.forestMeshes.size;
            const disposedGeometries = new Set();
            const disposedMaterials = new Set();
            for (const [key, mesh] of deps.forestMeshes) {
                deps.maxRoot.remove(mesh);
                if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
                    disposedGeometries.add(mesh.geometry);
                    mesh.geometry.dispose();
                }
                disposeForestBuildMaterial(mesh.material, disposedMaterials);
                mesh.dispose?.();
            }
            deps.forestMeshes.clear();

            const markForestInstancesReady = () => {
                if (buildSerial !== forestBuildSerial) return;
                deps.scene.updateMatrixWorld(true);
                deps.layerManager.markRuntimeTransformsDirty?.();
                deps.maxjsFx.markSceneChanged?.();
                deps.scheduleLightProbeFromCurrentScene({ delay: 350 });
                deps.schedulePathTracingLiveRebuild();
                deps.updateSyncHud({
                    countAsAppliedSync: false,
                    transport: deps.transportMode,
                    frameId: 0,
                    producerBytes: 0,
                    decodeMs: 0,
                    applyMs: performance.now() - buildStart,
                });
            };

            if (!Array.isArray(groups) || groups.length === 0) {
                if (removedMeshes > 0) markForestInstancesReady();
                return;
            }
            deps.maxjsDebugLog('[ForestPack]', groups.length, 'groups, total instances:', groups.reduce((s, g) => s + (g.count || 0), 0));

            // Groups from different owners can instance the same source mesh
            // (two Point Instance stacks scattering one sphere). Share one
            // BufferGeometry per (kind, src) within this apply pass — only for
            // single-material groups, since multi-sub groups mutate geometry
            // groups in place.
            const sharedGeoms = new Map();

            const buildForestInstances = async () => {
                for (const grp of groups) {
                    if (buildSerial !== forestBuildSerial) return;
                    try {
                const geoPayload = getForestGeometryPayload(grp, binaryBuffer);
                const xformPayload = getForestTransformPayload(grp, binaryBuffer);
                const count = grp.count || Math.floor((xformPayload?.values?.length || 0) / (xformPayload?.stride || 16));
                if (!geoPayload || !xformPayload?.values || !count ||
                    xformPayload.values.length < count * xformPayload.stride) {
                    continue;
                }

                const multiSub = !!(grp.mats && grp.groups);
                const geomShareKey = multiSub || grp.src == null ? null : `${grp.kind ?? ''}:${grp.src}`;
                let geom = geomShareKey ? sharedGeoms.get(geomShareKey) : null;
                if (!geom) {
                    geom = deps.buildGeometry(geoPayload.v, geoPayload.i, geoPayload.uv, geoPayload.norm, {
                        skipNormalCompute: !!geoPayload.normalAttr,
                    });
                    if (geoPayload.uvAttr) geom.setAttribute('uv', geoPayload.uvAttr);
                    if (geoPayload.normalAttr) geom.setAttribute('normal', geoPayload.normalAttr);
                    if (geomShareKey) sharedGeoms.set(geomShareKey, geom);
                }

                // Material: use data from C++ (single or multi-sub), fallback to gray
                let mat;
                if (shouldCollapseForestMaterialsForWebGpu(grp)) {
                    const materialIndex = dominantForestMaterialIndex(grp);
                    const sourceMaterial = grp.mats?.[materialIndex] ?? grp.mats?.[0] ?? grp.mat;
                    mat = sourceMaterial
                        ? createForestInstanceMaterial(sourceMaterial, { geometry: geom, materialIndex: null })
                        : new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7, side: THREE.DoubleSide });
                } else if (multiSub) {
                    // Multi/Sub material — create material array + geometry groups
                    for (const [start, count, idx] of grp.groups) {
                        geom.addGroup(start, count, idx);
                    }
                    mat = grp.mats.map((m, materialIndex) => createForestInstanceMaterial(m, { geometry: geom, materialIndex }));
                } else if (grp.mat) {
                    mat = createForestInstanceMaterial(grp.mat, { geometry: geom, materialIndex: null });
                } else {
                    mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7, side: THREE.DoubleSide });
                }

                const groupKey = instanceGroupKey(grp);
                const batchSize = Math.max(1, getInstancedMeshBatchSize({
                    renderer: deps.renderer,
                    backendLabel: deps.rendererBackendLabel,
                    count,
                }));
                const batchCount = Math.ceil(count / batchSize);
                for (let batchIndex = 0, start = 0; start < count; batchIndex++, start += batchSize) {
                    if (buildSerial !== forestBuildSerial) {
                        disposeForestBuildResources(geom, mat);
                        return;
                    }
                    const sliceCount = Math.min(batchSize, count - start);
                    const instMesh = new THREE.InstancedMesh(geom, mat, sliceCount);
                    instMesh.matrixAutoUpdate = false;
                    instMesh.frustumCulled = false;
                    instMesh.castShadow = true;
                    instMesh.receiveShadow = true;
                    instMesh.name = batchCount > 1
                        ? `forest_${groupKey}_part${batchIndex + 1}_x${sliceCount}`
                        : `forest_${groupKey}_x${sliceCount}`;
                    instMesh.userData.maxjsInstanceGroup = true;
                    instMesh.userData.maxjsSource = groupKey;
                    instMesh.userData.maxjsInstanceStart = start;
                    instMesh.userData.maxjsInstanceTotal = count;
                    const matrixArray = instMesh.instanceMatrix.array;

                    for (let i = 0; i < sliceCount; i++) {
                        if ((i > 0) && (i % FOREST_INSTANCE_UPLOAD_CHUNK) === 0) {
                            await nextForestBuildFrame();
                            if (buildSerial !== forestBuildSerial) {
                                disposeForestBuildResources(instMesh.geometry, instMesh.material);
                                return;
                            }
                        }
                        writeForestInstanceMatrixAt(matrixArray, i * 16, xformPayload, start + i);
                    }
                    instMesh.instanceMatrix.needsUpdate = true;

                    if (buildSerial !== forestBuildSerial) {
                        disposeForestBuildResources(instMesh.geometry, instMesh.material);
                        return;
                    }
                    markOwned(instMesh, OWNER_MAX);
                    deps.maxRoot.add(instMesh);
                    deps.forestMeshes.set(batchCount > 1 ? `${groupKey}:${batchIndex}` : groupKey, instMesh);
                    addedMeshes++;
                }
                    } catch (err) {
                        // One malformed group must not blank every other
                        // instance group in the scene.
                        console.error('[ForestPack] instance group build failed', grp?.key ?? grp?.src, err);
                    }
            }
            if (addedMeshes > 0 || removedMeshes > 0) markForestInstancesReady();
            };
            buildForestInstances().catch(err => console.error('[ForestPack] async build failed', err));
        }

        return {
            createHairBladeGeometry,
            disposeHairEntry,
            disposeHairInstances,
            applyHairTransform,
            applyHairVisibility,
            buildHairEntry,
            applyHairInstances,
            getForestBinaryFloatView,
            getForestGeometryPayload,
            getForestTransformPayload,
            setForestInstanceMatrix,
            writeForestInstanceMatrixAt,
            nextForestBuildFrame,
            disposeForestBuildMaterial,
            disposeForestBuildResources,
            usingWebGpuInstanceMaterials,
            copyInstanceTextureSlot,
            webGpuSafeInstanceMaterialDescriptor,
            dominantForestMaterialIndex,
            shouldCollapseForestMaterialsForWebGpu,
            createForestInstanceMaterial,
            applyForestInstances,
        };
}

export { createSceneExtras };
