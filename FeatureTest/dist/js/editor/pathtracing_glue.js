// pathtracing_glue.js - editor glue for the live path tracing view (path_tracer.js).
import * as THREE from 'three';

function createPathTracingGlue(deps = {}) {
        const PATH_TRACE_UPDATE_TRANSFORM = 1;
        const PATH_TRACE_UPDATE_DEFORM = 2;
        const PATH_TRACE_UPDATE_FULL = 4;
        const PATH_TRACE_UPDATE_LIGHT = 8;
        const PATH_TRACE_UPDATE_MATERIAL = 16;
        let pathTracingLiveRebuildTimer = 0;
        let pathTracingLiveUpdateMask = 0;
        let pathTracingInactiveUpdateMask = 0;
        function isPathTracingViewActive() {
            return deps.isPathTracingMode && deps.pathTracingFx.isEnabled?.() === true;
        }

        function leavePathTracingView() {
            // A scheduled update must survive leaving the view: the tracer keeps its
            // scene, so dropping this mask would show stale geometry on the next entry.
            pathTracingInactiveUpdateMask = mergePathTracingUpdateMasks(
                pathTracingInactiveUpdateMask,
                pathTracingLiveUpdateMask,
            );
            clearScheduledPathTracingLiveRebuild();
            deps.maxjsFx.setPathTracedSource?.(null);
        }

        // Live raster <-> path tracing switch, no reload. Leaving the view must also
        // clear the post stack's path-traced source, or raster frames keep
        // presenting the last traced texture.
        function setPathTracingActive(active) {
            const next = active === true;
            if (next === deps.isPathTracingMode) return deps.isPathTracingMode;
            if (next && !deps.pathTracingFx.isEnabled?.()) {
                deps.perfHud?.setStatus?.('max.js - path tracing needs the WebGPU backend');
                return false;
            }
            if (next && deps.hasActiveLightLinks?.()) {
                deps.perfHud?.setStatus?.('max.js - set linked lights to None before path tracing');
                return false;
            }
            deps.isPathTracingMode = next;
            document.body.classList.toggle('pathtracing-mode', next);
            if (next) {
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
            if (deps.refreshSkyForPathTracing?.() === true && next) markPathTracingSceneDirtyNow();
            window.__maxjsSyncPathTracingUi?.();
            if (window.chrome?.webview) sendPathTracingRuntimeState();
            return deps.isPathTracingMode;
        }
        window.maxjsPathTracing = {
            isActive: () => deps.isPathTracingMode,
            setActive: setPathTracingActive,
        };

        // Linear-HDR target the path tracer renders into when its output goes through
        // the camera post stack. The stack skips its g-buffer effects (SSGI/SSR/...)
        // while a path-traced source is set; only color-domain effects apply.
        let pathTracingPostTarget = null;
        function ensurePathTracingPostTarget() {
            const v = new THREE.Vector2();
            deps.renderer.getDrawingBufferSize(v);
            const w = Math.max(1, Math.floor(v.x));
            const h = Math.max(1, Math.floor(v.y));
            if (pathTracingPostTarget && (pathTracingPostTarget.width !== w || pathTracingPostTarget.height !== h)) {
                pathTracingPostTarget.dispose();
                pathTracingPostTarget = null;
            }
            pathTracingPostTarget ??= new THREE.RenderTarget(w, h, {
                type: THREE.HalfFloatType,
                colorSpace: THREE.LinearSRGBColorSpace,
                depthBuffer: false,
            });
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
            // Direct path: the renderer's output transform tone maps the canvas blit.
            deps.maxjsFx.setPathTracedSource?.(null);
            if (!deps.pathTracingFx.render?.()) renderPathTracingFallbackFrame();
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
            deps.pathTracingFx.markSceneDirty?.();
        }

        function markPathTracingEnvironmentDirty() {
            deps.pathTracingFx.markEnvironmentDirty?.();
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
            // Playback can stop without another packet: poll the timeline, but never
            // land scene work in the middle of playback.
            if (deps.maxTimeline?.playing?.() === true) {
                armPathTracingLiveUpdateTimer();
                return;
            }
            const mask = pathTracingLiveUpdateMask;
            pathTracingLiveUpdateMask = 0;
            const fx = deps.pathTracingFx;
            if ((mask & PATH_TRACE_UPDATE_FULL) !== 0) {
                fx.markSceneDirty();
                return;
            }
            if ((mask & PATH_TRACE_UPDATE_DEFORM) !== 0) fx.markDeformsDirty({ transforms: (mask & PATH_TRACE_UPDATE_TRANSFORM) !== 0 });
            else if ((mask & PATH_TRACE_UPDATE_TRANSFORM) !== 0) fx.markTransformsDirty();
            if ((mask & PATH_TRACE_UPDATE_MATERIAL) !== 0) fx.markMaterialsDirty();
            if ((mask & PATH_TRACE_UPDATE_LIGHT) !== 0) fx.markLightsDirty();
        }

        function mergePathTracingUpdateMasks(currentMask, nextMask) {
            if ((currentMask & PATH_TRACE_UPDATE_FULL) !== 0) return currentMask;
            if ((nextMask & PATH_TRACE_UPDATE_FULL) !== 0) return PATH_TRACE_UPDATE_FULL;
            return currentMask | nextMask;
        }

        const UPDATE_LANES = {
            transform: PATH_TRACE_UPDATE_TRANSFORM,
            deform: PATH_TRACE_UPDATE_DEFORM,
            light: PATH_TRACE_UPDATE_LIGHT,
            material: PATH_TRACE_UPDATE_MATERIAL,
        };

        function schedulePathTracingLiveRebuild(changeKind = 'full') {
            if (deps.pathTracingSettings.freezeSync) return;
            // The first start always builds from the current scene.
            if (!deps.pathTracingFx.isStarted?.()) return;
            const nextMask = UPDATE_LANES[changeKind] ?? PATH_TRACE_UPDATE_FULL;
            if (!deps.isPathTracingMode) {
                pathTracingInactiveUpdateMask = mergePathTracingUpdateMasks(pathTracingInactiveUpdateMask, nextMask);
                return;
            }
            pathTracingLiveUpdateMask = mergePathTracingUpdateMasks(pathTracingLiveUpdateMask, nextMask);
            // True trailing edge: every packet moves the flush point, so a play/scrub
            // burst lands as one latest-pose update.
            armPathTracingLiveUpdateTimer();
        }

        function sendPathTracingRuntimeState() {
            deps.bridge?.send?.('pathtracing_settings', {
                bounces: deps.pathTracingSettings.bounces,
                giClamp: deps.pathTracingSettings.giClamp,
                freezeSync: deps.pathTracingSettings.freezeSync,
                paused: deps.pathTracingSettings.paused,
                sampleLimit: deps.pathTracingSettings.sampleLimit,
                active: deps.isPathTracingMode,
            });
        }

        function applyPathTracingSettings(next = {}, { notify = false, sendHost = false } = {}) {
            const wasFrozen = deps.pathTracingSettings.freezeSync === true;
            deps.pathTracingFx.setOptions(next);
            if (next.paused != null) deps.ptPauseUiSync?.();
            if (wasFrozen && !deps.pathTracingSettings.freezeSync) {
                if (deps.isPathTracingMode && deps.bridgeHasInitialSync()) {
                    // The host kept advancing its sent-state caches while sync was frozen:
                    // ask for one authoritative resync.
                    deps.bridge.send('scene_dirty', { reason: 'pathtracing_unfreeze' });
                    markPathTracingSceneDirtyNow();
                } else if (deps.pathTracingFx.isStarted?.()) {
                    pathTracingInactiveUpdateMask = PATH_TRACE_UPDATE_FULL;
                }
            }
            if (sendHost && window.chrome?.webview) sendPathTracingRuntimeState();
            if (notify && deps.isPathTracingMode) {
                const s = deps.pathTracingSettings;
                deps.perfHud.setStatus(`max.js - PT bounces ${s.bounces}, GI clamp ${s.giClamp.toFixed(1)}, sync ${s.freezeSync ? 'frozen' : 'live'}`);
            }
        }

        return {
            isPathTracingViewActive,
            leavePathTracingView,
            setPathTracingActive,
            renderPathTracingLiveFrame,
            resetPathTracingStartupWarmup,
            canStartPathTracingNow,
            renderPathTracingFallbackFrame,
            markPathTracingSceneDirtyNow,
            markPathTracingEnvironmentDirty,
            schedulePathTracingLiveRebuild,
            sendPathTracingRuntimeState,
            applyPathTracingSettings,
        };
}

export { createPathTracingGlue };
