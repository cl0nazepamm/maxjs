// Dynamic descriptor loader for the standalone snapshot viewer. Because the
// platform is raw ESM, the import graph IS the bundle: this module must not
// statically import any effect, so a bloom-only snapshot fetches BloomNode.js
// and nothing else.
const EFFECT_IMPORTS = {
    ssgi: () => import('./effects/ssgi.js'),
    ssr: () => import('./effects/ssr.js'),
    gtao: () => import('./effects/gtao.js'),
    motionBlur: () => import('./effects/motionBlur.js'),
    traa: () => import('./effects/traa.js'),
    bloom: () => import('./effects/bloom.js'),
    toonOutline: () => import('./effects/toonOutline.js'),
    contactShadow: () => import('./effects/contactShadow.js'),
    retro: () => import('./effects/retro.js'),
    fog: () => import('./effects/fog.js'),
    volumetric: () => import('./effects/volumetric.js'),
    pixel: () => import('./effects/pixel.js'),
    dof: () => import('./effects/dof.js'),
};

export const KNOWN_EFFECT_IDS = Object.freeze(Object.keys(EFFECT_IMPORTS));

/**
 * Load the descriptors for the given effect ids (snapshot.json →
 * runtimeFeatures.post_fx). Unknown ids — e.g. 'clone', which is a CPU
 * overlay with no fx module — are skipped gracefully.
 */
export async function loadEffects(ids = []) {
    const unique = [...new Set(ids)].filter((id) => {
        if (EFFECT_IMPORTS[id]) return true;
        console.info(`[fx/loader] skipping unknown post-FX id '${id}'`);
        return false;
    });
    const modules = await Promise.all(unique.map((id) => EFFECT_IMPORTS[id]()));
    return modules
        .map((m) => m.default)
        .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}
