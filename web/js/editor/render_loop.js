// render_loop.js - editor frame driver and visible-frame render path.

import { setNirDirectSensing, setNirIlluminatorGain } from 'speedball-gi';

function createRenderLoop(deps = {}) {
        let lastPostFxPanelSyncMs = 0;

        function renderViewerFrame() {
            if (deps.webglBasicFx.isAvailable?.()) {
                deps.webglBasicFx.render(() => deps.renderer.render(deps.scene, deps.camera));
                deps.maxjsFx.afterExternalRender?.();
                return;
            }
            deps.maxjsFx.render();
        }

        function renderFrame(frameTimeMs = performance.now()) {
            deps.flushMaterialDisposals();
            if (deps.renderToImageActive && !deps.pendingRenderToImage) return;
            const manualFpsCap = Number.isFinite(deps.performanceSettings.fpsCap) ? deps.performanceSettings.fpsCap : 0;
            if (!deps.renderer.xr?.isPresenting && manualFpsCap > 0) {
                const minFrameMs = 1000 / manualFpsCap;
                if (deps.lastRenderTimestamp !== 0 && (frameTimeMs - deps.lastRenderTimestamp) < minFrameMs) return;
            }
            deps.lastRenderTimestamp = frameTimeMs;
            deps.inlineTimer.update(frameTimeMs);
            const liveFrameDt = deps.inlineClock.getDelta();
            const liveFrameElapsed = deps.inlineClock.getElapsed();
            const captureFrameTime = deps.renderToImageActive
                && deps.pendingRenderToImage
                && Number.isFinite(deps.pendingRenderToImage.renderTimeSeconds)
                ? deps.pendingRenderToImage.renderTimeSeconds
                : null;
            const frameDt = captureFrameTime == null ? liveFrameDt : 0;
            const frameElapsed = captureFrameTime ?? liveFrameElapsed;
            deps.xrRuntime.update(frameDt);
            // Viewer navigation tuning belongs to the host only in viewport
            // mode. A runtime camera owner borrowing OrbitControls must be able
            // to author its own target, limits and feel without this frame loop
            // writing over them immediately before controls.update().
            if (!deps.xrRuntime.active && deps.layerManager.cameraMode === 'viewport') {
                deps.syncOrbitNavigationFeel();
            }
            let controlsChanged = false;
            if (!deps.xrRuntime.active && !(deps.animationSystem?.isDrivingSceneCamera?.())) {
                deps.layerManager.enforceCameraControls?.();
                controlsChanged = deps.controls.update() === true;
            }
            if (controlsChanged) {
                deps.scheduleGiVolumeFromCurrentScene({
                    delay: deps.GI_VOLUME_CAMERA_DEBOUNCE_MS,
                    refresh: false,
                    reason: 'controls',
                });
            }
            // Auto-update DOF focus distance from camera-to-target when enabled.
            // Physical Camera DOF owns focus/bokeh while the camera packet is active.
            if (!deps.xrRuntime.active && !deps.physicalCameraDofActive) {
                deps.maxjsFx.updateDofFocusFromCamera(deps.camera.position.distanceTo(deps.controls.target));
            }
            deps.syncPathTracingDofFromPostFx();
            // Default key light follows camera
            if (deps.defaultLights.visible) {
                const cameraWorldPosition = deps.getActiveCameraWorldPosition(deps.cameraPositionWorld);
                if (!deps.defaultKey.position.equals(cameraWorldPosition)) {
                    deps.defaultKey.position.copy(cameraWorldPosition);
                    deps.speedballGi?.markLightsDirty?.({ defer: true });
                }
            }
            deps.updateVolumeUniforms();
            deps.lightLinking.updateCameraConstraints();
            if (deps.lightHelpersVisible) deps.updateLightHelpers();
            deps.layerManager.update(frameDt, frameElapsed);
            if (captureFrameTime == null) {
                deps.animationSystem?.update(frameDt);
            } else {
                deps.animationSystem?.seekAllClips?.(captureFrameTime);
            }
            deps.audioSystem?.update();
            if (captureFrameTime == null) {
                deps.gltfSystem?.update?.(frameDt);
            } else {
                deps.gltfSystem?.setTime?.(captureFrameTime);
            }

            const perfHudActive = deps.perfHud.isDebugEnabled?.() ?? false;
            if (perfHudActive) deps.perfHud.updateLayers(deps.layerManager.getStats());
            deps.maxjsFx.applySharedSceneEffects?.();
            deps.removeWebGPUIncompatibleSceneMaterials();
            const renderStart = performance.now();
            // Last-mile render-only camera offsets (handheld shake, etc.).
            // Applied after layer.update + camera sync so they survive until
            // draw, restored after draw so authored state is what the rest of
            // the system sees between frames.
            deps.layerManager.beforeRender?.(frameElapsed);
            // Pipeline active → analytic mask (occluder meshes hidden);
            try {
                if (deps.isPathTracingViewActive() && (!deps.renderToImageActive || deps.pendingRenderToImage?.pathTracing)) {
                    // Pathtracing is a live-viewer-only renderer mode. The live
                    // frame routes through renderPathTracingLiveFrame() so the
                    // color-domain / stylized post FX fold over the PT beauty; PT
                    // still never participates in snapshots.
                    // Claim warmup frames with the PT controller instead of
                    // rasterizing the scene through legacy WebGL; synced
                    // scenes can contain TSL/Node materials that the legacy
                    // renderer cannot draw.
                    if (deps.renderToImageActive && deps.pendingRenderToImage?.pathTracing) {
                        if (deps.pendingRenderToImage.pathTracingStarted) {
                            deps.pathTracingFx.start?.();
                            deps.syncPathTracingDofFromPostFx();
                            if (!deps.pathTracingFx.render?.()) deps.renderPathTracingFallbackFrame();
                        } else {
                            deps.renderPathTracingFallbackFrame();
                        }
                    } else if (!deps.canStartPathTracingNow()) {
                        deps.renderPathTracingFallbackFrame();
                        if (deps.bridgeHasInitialSync()) deps.pathTracingRasterWarmupFrames += 1;
                    } else {
                        deps.pathTracingFx.start?.();
                        // Route the live PT frame through the post stack so the
                        // color-domain / stylized post FX (bloom, pixel, retro,
                        // PowerShot, Shader Lab) fold over the path-traced beauty.
                        // With no post FX enabled it blits straight to the canvas,
                        // and it owns its own fallback if the trace render fails.
                        deps.renderPathTracingLiveFrame();
                    }
                } else if (deps.asciiActive && deps.asciiEffect) {
                    deps.asciiEffect.render(deps.scene, deps.camera);
                } else if (deps.xrRuntime.shouldBypassPostFx) {
                    // Reduce brightness for headset sessions (no post-fx tone mapping)
                    const savedExposure = deps.renderer.toneMappingExposure;
                    const xrLightScale = 0.1;
                    deps.renderer.toneMappingExposure = savedExposure * 0.15;
                    // Scale down lights temporarily
                    deps.scene.traverse(obj => {
                        if (obj.isLight && obj.intensity !== undefined) {
                            obj.userData._xrSavedIntensity = obj.intensity;
                            obj.intensity *= xrLightScale;
                        }
                    });
                    deps.renderer.render(deps.scene, deps.camera);
                    // Restore
                    deps.renderer.toneMappingExposure = savedExposure;
                    deps.scene.traverse(obj => {
                        if (obj.isLight && obj.userData._xrSavedIntensity !== undefined) {
                            obj.intensity = obj.userData._xrSavedIntensity;
                            delete obj.userData._xrSavedIntensity;
                        }
                    });
                } else {
                    renderViewerFrame();
                }
            } catch (error) {
                deps.reportBridgeError('runtime error', error);
            } finally {
                deps.layerManager.afterRender?.(frameElapsed);
            }
            // Idle GI: keep probe rebuilds out of camera/playback/sync churn.
            // Existing probes stay visible as history; after idle, the GPU solve
            // blends new C++/viewer data into the same volume.
            if (!deps.renderToImageActive) {
                deps.updateGiVolumeIdleWork();
                deps.syncGiVolumeActive();
                // Speedball GI probe field tick — every frame (the field idle-gates and
                // budget-throttles itself); no-op unless enabled; never recompiles
                // materials. ONLY camera movement marks interaction — matching the
                // speedball standalone. Host/layer/animation edits send explicit,
                // coalesced dirty packets without marking camera interaction: cheap
                // light/material/transform refits stay live during motion, while
                // structural rebuilds retain Speedball's own rest gate. No fallback
                // scene-signature traversals run in the editor integration.
                const speedballNowMs = performance.now();
                if (controlsChanged || deps.animationSystem?.isDrivingSceneCamera?.()) {
                    deps.speedballGiLastInteractionMs = speedballNowMs;
                }
                deps.speedballGi?.tick(speedballNowMs);
                // White Phosphor = the imager senses NIR. One state, three
                // consumers, each a no-op when unchanged so the per-frame calls
                // are free — and they catch every state path (panel, restore,
                // console):
                //   • trace view: flip the tracer's λ domain to photocathode flux,
                //   • probes NEE: un-gate class-4 IR lights (gi_probes nirGate),
                //   • direct raster term: un-gate the lifted IR light nodes
                //     (gi_lights_node nirGate, shared with MaxLightsNode).
                const psMode = deps.maxjsFx.getPowerShotOptions?.()?.mode;
                const nirSensing = deps.maxjsFx.isPowerShotEnabled?.() === true
                    && (psMode === 'infrared' || psMode === 'nightshot');
                deps.pathTracingFx?.setRenderMode?.(
                    deps.isPathTracingMode && nirSensing ? 'nv' : 'visible');
                deps.speedballGi?.field?.setNirSensing?.(nirSensing);
                setNirDirectSensing(nirSensing);
                // Raster band swap for ctx.spectral material tags: tagged
                // diffuse scalars flip to their authored NIR level under NV
                // (uniform writes only; giColor keeps PT/probe packing on the
                // true visible albedo).
                deps.layerManager?.setSpectralRasterSensing?.(nirSensing);
                // IR Illuminator gain (PowerShot panel): one knob, all three
                // consumers — direct raster term, probes' NEE, PT 850 nm band.
                // Every setter no-ops when unchanged, so per-frame is free.
                const psIrGain = Number(deps.maxjsFx.getPowerShotOptions?.()?.irIlluminator);
                const irGain = Number.isFinite(psIrGain) ? psIrGain : 1;
                setNirIlluminatorGain(irGain);
                deps.speedballGi?.field?.setNirGain?.(irGain);
                deps.pathTracingFx?.setNirGain?.(irGain);
                deps.updateProbeHelpers();
            }
            // Clone blob overlay — draw bounding rects on 2D canvas
            if (deps.maxjsFx.isCloneEnabled() && !deps.renderToImageActive) {
                deps.maxjsFx.drawBlobOverlay(deps.blobOverlayCtx, deps.blobOverlayCvs.width, deps.blobOverlayCvs.height);
            } else if (deps.blobOverlayCtx) {
                deps.blobOverlayCtx.clearRect(0, 0, deps.blobOverlayCvs.width, deps.blobOverlayCvs.height);
            }
            if (deps.renderToImageActive && deps.pendingRenderToImage) {
                const nowMs = performance.now();
                const syncReady = deps.latestAppliedSyncSerial > deps.pendingRenderToImage.observedSyncSerial;
                const settledEnough = nowMs >= (deps.pendingRenderToImage.startedAtMs + deps.pendingRenderToImage.warmupMs);
                if (
                    deps.pendingRenderToImage.pathTracing
                    && !deps.pendingRenderToImage.pathTracingStarted
                    && syncReady
                    && settledEnough
                ) {
                    if (deps.pendingRenderToImage.textureWaitStartedAt <= 0) {
                        deps.pendingRenderToImage.textureWaitStartedAt = nowMs;
                    }
                    const texturesReady = deps.pendingTextureLoads <= 0;
                    const textureWaitExpired = nowMs >= (
                        deps.pendingRenderToImage.textureWaitStartedAt + deps.pendingRenderToImage.textureWaitMs
                    );
                    if (texturesReady || textureWaitExpired) {
                        deps.pendingRenderToImage.pathTracingStarted = true;
                        deps.pathTracingFx.start?.();
                        deps.pathTracingFx.markSceneDirty?.();
                    }
                }
                const pathTracingReady = !deps.pendingRenderToImage.pathTracing
                    || (
                        deps.pendingRenderToImage.pathTracingStarted
                        && deps.pathTracingFx.isCaptureReady?.(deps.pendingRenderToImage.pathTracingMinSamples) === true
                    );
                const timedOut = nowMs >= deps.pendingRenderToImage.syncDeadlineMs;
                if (timedOut && deps.pendingRenderToImage.pathTracing && !pathTracingReady) {
                    const sampleCount = Math.floor(deps.pathTracingFx.getSampleCount?.() ?? 0);
                    deps.perfHud.setStatus(
                        `max.js - PT accumulating ${sampleCount}/${deps.pendingRenderToImage.pathTracingMinSamples}`,
                    );
                    deps.pendingRenderToImage.syncDeadlineMs = nowMs + 30000;
                }
                if ((syncReady && settledEnough && pathTracingReady) || (!deps.pendingRenderToImage.pathTracing && timedOut)) {
                    const capture = deps.pendingRenderToImage;
                    const renderTimeSeconds = capture.renderTimeSeconds;
                    deps.pendingRenderToImage = null;
                    requestAnimationFrame(() => {
                        deps.renderToImageForcePathTracing = capture.pathTracing === true;
                        try {
                            deps.renderCurrentFrameOnce(renderTimeSeconds);
                        } finally {
                            deps.renderToImageForcePathTracing = false;
                        }
                        void deps.sendCurrentCanvasRenderFile(capture);
                    });
                }
            }
            if (deps.postPanelVisible || (deps.debugMode && deps.buildMode !== 'release')) {
                if ((frameTimeMs - lastPostFxPanelSyncMs) >= 250) {
                    lastPostFxPanelSyncMs = frameTimeMs;
                    deps.syncPostFxPanel(false, { persist: false });
                }
            }
            if (perfHudActive) {
                deps.perfHud.updateRender(performance.now() - renderStart, deps.renderer.info?.render, deps.renderer.info?.memory);
            }
        }


        return {
            renderViewerFrame,
            renderFrame,
        };
}

export { createRenderLoop };
