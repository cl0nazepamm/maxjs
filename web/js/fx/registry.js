// Static registry of every post-FX descriptor. The editor (maxjs_fx.js) is
// always WebGPU/TSL_GL capable, so it imports the full set eagerly. The
// snapshot viewer must NOT import this file — it uses fx/loader.js to
// dynamic-import only the enabled subset.
import ssgi from './effects/ssgi.js';
import ssr from './effects/ssr.js';
import gtao from './effects/gtao.js';
import motionBlur from './effects/motionBlur.js';
import traa from './effects/traa.js';
import bloom from './effects/bloom.js';
import toonOutline from './effects/toonOutline.js';
import contactShadow from './effects/contactShadow.js';
import retro from './effects/retro.js';
import fog from './effects/fog.js';
import pixel from './effects/pixel.js';
import volumetric from './effects/volumetric.js';
import dof from './effects/dof.js';

// Declaration order matches the historical maxjs_fx.js state-key order so
// snapshotState() serialization stays stable. Composite order is governed by
// each descriptor's slot, not by this array.
export const ALL = [
    ssgi,
    ssr,
    gtao,
    motionBlur,
    traa,
    bloom,
    toonOutline,
    contactShadow,
    retro,
    fog,
    volumetric,
    pixel,
    dof,
];
