function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatMs(ms) {
    return Number.isFinite(ms) ? `${ms.toFixed(2)}ms` : '-';
}

export function createPerfHud(infoEl) {
    const state = {
        statusText: 'MaxJS - booting...',
        /** Shown after the main line; does not disable sync stats (unlike setStatus). */
        projectBanner: '',
        transport: 'waiting',
        frameId: 0,
        producerBytes: 0,
        decodeMs: 0,
        applyMs: 0,
        renderMs: 0,
        layerCount: 0,
        activeLayerCount: 0,
        layerUpdateMs: 0,
        anchorCount: 0,
        nodeCount: 0,
        instanceCount: 0,
        textureCount: 0,
        drawCalls: 0,
        triangleCount: 0,
        memGeometries: 0,
        memTextures: 0,
        fps: 0,
        active: false,
    };

    let debugEnabled = false;
    let lastRenderPaintMs = 0;
    let prevCalls = 0;
    let prevTriangles = 0;
    let fpsFrames = 0;
    let fpsLastSample = 0;

    function bannerSuffix() {
        return state.projectBanner ? ` | ${state.projectBanner}` : '';
    }

    function paint() {
        if (!infoEl.offsetParent && infoEl.style.display === 'none') return;
        if (!state.active) {
            infoEl.textContent = state.statusText + bannerSuffix();
            return;
        }

        infoEl.textContent =
            `MaxJS [${state.transport}] f${state.frameId || '-'} ${state.fps}fps ` +
            `| nodes ${state.nodeCount} ` +
            `| inst ${state.instanceCount} ` +
            `| tex ${state.textureCount} ` +
            `| bytes ${formatBytes(state.producerBytes)} ` +
            `| dec ${formatMs(state.decodeMs)} ` +
            `| app ${formatMs(state.applyMs)} ` +
            `| layers ${state.activeLayerCount}/${state.layerCount} ` +
            `| lyt ${formatMs(state.layerUpdateMs)} ` +
            `| anc ${state.anchorCount} ` +
            `| rnd ${formatMs(state.renderMs)} ` +
            `| calls ${state.drawCalls} ` +
            `| tris ${state.triangleCount} ` +
            `| geo ${state.memGeometries} tex ${state.memTextures}` +
            bannerSuffix();
    }

    return {
        setStatus(text) {
            state.statusText = text;
            state.active = false;
            state.projectBanner = '';
            paint();
        },
        setProjectBanner(text) {
            state.projectBanner = text ? String(text) : '';
            paint();
        },
        updateSync(partial) {
            Object.assign(state, partial);
            state.active = true;
            paint();
        },
        updateCounts(nodeCount, textureCount) {
            state.nodeCount = nodeCount;
            state.textureCount = textureCount;
            if (state.active) paint();
        },
        updateRender(renderMs, renderInfo, memoryInfo) {
            if (!debugEnabled) return;
            state.renderMs = renderMs;
            const currCalls = renderInfo?.calls ?? 0;
            const currTriangles = renderInfo?.triangles ?? 0;
            state.drawCalls = currCalls - prevCalls;
            state.triangleCount = currTriangles - prevTriangles;
            prevCalls = currCalls;
            prevTriangles = currTriangles;
            state.memGeometries = memoryInfo?.geometries ?? 0;
            state.memTextures = memoryInfo?.textures ?? 0;

            const now = performance.now();
            fpsFrames++;
            if (now - fpsLastSample >= 1000) {
                state.fps = Math.round(fpsFrames * 1000 / (now - fpsLastSample));
                fpsFrames = 0;
                fpsLastSample = now;
            }
            if (state.active && now - lastRenderPaintMs >= 250) {
                lastRenderPaintMs = now;
                paint();
            }
        },
        updateLayers(partial) {
            if (!debugEnabled) return;
            Object.assign(state, partial);
            if (state.active) paint();
        },
        setDebugEnabled(enabled) {
            debugEnabled = enabled;
            if (!enabled) {
                prevCalls = 0;
                prevTriangles = 0;
            }
        },
        isDebugEnabled() {
            return debugEnabled;
        },
    };
}
