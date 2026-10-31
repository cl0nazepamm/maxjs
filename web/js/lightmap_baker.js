// lightmap_baker.js - GI lightmaps baked from the irradiance probe grids (light_probes.js).
//
// three.js LightMapper accumulates the probes' per-texel irradiance into a texture laid
// out by `uv1`, which carries Max map channel 2. Each mesh gets its own map, sized by
// its world surface area, so Max-authored lightmap UVs are used as they are. One
// mapper per resolution is reused across meshes, which keeps the bake shaders to a
// handful of compiles. Node renderers only (WebGPU and its WebGL2 backend).

import { HalfFloatType, LinearFilter, RenderTarget, Vector3 } from 'three/webgpu';
import { select, uniform, vec3 } from 'three/tsl';
import { LightMapper } from 'three/addons/lighting/LightMapper.js';
import { lightProbeGridIrradiance } from 'three/addons/tsl/lighting/LightProbeGridNode.js';

const MIN_SIZE = 16;
const SAMPLES_PER_UPDATE = 16;

// A mesh can take a GI lightmap when it is a plain static mesh with a lit
// material and a Max channel 2 UV set.
export function isLightmapCandidate(mesh) {
    if (!mesh?.isMesh || mesh.isInstancedMesh || mesh.isBatchedMesh || mesh.isSkinnedMesh) return false;
    if (!mesh.visible || !mesh.geometry?.getAttribute('uv1')) return false;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return materials.some((m) => m && !m.isMeshBasicMaterial && !m.isMeshBasicNodeMaterial && !m.isLineBasicMaterial);
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
function worldSurfaceArea(mesh) {
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    const matrix = mesh.matrixWorld;
    let area = 0;
    for (let i = 0; i + 2 < count; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        _a.fromBufferAttribute(position, ia).applyMatrix4(matrix);
        _b.fromBufferAttribute(position, ib).applyMatrix4(matrix).sub(_a);
        _c.fromBufferAttribute(position, ic).applyMatrix4(matrix).sub(_a);
        area += _b.cross(_c).length() * 0.5;
    }
    return area;
}

// Irradiance from every grid at unit intensity (materials scale it with
// lightMapIntensity); where grids overlap the highest priority wins, on ties the
// newest, matching LightProbeGridNode.
function probeGridIrradiance(grids) {
    const ordered = [...grids].sort((a, b) => a.priority - b.priority || a.id - b.id);
    return (position, normal) => {
        let irradiance = vec3(0);
        for (const grid of ordered) {
            const box = grid.boundingBox;
            const inside = position.greaterThanEqual(uniform(box.min)).all()
                .and(position.lessThanEqual(uniform(box.max)).all());
            const intensity = grid.intensity;
            grid.intensity = 1;
            const gridIrradiance = lightProbeGridIrradiance(grid, position, normal);
            grid.intensity = intensity;
            irradiance = select(inside, gridIrradiance, irradiance);
        }
        return irradiance;
    };
}

// LightMapper for one object at a time, reused across meshes of the same size.
class SingleObjectLightMapper extends LightMapper {
    setObject(object) {
        this._scene.clear();
        this._objects.length = 0;
        this.addObjects([object]);
        this.reset();
    }
}

export function createLightmapBaker({ renderer }) {
    const maps = new Map(); // mesh -> RenderTarget holding its baked lightmap
    let mappers = new Map(); // size -> SingleObjectLightMapper
    let job = null;

    function disposeMappers() {
        for (const mapper of mappers.values()) mapper.dispose();
        mappers = new Map();
    }

    function sizeFor(mesh, texelsPerUnit, maxResolution) {
        const ideal = Math.sqrt(worldSurfaceArea(mesh)) * texelsPerUnit;
        const size = 2 ** Math.round(Math.log2(Math.max(ideal, MIN_SIZE)));
        return Math.min(maxResolution, Math.max(MIN_SIZE, size));
    }

    function targetFor(mesh, size) {
        let target = maps.get(mesh);
        if (target && target.width === size) return target;
        target?.dispose();
        target = new RenderTarget(size, size, {
            type: HalfFloatType,
            minFilter: LinearFilter,
            magFilter: LinearFilter,
            generateMipmaps: false,
            depthBuffer: false,
        });
        target.texture.channel = 1;
        target.texture.name = `maxjs GI lightmap: ${mesh.name || mesh.uuid}`;
        renderer.initRenderTarget(target);
        maps.set(mesh, target);
        return target;
    }

    return {
        get maps() { return maps; },
        get baking() { return job !== null; },

        // Starts a bake of `meshes` from `grids`; `update()` advances it.
        // `resolution` is the light probe settings' normalized lightmapResolution.
        start(grids, meshes, { resolution, samples = SAMPLES_PER_UPDATE }) {
            disposeMappers();
            const candidates = meshes.filter(isLightmapCandidate);
            if (!grids.length || !candidates.length) {
                job = null;
                return { meshes: 0 };
            }
            for (const mesh of candidates) mesh.updateWorldMatrix(true, false);
            // The largest surface gets the full resolution; the rest scale by area.
            const largest = Math.max(...candidates.map((mesh) => Math.sqrt(worldSurfaceArea(mesh))), 1e-6);
            const texelsPerUnit = resolution / largest;
            job = {
                irradiance: probeGridIrradiance(grids),
                queue: candidates.map((mesh) => ({ mesh, size: sizeFor(mesh, texelsPerUnit, resolution) })),
                samples,
                done: new Map(),
            };
            return { meshes: candidates.length };
        },

        // Bakes up to `budget` meshes; returns the finished maps once the queue is empty.
        update(budget = 4) {
            if (!job) return null;
            while (budget-- > 0 && job.queue.length) {
                const { mesh, size } = job.queue.shift();
                let mapper = mappers.get(size);
                if (!mapper) {
                    mapper = new SingleObjectLightMapper(renderer, size, job.irradiance);
                    mappers.set(size, mapper);
                }
                mapper.setObject(mesh);
                mapper.update(job.samples);
                const target = targetFor(mesh, size);
                renderer.copyTextureToTexture(mapper.texture, target.texture);
                job.done.set(mesh, target.texture);
            }
            if (job.queue.length) return null;
            const done = job.done;
            job = null;
            disposeMappers();
            // Maps of meshes that dropped out of this bake are no longer valid.
            for (const [mesh, target] of maps) {
                if (done.has(mesh)) continue;
                target.dispose();
                maps.delete(mesh);
            }
            return done;
        },

        cancel() {
            job = null;
            disposeMappers();
        },

        dispose() {
            this.cancel();
            for (const target of maps.values()) target.dispose();
            maps.clear();
        },
    };
}
