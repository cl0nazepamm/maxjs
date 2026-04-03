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
        active: false,
    };

    let lastRenderPaintMs = 0;

    function paint() {
        if (!state.active) {
            infoEl.textContent = state.statusText;
            return;
        }

        infoEl.textContent =
            `MaxJS [${state.transport}] f${state.frameId || '-'} ` +
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
            `| tris ${state.triangleCount}`;
    }

    return {
        setStatus(text) {
            state.statusText = text;
            state.active = false;
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
        updateRender(renderMs, renderInfo) {
            state.renderMs = renderMs;
            state.drawCalls = renderInfo?.calls ?? 0;
            state.triangleCount = renderInfo?.triangles ?? 0;

            const now = performance.now();
            if (state.active && now - lastRenderPaintMs >= 250) {
                lastRenderPaintMs = now;
                paint();
            }
        },
        updateLayers(partial) {
            Object.assign(state, partial);
            if (state.active) paint();
        },
    };
}
