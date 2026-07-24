// pathtracing_glue.js - editor glue for live Spectral path tracing.
import * as THREE from 'three';

function createPathTracingGlue(deps = {}) {
        const PATH_TRACE_UPDATE_TRANSFORM = 1;
        const PATH_TRACE_UPDATE_DEFORM = 2;
        const PATH_TRACE_UPDATE_FULL = 4;
        const PATH_TRACE_UPDATE_LIGHT = 8;
        let pathTracingLiveRebuildTimer = 0;
        let pathTracingLiveUpdateMask = 0;
        let pathTracingInactiveUpdateMask = 0;
        function isPathTracingViewActive() {
            return deps.isPathTracingMode && deps.pathTracingFx.isEnabled?.() === true;
        }

        function leavePathTracingView() {
            // A scheduled update must survive switching to Probe view. The
            // retained tracer scene is intentionally kept alive, so dropping
            // this mask would show stale geometry/lights on the next Trace entry.
            pathTracingInactiveUpdateMask = mergePathTracingUpdateMasks(
                pathTracingInactiveUpdateMask,
                pathTracingLiveUpdateMask,
            );
            clearScheduledPathTracingLiveRebuild();
            deps.pathTracingFx.setToneMapInBlit?.(true);
            deps.maxjsFx.setPathTracedSource?.(null);
        }

        // Live spectral-view switch: probe GI <-> path tracer, no reload.
        // The probe ticker checks isPathTracingMode per tick and the render
        // loop gates the PT branch on it. Leaving trace view must also clear
        // the post stack's PT source, otherwise regular spectral/probe frames
        // keep presenting the last path-traced texture.
        function setSpectralView(view) {
            const next = view === 'trace' ? 'trace' : 'probes';
            if (next === 'trace' && deps.hasActiveLightLinks?.()) {
                deps.perfHud?.setStatus?.('max.js - set linked lights to None before using Trace');
                return deps.spectralView;
            }
            if (!deps.isStudioMode || deps.spectralView === next) return deps.spectralView;
            deps.spectralView = next;
            deps.isPathTracingMode = next === 'trace';
            document.body.classList.toggle('pathtracing-mode', deps.isPathTracingMode);
            if (deps.isPathTracingMode) {
                deps.pathTracingFx.start?.();
                resetPathTracingStartupWarmup();
                if (pathTracingInactiveUpdateMask) {
                    pathTracingLiveUpdateMask = mergePathTracingUpdateMasks(
                        pathTracingLiveUpdateMask,
                        pathTracingInactiveUpdateMask,
                    );
                    pathTracingInactiveUpdateMask = 0;
                    armPathTracingLiveUpdateTimer();
                }
            } else {
                leavePathTracingView();
            }
            const skyChanged = deps.refreshSkyForSpectralView?.() === true;
            if (deps.isPathTracingMode && skyChanged) markPathTracingSceneDirtyNow();
            window.__maxjsSyncSpectralViewUi?.();
            if (window.chrome?.webview) sendPathTracingRuntimeState();
            return deps.spectralView;
        }
        window.maxjsSpectral = { getView: () => deps.spectralView, setView: setSpectralView };
        // Linear-HDR target the path tracer blits into when its output is routed
        // through the camera post stack (bloom/grade/grain + PowerShot). The
        // post stack gates its own gbuffer effects (SSGI/SSR/...) once a PT
        // source is set, so only the color-domain effects fold over PT's beauty.
        let pathTracingPostTarget = null;
        function ensurePathTracingPostTarget() {
            if (typeof THREE.RenderTarget !== 'function') return null;
            const v = new THREE.Vector2();
            deps.renderer.getDrawingBufferSize(v);
            const w = Math.max(1, Math.floor(v.x));
            const h = Math.max(1, Math.floor(v.y));
            if (pathTracingPostTarget && (pathTracingPostTarget.width !== w || pathTracingPostTarget.height !== h)) {
                pathTracingPostTarget.dispose();
                pathTracingPostTarget = null;
            }
            if (!pathTracingPostTarget) {
                pathTracingPostTarget = new THREE.RenderTarget(w, h, {
                    type: THREE.HalfFloatType,
                    colorSpace: THREE.LinearSRGBColorSpace,
                    depthBuffer: false,
                });
            }
            return pathTracingPostTarget;
        }

        function hasPathTracingPostFxActive() {
            return !!(
                deps.shaderLabFx?.isEnabled?.()
                || deps.maxjsFx.isBloomEnabled?.()
                || deps.maxjsFx.isPixelEnabled?.()
                || deps.maxjsFx.isRetroEnabled?.()
                || deps.maxjsFx.isPowerShotEnabled?.()
            );
        }

        function renderPathTracingLiveFrame() {
            deps.syncPathTracingDofFromPostFx();
            const wantPost = !deps.renderToImageActive
                && deps.maxjsFx.isAvailable?.()
                && hasPathTracingPostFxActive();
            if (wantPost) {
                const rt = ensurePathTracingPostTarget();
                if (rt) {
                    deps.pathTracingFx.setToneMapInBlit?.(false); // emit linear HDR
                    const prevTarget = deps.renderer.getRenderTarget();
                    deps.renderer.setRenderTarget(rt);
                    const ok = deps.pathTracingFx.render?.();
                    deps.renderer.setRenderTarget(prevTarget);
                    if (ok) {
                        deps.maxjsFx.setPathTracedSource?.(rt.texture);
                        deps.maxjsFx.render();
                        return;
                    }
                }
            }
            // Direct path: the blit tone-maps straight to the canvas.
            deps.pathTracingFx.setToneMapInBlit?.(true);
            deps.maxjsFx.setPathTracedSource?.(null);
            if (!deps.pathTracingFx.render?.()) renderPathTracingFallbackFrame();
        }

        function normalizePathTracingSamplesPerFrame(value) {
            const n = Math.round(Number(value));
            if (!Number.isFinite(n)) return 64;
            return Math.max(1, Math.min(512, n));
        }

        function normalizePathTracingGIClamp(value) {
            const n = Number(value);
            if (!Number.isFinite(n)) return 8.0;
            return Math.max(1.0, Math.min(1000.0, n));
        }

        function normalizePathTracingSampleLimit(value) {
            const n = Math.round(Number(value));
            if (!Number.isFinite(n) || n <= 0) return 0; // 0 = unlimited
            return Math.min(100000, n);
        }

        function resetPathTracingStartupWarmup() {
            deps.pathTracingRasterWarmupFrames = 0;
            deps.pathTracingWarmupStartedAt = 0;
        }

        function canStartPathTracingNow() {
            if (!deps.isPathTracingMode || !deps.bridgeHasInitialSync()) return false;
            if (deps.pathTracingWarmupStartedAt <= 0) deps.pathTracingWarmupStartedAt = performance.now();
            if (deps.pathTracingRasterWarmupFrames < deps.PATH_TRACING_RASTER_WARMUP_FRAMES) return false;
            const waitedMs = performance.now() - deps.pathTracingWarmupStartedAt;
            if (deps.pendingTextureLoads > 0 && waitedMs < deps.PATH_TRACING_TEXTURE_WAIT_MS) return false;
            return true;
        }

        function renderPathTracingFallbackFrame() {
            return deps.pathTracingFx.clearFrame?.() === true;
        }

        function clearScheduledPathTracingLiveRebuild() {
            if (pathTracingLiveRebuildTimer) {
                clearTimeout(pathTracingLiveRebuildTimer);
                pathTracingLiveRebuildTimer = 0;
            }
            pathTracingLiveUpdateMask = 0;
        }

        function markPathTracingSceneDirtyNow() {
            clearScheduledPathTracingLiveRebuild();
            pathTracingInactiveUpdateMask = 0;
            if (deps.pathTracingFx.isEnabled?.()) {
                deps.pathTracingFx.markSceneDirty?.();
            }
        }

        function armPathTracingLiveUpdateTimer() {
            if (pathTracingLiveRebuildTimer) clearTimeout(pathTracingLiveRebuildTimer);
            pathTracingLiveRebuildTimer = setTimeout(flushPathTracingLiveUpdate, deps.PATH_TRACING_LIVE_REBUILD_DELAY_MS);
        }

        function flushPathTracingLiveUpdate() {
            pathTracingLiveRebuildTimer = 0;
            if (!deps.isPathTracingMode || deps.pathTracingSettings.freezeSync) {
                pathTracingLiveUpdateMask = 0;
                return;
            }
            // Playback can stop without another geometry packet. Poll the
            // authoritative timeline state, but never land CPU scene work in
            // the middle of playback. Paused slider packets keep resetting the
            // trailing edge naturally.
            if (deps.maxTimeline?.playing?.() === true) {
                armPathTracingLiveUpdateTimer();
                return;
            }
            const mask = pathTracingLiveUpdateMask;
            pathTracingLiveUpdateMask = 0;
            if ((mask & PATH_TRACE_UPDATE_FULL) !== 0) {
                deps.pathTracingFx.markSceneDirty?.();
            } else if ((mask & PATH_TRACE_UPDATE_DEFORM) !== 0) {
                if (typeof deps.pathTracingFx.markDeformsDirty === 'function') {
                    deps.pathTracingFx.markDeformsDirty({ transforms: (mask & PATH_TRACE_UPDATE_TRANSFORM) !== 0 });
                } else {
                    deps.pathTracingFx.markSceneDirty?.();
                }
            } else if ((mask & PATH_TRACE_UPDATE_TRANSFORM) !== 0) {
                if (typeof deps.pathTracingFx.markTransformsDirty === 'function') {
                    deps.pathTracingFx.markTransformsDirty();
                } else {
                    deps.pathTracingFx.markSceneDirty?.();
                }
            }
            if ((mask & PATH_TRACE_UPDATE_LIGHT) !== 0) {
                if (typeof deps.pathTracingFx.markLightsDirty === 'function') {
                    deps.pathTracingFx.markLightsDirty();
                } else {
                    deps.pathTracingFx.markSceneDirty?.();
                }
            }
        }

        function mergePathTracingUpdateMasks(currentMask, nextMask) {
            if ((currentMask & PATH_TRACE_UPDATE_FULL) !== 0) return currentMask;
            if ((nextMask & PATH_TRACE_UPDATE_FULL) !== 0) return PATH_TRACE_UPDATE_FULL;
            return currentMask | nextMask;
        }

        function schedulePathTracingLiveRebuild(changeKind = 'full') {
            if (deps.pathTracingSettings.freezeSync) return;
            let nextMask = PATH_TRACE_UPDATE_FULL;
            if (changeKind === 'transform') nextMask = PATH_TRACE_UPDATE_TRANSFORM;
            else if (changeKind === 'deform') nextMask = PATH_TRACE_UPDATE_DEFORM;
            else if (changeKind === 'light') nextMask = PATH_TRACE_UPDATE_LIGHT;
            if (!deps.pathTracingFx.isStarted?.()) {
                // The first start always builds from the current scene.
                return;
            }
            if (!deps.isPathTracingMode) {
                pathTracingInactiveUpdateMask = mergePathTracingUpdateMasks(
                    pathTracingInactiveUpdateMask,
                    nextMask,
                );
                return;
            }
            pathTracingLiveUpdateMask = mergePathTracingUpdateMasks(
                pathTracingLiveUpdateMask,
                nextMask,
            );
            // True trailing edge: every packet moves the flush point. This
            // coalesces a play/scrub burst into one latest-pose update.
            armPathTracingLiveUpdateTimer();
        }

        function sendPathTracingRuntimeState() {
            deps.bridge?.send?.('pathtracing_settings', {
                samplesPerFrame: deps.pathTracingSettings.samplesPerFrame,
                giClamp: deps.pathTracingSettings.giClamp,
                freezeSync: deps.pathTracingSettings.freezeSync,
                paused: deps.pathTracingSettings.paused,
                sampleLimit: deps.pathTracingSettings.sampleLimit,
                active: deps.isPathTracingMode,
            });
        }

        function applyPathTracingSettings(next = {}, { notify = false, sendHost = false } = {}) {
            const wasFrozen = deps.pathTracingSettings.freezeSync === true;
            deps.pathTracingSettings.samplesPerFrame = normalizePathTracingSamplesPerFrame(
                next.samplesPerFrame ?? deps.pathTracingSettings.samplesPerFrame,
            );
            deps.pathTracingSettings.giClamp = normalizePathTracingGIClamp(
                next.giClamp ?? deps.pathTracingSettings.giClamp,
            );
            deps.pathTracingSettings.sampleLimit = normalizePathTracingSampleLimit(
                next.sampleLimit ?? deps.pathTracingSettings.sampleLimit,
            );
            if (next.freezeSync != null) deps.pathTracingSettings.freezeSync = next.freezeSync === true;
            if (next.paused != null) {
                deps.pathTracingSettings.paused = next.paused === true;
                // Pause stops all compute dispatch → GPU idle → UI panels stay
                // responsive while the last accumulated frame holds on screen.
                deps.pathTracingFx.setPaused?.(deps.pathTracingSettings.paused);
                deps.ptPauseUiSync?.();
            }
            deps.pathTracingFx.setOptions?.(deps.pathTracingSettings);
            if (wasFrozen && !deps.pathTracingSettings.freezeSync) {
                if (deps.isPathTracingMode && deps.bridgeHasInitialSync()) {
                    // C++ still advanced its sent-state caches while JS was ignoring updates.
                    // Ask for one authoritative resync when accumulation is unfrozen.
                    deps.bridge.send('scene_dirty', { reason: 'pathtracing_unfreeze' });
                    markPathTracingSceneDirtyNow();
                } else if (deps.pathTracingFx.isStarted?.()) {
                    pathTracingInactiveUpdateMask = mergePathTracingUpdateMasks(
                        pathTracingInactiveUpdateMask,
                        PATH_TRACE_UPDATE_FULL,
                    );
                }
            }
            if (sendHost && window.chrome?.webview) {
                sendPathTracingRuntimeState();
            }
            if (notify && deps.isPathTracingMode) {
                deps.perfHud.setStatus(
                    `max.js - PT samples/frame ${deps.pathTracingSettings.samplesPerFrame}, GI clamp ${deps.pathTracingSettings.giClamp.toFixed(1)}, sync ${deps.pathTracingSettings.freezeSync ? 'frozen' : 'live'}`,
                );
            }
        }


        return {
            isPathTracingViewActive,
            leavePathTracingView,
            setSpectralView,
            renderPathTracingLiveFrame,
            resetPathTracingStartupWarmup,
            canStartPathTracingNow,
            renderPathTracingFallbackFrame,
            markPathTracingSceneDirtyNow,
            schedulePathTracingLiveRebuild,
            sendPathTracingRuntimeState,
            applyPathTracingSettings,
        };
}

export { createPathTracingGlue };
