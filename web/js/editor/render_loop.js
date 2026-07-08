// render_loop.js - editor frame driver and visible-frame render path.

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
            deps.updateSkyTime(frameElapsed);
            deps.xrRuntime.update(frameDt);
            if (!deps.xrRuntime.active) deps.syncOrbitNavigationFeel();
            let controlsChanged = false;
            if (!deps.xrRuntime.active && !(deps.animationSystem?.isDrivingSceneCamera?.())) {
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
                deps.defaultKey.position.copy(deps.getActiveCameraWorldPosition(deps.cameraPositionWorld));
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
            // Depth-occluded web panels: pick punch mode for this frame.
            // Pipeline active → analytic mask (occluder meshes hidden);
            // direct render → occluder meshes punch natively. Canvas-readback
            // captures suppress punching (no alpha holes in output); composited
            // captures keep it — the DOM behind the holes IS in the output.
            deps.webappSystem?.setPunchSuppressed?.(
                deps.renderToImageActive === true && !deps.renderCaptureComposited);
            deps.webappSystem?.setPunchPipelineActive?.(deps.maxjsFx.isPipelineRenderActive?.() === true);
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
                // HALO-GI probe field tick — every frame (the field idle-gates and
                // budget-throttles itself); no-op unless enabled; never recompiles
                // materials. ONLY camera movement marks interaction — matching the
                // speedball standalone. Delta-sync must NOT mark it: Max edits
                // stream serials at 30-60 Hz, which starved the 200 ms idle gate
                // and deferred every light/geo pickup until the drag ended
                // ("delayed" GI). The field handles live edits itself — cheap
                // in-place light refresh + settle-debounced geometry rebuild
                // (24-tick checks × 2 stable) that can never land mid-drag.
                const haloNowMs = performance.now();
                if (controlsChanged) deps.haloGiLastInteractionMs = haloNowMs;
                deps.haloGi?.tick(haloNowMs);
                // White Phosphor × trace view = TRUE-NIR: flip the tracer's λ
                // domain to photocathode flux automatically. setRenderMode
                // no-ops when unchanged, so the per-frame call is free — and
                // it catches every state path (panel, restore, console).
                deps.pathTracingFx?.setRenderMode?.(
                    deps.isPathTracingMode
                        && deps.maxjsFx.isPowerShotEnabled?.()
                        && deps.maxjsFx.getPowerShotOptions?.()?.mode === 'infrared'
                        ? 'nv' : 'visible');
                deps.updateProbeHelpers();
            }
            deps.css3dOverlay.tick(deps.scene, deps.camera);
            deps.css3dOverlay.tickBehind(deps.webappSystem?.getBehindScene?.(), deps.camera);
            // Clone blob overlay — draw bounding rects on 2D canvas
            if (deps.maxjsFx.isCloneEnabled() && !deps.renderToImageActive) {
                deps.maxjsFx.drawBlobOverlay(deps.blobOverlayCtx, deps.blobOverlayCvs.width, deps.blobOverlayCvs.height);
            } else if (deps.blobOverlayCtx) {
                deps.blobOverlayCtx.clearRect(0, 0, deps.blobOverlayCvs.width, deps.blobOverlayCvs.height);
            }
            if (deps.splatsSystem.overlay && deps.splatsSystem.count > 0) {
                deps.updateSplatCamera();
                deps.splatsSystem.overlay.renderer.render(deps.splatsSystem.overlay.scene, deps.splatsSystem.overlay.camera);
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
                        if (capture.composited) {
                            // C++ captures the WebView composite (CapturePreview)
                            // on receipt — DOM panels + canvas as displayed. One
                            // extra frame lets the compositor present the final
                            // CSS3D state before the grab.
                            requestAnimationFrame(() => {
                                deps.bridge.send(capture.responseType, { composited: true });
                            });
                        } else {
                            // Both paths read the canvas back to C++. The Max-bitmap
                            // path (render_to_image_ready) needs the pixels too — its
                            // alpha channel only survives from the canvas, not from
                            // WebView2 CapturePreview.
                            void deps.sendCurrentCanvasRenderFile(capture);
                        }
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
