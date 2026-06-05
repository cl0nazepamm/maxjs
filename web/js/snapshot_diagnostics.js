// snapshot_diagnostics.js - browser-side snapshot stats for the Max WebView.
// Input is snapshot.json text plus native file sizes; no disk or Node APIs here.

const KNOWN_TYPES = new Set([
    'f32', 'u32', 'i32',
    'u16', 'u16n', 'i16', 'i16n', 'half',
    'u8', 'u8n', 'i8', 'i8n',
]);

function stride(type) {
    const t = String(type || 'f32').toLowerCase();
    if (t.startsWith('f32') || t.startsWith('u32') || t.startsWith('i32')) return 4;
    if (t.startsWith('u16') || t.startsWith('i16') || t.startsWith('half')) return 2;
    if (t.startsWith('u8') || t.startsWith('i8')) return 1;
    return 4;
}

function fileSizeMap(files = {}) {
    return {
        snapshotJson: Number(files.snapshotJson ?? files.snapshotJsonBytes ?? 0) || 0,
        sceneBin: Number(files.sceneBin ?? files.sceneBinBytes ?? 0) || 0,
        sceneAnimBin: Number(files.sceneAnimBin ?? files.sceneAnimBytes ?? 0) || 0,
    };
}

function collectMaterials(root) {
    const arr = root?.materials;
    if (!Array.isArray(arr)) return [];
    return arr.map(entry => entry?.mat ?? entry).filter(Boolean);
}

function analyzeSnapshotRoot(root, files = {}, options = {}) {
    const sizes = fileSizeMap(files);
    const channels = {
        positions: 0,
        normals: 0,
        uv: 0,
        uv2: 0,
        vcolor: 0,
        indices: 0,
        skin: 0,
        morph: 0,
    };
    const ranges = [];
    const perNode = [];
    const vcAudit = [];
    const morphNodes = [];
    const unknownTypes = new Set();
    let verts = 0;
    let tris = 0;

    const addRange = (off, count, type, channel, label) => {
        if (off == null || count == null) return 0;
        const n = Number(count);
        const o = Number(off);
        if (!Number.isFinite(o) || !Number.isFinite(n) || n <= 0) return 0;
        const typeName = String(type || 'f32').toLowerCase();
        if (!KNOWN_TYPES.has(typeName)) unknownTypes.add(typeName);
        const len = n * stride(typeName);
        ranges.push({ off: o, len, label });
        channels[channel] += len;
        return len;
    };

    for (const n of root?.nodes || []) {
        const name = n?.n || n?.name || `#${n?.h ?? '?'}`;
        let bytes = 0;
        const geo = n?.geo;
        if (geo) {
            if (geo.vN) {
                bytes += addRange(geo.vOff, geo.vN, 'f32', 'positions', `${name}.pos`);
                verts += Number(geo.vN) / 3;
            }
            if (geo.nN) bytes += addRange(geo.nOff, geo.nN, geo.nType, 'normals', `${name}.nrm`);
            if (geo.uvN) bytes += addRange(geo.uvOff, geo.uvN, geo.uvType, 'uv', `${name}.uv`);
            if (geo.uv2N) bytes += addRange(geo.uv2Off, geo.uv2N, geo.uv2Type, 'uv2', `${name}.uv2`);
            if (geo.iN) {
                bytes += addRange(geo.iOff, geo.iN, geo.iType, 'indices', `${name}.idx`);
                tris += Number(geo.iN) / 3;
            }
            const hasUv2 = geo.uv2N != null;
            if (Array.isArray(geo.vc)) {
                for (const c of geo.vc) {
                    const b = addRange(c.off, c.n, c.type, 'vcolor', `${name}.vc${c.ch}`);
                    bytes += b;
                    const type = String(c.type || 'f32').toLowerCase();
                    vcAudit.push({
                        node: name,
                        ch: c.ch,
                        name: c.name || `vc_${c.ch}`,
                        type,
                        bytes: b,
                        uvDup: c.ch === 2 && hasUv2,
                        f32: type.startsWith('f32'),
                    });
                }
            }
        }
        const skin = n?.skin;
        if (skin) {
            bytes += addRange(skin.wOff, skin.wN, skin.wType, 'skin', `${name}.skinW`);
            bytes += addRange(skin.iOff, skin.iN, skin.iType, 'skin', `${name}.skinI`);
            bytes += addRange(skin.bindOff, skin.bindN, 'f32', 'skin', `${name}.bind`);
        }
        const morph = n?.morph;
        if (morph && Array.isArray(morph.dOff) && Array.isArray(morph.dN)) {
            let morphBytes = 0;
            for (let i = 0; i < morph.dOff.length; i++) {
                morphBytes += addRange(morph.dOff[i], morph.dN[i], 'f32', 'morph', `${name}.morph${i}`);
            }
            bytes += morphBytes;
            const nonzero = (morph.infl || []).filter(v => Math.abs(Number(v) || 0) > 1.0e-5).length;
            morphNodes.push({
                name,
                handle: n.h,
                channels: morph.names?.length || morph.dOff.length,
                nonzero,
                bytes: morphBytes,
                names: Array.isArray(morph.names) ? morph.names.slice(0, options.morphNameLimit ?? 24) : [],
            });
        }
        perNode.push({
            name,
            bytes,
            verts: geo?.vN ? Number(geo.vN) / 3 : 0,
            morphChannels: morph?.names?.length || 0,
            skin: !!skin,
        });
    }

    ranges.sort((a, b) => a.off - b.off);
    let gap = 0;
    let overlap = 0;
    let cursor = 0;
    let highWater = 0;
    for (const r of ranges) {
        if (r.off > cursor) gap += r.off - cursor;
        else if (r.off < cursor) overlap += Math.min(cursor, r.off + r.len) - r.off;
        cursor = Math.max(cursor, r.off + r.len);
        highWater = cursor;
    }

    const clips = Array.isArray(root?.animations?.clips) ? root.animations.clips : [];
    const morphTrackCount = clips.reduce((sum, clip) => {
        const targets = Array.isArray(clip?.targets) ? clip.targets : [];
        return sum + targets.reduce((targetSum, target) => {
            const tracks = Array.isArray(target?.tracks) ? target.tracks : [];
            return targetSum + tracks.filter(track => String(track?.path || '').includes('morphTargetInfluences')).length;
        }, 0);
    }, 0);
    const accounted = Object.values(channels).reduce((sum, value) => sum + value, 0);
    const vcTotal = channels.vcolor;
    const vcDup = vcAudit.filter(v => v.uvDup).reduce((sum, v) => sum + v.bytes, 0);
    const vcHigh = vcAudit.filter(v => Number(v.ch) >= 3).reduce((sum, v) => sum + v.bytes, 0);
    const vcF32 = vcAudit.filter(v => v.f32).reduce((sum, v) => sum + v.bytes, 0);
    const topLimit = options.top ?? 15;

    return {
        files: sizes,
        totals: {
            nodes: Array.isArray(root?.nodes) ? root.nodes.length : 0,
            materials: collectMaterials(root).length,
            verts: Math.round(verts),
            tris: Math.round(tris),
            animationClips: clips.length,
            morphTracks: morphTrackCount,
        },
        sceneBinChannels: channels,
        accounted,
        gap,
        overlap,
        highWater,
        vertexColor: {
            total: vcTotal,
            channels: vcAudit.length,
            bytesOnUv2Duplicates: vcDup,
            bytesOnChannelsGE3: vcHigh,
            bytesStoredAsF32: vcF32,
        },
        morphNodes: morphNodes.sort((a, b) => b.bytes - a.bytes),
        topNodes: perNode.sort((a, b) => b.bytes - a.bytes).slice(0, topLimit),
        unknownTypes: [...unknownTypes],
        raw: root,
    };
}

export function analyzeSnapshotPayload({ snapshotJson, files = {}, options = {} } = {}) {
    const root = typeof snapshotJson === 'string' ? JSON.parse(snapshotJson) : snapshotJson;
    return analyzeSnapshotRoot(root, files, options);
}

export function formatBytes(value) {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatPercent(value, total) {
    return total > 0 ? `${(100 * value / total).toFixed(1)}%` : '-';
}
