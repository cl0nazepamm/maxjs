import { EnvironmentNode } from 'three/webgpu';

// max.js policy hook, not an upstream bug fix. Keep Three's specular/retro-
// reflection setup intact while the editor independently mutes diffuse HDRI.
// Audited against r186; see web/THREE_MIGRATION.md for remaining workarounds.
export function installHdriDiffuseSplit(diffuseIntensity) {
    const proto = EnvironmentNode.prototype;
    if (proto.maxjsHdriDiffuseSplitPatched) return;
    const upstreamSetup = proto.setup;
    proto.setup = function (builder) {
        if (builder.renderer?.backend?.isWebGPUBackend !== true) {
            return upstreamSetup.call(this, builder);
        }
        const irradiance = builder.context.iblIrradiance;
        builder.context.iblIrradiance = {
            addAssign(value) { return irradiance.addAssign(value.mul(diffuseIntensity)); },
        };
        try {
            return upstreamSetup.call(this, builder);
        } finally {
            builder.context.iblIrradiance = irradiance;
        }
    };
    Object.defineProperty(proto, 'maxjsHdriDiffuseSplitPatched', { value: true });
}
