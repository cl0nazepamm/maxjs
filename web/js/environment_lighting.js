import { EnvironmentNode } from 'three/webgpu';

// While set, HDRI light (specular radiance, diffuse irradiance, clearcoat)
// passes through this node transform as materials compile; the NIR band view
// (nir_band_view.js) converts it to NIR bands. Affects materials built after
// the change, so callers recompile the materials they switch.
let environmentLightTransform = null;
export function setEnvironmentLightTransform(transform) {
    environmentLightTransform = typeof transform === 'function' ? transform : null;
}

// max.js policy hook, not an upstream bug fix. Keep Three's specular/retro-
// reflection setup intact while the editor independently mutes diffuse HDRI
// (reflection-only HDRI, or probe grids that already captured it).
// Audited against r187; see web/THREE_MIGRATION.md for remaining workarounds.
export function installHdriDiffuseSplit(diffuseIntensity) {
    const proto = EnvironmentNode.prototype;
    if (proto.maxjsHdriDiffuseSplitPatched) return;
    const upstreamSetup = proto.setup;
    proto.setup = function (builder) {
        const transform = environmentLightTransform;
        const { context } = builder;
        const irradiance = context.iblIrradiance;
        const radiance = context.radiance;
        const lightingModel = context.lightingModel;
        const clearcoat = lightingModel?.clearcoatRadiance;
        context.iblIrradiance = {
            addAssign(value) {
                const diffuse = value.mul(diffuseIntensity);
                return irradiance.addAssign(transform ? transform(diffuse) : diffuse);
            },
        };
        if (transform) {
            context.radiance = { addAssign: (value) => radiance.addAssign(transform(value)) };
            if (clearcoat) lightingModel.clearcoatRadiance = { addAssign: (value) => clearcoat.addAssign(transform(value)) };
        }
        try {
            return upstreamSetup.call(this, builder);
        } finally {
            context.iblIrradiance = irradiance;
            if (transform) {
                context.radiance = radiance;
                if (clearcoat) lightingModel.clearcoatRadiance = clearcoat;
            }
        }
    };
    Object.defineProperty(proto, 'maxjsHdriDiffuseSplitPatched', { value: true });
}
