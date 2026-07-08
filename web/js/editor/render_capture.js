// render_capture.js - editor render-to-image and CSS3D mask capture glue.
import * as THREE from 'three';
import * as css3dOverlay from '../css3d_overlay.js';

function createRenderCapture(deps = {}) {
        function readBlobAsDataUrl(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
                reader.readAsDataURL(blob);
            });
        }

        function canvasToBlob(canvas, mime, quality) {
            return new Promise(resolve => {
                try {
                    canvas.toBlob(blob => resolve(blob), mime, quality);
                } catch {
                    resolve(null);
                }
            });
        }

        function mimeSupportsAlpha(mime) {
            const normalized = String(mime || '').toLowerCase();
            return normalized === 'image/png' || normalized === 'image/webp';
        }

        async function sendCurrentCanvasRenderFile(capture) {
            const responseType = capture?.responseType || 'render_sequence_frame_file';
            try {
                const requestedMime = typeof capture?.mime === 'string' && capture.mime
                    ? capture.mime
                    : 'image/png';
                const quality = requestedMime === 'image/jpeg' || requestedMime === 'image/webp'
                    ? 0.95
                    : undefined;
                let blob = await canvasToBlob(deps.renderer.domElement, requestedMime, quality);
                if (!blob && requestedMime !== 'image/png') {
                    blob = await canvasToBlob(deps.renderer.domElement, 'image/png');
                }
                if (!blob) throw new Error('Canvas image export failed');

                const dataUrl = await readBlobAsDataUrl(blob);
                const comma = dataUrl.indexOf(',');
                if (comma < 0) throw new Error('Canvas image payload missing data URL header');
                deps.bridge.send(responseType, {
                    imageBase64: dataUrl.slice(comma + 1),
                    mime: blob.type || requestedMime,
                    width: capture?.width || deps.renderer.domElement.width || 0,
                    height: capture?.height || deps.renderer.domElement.height || 0,
                });
            } catch (error) {
                deps.bridge.send(responseType, {
                    error: error?.message || String(error),
                });
            }
        }


        // ── Render to Image (production render) ──────────────
        let savedPerformanceSettings = null;
        let savedRenderToImageState = null;

        function getCss3dMaskRoots() {
            return [
                document.getElementById('maxjs-css3d-root'),
                document.getElementById('maxjs-css3d-behind-root'),
            ].filter(Boolean);
        }

        function getCss3dMaskHosts() {
            return getCss3dMaskRoots().flatMap(root => (
                Array.from(root.querySelectorAll('iframe, .maxjs-webapp-div-host'))
            ));
        }

        function cleanupCss3dMaskDomLeaks() {
            const leaked = Array.from(document.querySelectorAll('.maxjs-css3d-mask-overlay'));
            if (leaked.length > 0) {
                for (const el of leaked) {
                    const prev = el.previousElementSibling;
                    if (prev?.matches?.('iframe, .maxjs-webapp-div-host') && prev.style.visibility === 'hidden') {
                        prev.style.visibility = '';
                    }
                    try { el.remove(); } catch {}
                }
            }
            try { document.getElementById('maxjs-css3d-mask-style')?.remove(); } catch {}
        }

        function css3dMaskOutputSize(msg = null) {
            const width = Math.max(1, Math.floor(
                Number(msg?.width) || deps.renderer.domElement?.width || innerWidth || 1
            ));
            const height = Math.max(1, Math.floor(
                Number(msg?.height) || deps.renderer.domElement?.height || innerHeight || 1
            ));
            return { width, height };
        }

        function isCss3dMaskHostVisible(host) {
            if (!host?.isConnected) return false;
            const style = getComputedStyle(host);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if ((Number(style.opacity) || 0) <= 0) return false;
            const rect = host.getBoundingClientRect();
            return rect.width > 0.5 && rect.height > 0.5;
        }

        function getCss3dMaskHostQuad(host, width, height) {
            const scaleX = width / Math.max(1, innerWidth || width);
            const scaleY = height / Math.max(1, innerHeight || height);
            try {
                const quad = host.getBoxQuads?.()[0];
                if (quad) {
                    return [quad.p1, quad.p2, quad.p3, quad.p4].map(p => ({
                        x: p.x * scaleX,
                        y: p.y * scaleY,
                    }));
                }
            } catch {}
            const r = host.getBoundingClientRect();
            return [
                { x: r.left * scaleX, y: r.top * scaleY },
                { x: r.right * scaleX, y: r.top * scaleY },
                { x: r.right * scaleX, y: r.bottom * scaleY },
                { x: r.left * scaleX, y: r.bottom * scaleY },
            ];
        }

        function drawCss3dMaskQuad(ctx, points) {
            if (!points || points.length < 3) return;
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
            ctx.closePath();
            ctx.fill();
        }

        function collectCss3dMaskQuads(width, height) {
            const quads = [];
            for (const host of getCss3dMaskHosts()) {
                if (!isCss3dMaskHostVisible(host)) continue;
                quads.push({
                    behind: !!host.closest('#maxjs-css3d-behind-root'),
                    points: getCss3dMaskHostQuad(host, width, height),
                });
            }
            return quads;
        }

        function renderCss3dMaskFrame(msg = null) {
            const frameNumber = Number.isFinite(msg?.frame) ? msg.frame : 0;
            const fps = Number.isFinite(msg?.fps) && msg.fps > 0 ? msg.fps : 30;
            const renderTimeSeconds = frameNumber / fps;
            cleanupCss3dMaskDomLeaks();
            deps.renderCaptureComposited = true;
            deps.webappSystem?.setPunchSuppressed?.(false);
            deps.webappSystem?.setPunchPipelineActive?.(deps.maxjsFx.isPipelineRenderActive?.() === true);
            renderCurrentFrameOnce(renderTimeSeconds);
            css3dOverlay.tick(deps.scene, deps.camera);
            css3dOverlay.tickBehind(deps.webappSystem?.getBehindScene?.(), deps.camera);
        }

        async function sendCss3dMaskPng(msg = null) {
            const { width, height } = css3dMaskOutputSize(msg);
            const quads = collectCss3dMaskQuads(width, height);
            const out = document.createElement('canvas');
            out.width = width;
            out.height = height;
            const outCtx = out.getContext('2d', { willReadFrequently: true });
            outCtx.fillStyle = '#000';
            outCtx.fillRect(0, 0, width, height);

            const behind = quads.filter(q => q.behind);
            const front = quads.filter(q => !q.behind);
            if (behind.length > 0) {
                const behindCanvas = document.createElement('canvas');
                behindCanvas.width = width;
                behindCanvas.height = height;
                const behindCtx = behindCanvas.getContext('2d', { willReadFrequently: true });
                behindCtx.fillStyle = '#fff';
                for (const q of behind) drawCss3dMaskQuad(behindCtx, q.points);

                const sceneAlphaCanvas = document.createElement('canvas');
                sceneAlphaCanvas.width = width;
                sceneAlphaCanvas.height = height;
                const sceneAlphaCtx = sceneAlphaCanvas.getContext('2d', { willReadFrequently: true });
                sceneAlphaCtx.drawImage(deps.renderer.domElement, 0, 0, width, height);

                const behindData = behindCtx.getImageData(0, 0, width, height);
                const alphaData = sceneAlphaCtx.getImageData(0, 0, width, height);
                const outData = outCtx.getImageData(0, 0, width, height);
                for (let i = 0; i < outData.data.length; i += 4) {
                    if (behindData.data[i + 3] === 0) continue;
                    const visible = 255 - alphaData.data[i + 3];
                    if (visible <= 0) continue;
                    outData.data[i + 0] = visible;
                    outData.data[i + 1] = visible;
                    outData.data[i + 2] = visible;
                    outData.data[i + 3] = 255;
                }
                outCtx.putImageData(outData, 0, 0);
            }

            outCtx.fillStyle = '#fff';
            for (const q of front) drawCss3dMaskQuad(outCtx, q.points);

            const blob = await canvasToBlob(out, 'image/png');
            if (!blob) throw new Error('CSS3D mask export failed');
            const dataUrl = await readBlobAsDataUrl(blob);
            const comma = dataUrl.indexOf(',');
            if (comma < 0) throw new Error('CSS3D mask payload missing data URL header');
            deps.bridge.send('render_css3d_mask_ready', {
                imageBase64: dataUrl.slice(comma + 1),
                mime: 'image/png',
                width,
                height,
            });
        }

        function renderCurrentFrameOnce(renderTimeSeconds = null) {
            if (!deps.xrRuntime.active) deps.controls.update();
            if (!deps.xrRuntime.active && !deps.physicalCameraDofActive) {
                deps.maxjsFx.updateDofFocusFromCamera(deps.camera.position.distanceTo(deps.controls.target));
            }
            deps.syncPathTracingDofFromPostFx();
            if (deps.defaultLights.visible) {
                deps.defaultKey.position.copy(deps.getActiveCameraWorldPosition(deps.cameraPositionWorld));
            }
            deps.updateVolumeUniforms();
            const effectiveElapsed = Number.isFinite(renderTimeSeconds)
                ? renderTimeSeconds
                : deps.inlineClock.getElapsed();
            deps.layerManager.update(0, effectiveElapsed);
            if (Number.isFinite(renderTimeSeconds)) {
                deps.animationSystem?.seekAllClips?.(renderTimeSeconds);
                deps.gltfSystem?.setTime?.(renderTimeSeconds);
            } else {
                deps.animationSystem?.update(0);
            }

            try {
                if ((deps.isPathTracingViewActive() || deps.renderToImageForcePathTracing) && (!deps.renderToImageActive || deps.renderToImageForcePathTracing)) {
                    deps.renderPathTracingLiveFrame();
                } else if (deps.webglBasicFx.isAvailable?.() || deps.maxjsFx.hasEnabledEffects()) {
                    deps.renderViewerFrame();
                } else {
                    deps.renderer.render(deps.scene, deps.camera);
                }
            } catch (error) {
                deps.reportBridgeError('runtime error', error);
            }
            if (deps.splatsSystem.overlay && deps.splatsSystem.count > 0) {
                deps.updateSplatCamera();
                deps.splatsSystem.overlay.renderer.render(deps.splatsSystem.overlay.scene, deps.splatsSystem.overlay.camera);
            }
        }

        function beginRenderImageFrame(msg, responseType) {
            const w = msg.width || innerWidth;
            const h = msg.height || innerHeight;
            const frameNumber = Number.isFinite(msg.frame) ? msg.frame : 0;
            const fps = Number.isFinite(msg.fps) && msg.fps > 0 ? msg.fps : 30;
            const warmupMs = Number.isFinite(msg.warmupMs) ? Math.max(0, msg.warmupMs) : 250;
            const isSequenceFrame = responseType === 'render_sequence_frame_file';
            const captureMime = typeof msg.mime === 'string' && msg.mime ? msg.mime : 'image/png';
            // Composited capture: C++ grabs the WebView composite (CapturePreview)
            // so CSS3D web panels appear in the output. DOM panel roots stay
            // visible, punch stays active, and JS skips the canvas readback.
            const compositedCapture = msg.composited === true;
            deps.renderCaptureComposited = compositedCapture;
            const wantsAlpha = !compositedCapture && msg.alpha === true && mimeSupportsAlpha(captureMime);
            const usePathTracing = deps.isPathTracingViewActive();
            const ptMinSamples = Number.isFinite(msg.pathTracingSamples)
                ? Math.max(1, Math.floor(msg.pathTracingSamples))
                : Math.max(deps.PATH_TRACING_CAPTURE_DEFAULT_SAMPLES, deps.pathTracingSettings.samplesPerFrame);
            const wasAlreadyActive = deps.renderToImageActive === true;
            deps.renderToImageActive = true;
            deps.pendingRenderToImage = {
                observedSyncSerial: deps.latestAppliedSyncSerial,
                renderTimeSeconds: frameNumber / fps,
                width: w,
                height: h,
                warmupMs,
                responseType,
                mime: captureMime,
                alpha: wantsAlpha,
                composited: compositedCapture,
                pathTracing: usePathTracing,
                pathTracingMinSamples: usePathTracing ? ptMinSamples : 1,
                startedAtMs: performance.now(),
                textureWaitStartedAt: 0,
                textureWaitMs: usePathTracing ? deps.PATH_TRACING_TEXTURE_WAIT_MS : 0,
                pathTracingStarted: false,
                syncDeadlineMs: performance.now() + (
                    usePathTracing
                        ? Math.max(30000, Math.min(600000, ptMinSamples * 1000))
                        : 10000
                ),
            };

            // Hide all UI — keep only canvas elements visible. Composited
            // capture also keeps the CSS3D panel roots: those pixels ARE the
            // content being rendered.
            if (!wasAlreadyActive) {
                for (const el of document.body.children) {
                    if (el.tagName === 'CANVAS' || el.tagName === 'SCRIPT') continue;
                    if (compositedCapture && (el.id === 'maxjs-css3d-root' || el.id === 'maxjs-css3d-behind-root')) continue;
                    el._rtiPrevDisplay = el.style.display;
                    el.style.display = 'none';
                }
                const captureBackdropColor = !wantsAlpha && deps.envVisible && !deps.getEnvironmentBackgroundMap()
                    ? `#${deps.hiddenBackgroundColor.toString(16).padStart(6, '0')}`
                    : 'transparent';
                // Composited capture is WYSIWYG — keep the live viewport
                // background instead of the capture backdrop override.
                if (!compositedCapture) document.body.style.background = captureBackdropColor;

                // Save and bypass all performance throttling
                savedPerformanceSettings = { ...deps.performanceSettings };
                deps.performanceSettings.renderScale = 1.0;
                deps.performanceSettings.postFxScale = 1.0;
                deps.performanceSettings.fpsCap = 0;

                savedRenderToImageState = {
                    envVisible: deps.envVisible,
                    localHdriShowBg: deps.localHdriShowBg,
                    playbackState: deps.animationSystem?.capturePlaybackState?.() ?? null,
                    rendererClearColor: (() => {
                        const color = new THREE.Color();
                        try { deps.renderer.getClearColor?.(color); } catch {}
                        return color;
                    })(),
                    rendererClearAlpha: typeof deps.renderer.getClearAlpha === 'function'
                        ? deps.renderer.getClearAlpha()
                        : null,
                };
            }

            try {
                deps.renderer.setClearColor?.(
                    wantsAlpha ? 0x000000 : deps.hiddenBackgroundColor,
                    0
                );
            } catch {}

            // Single background decision shared by both paths (legacy + orchestrator):
            // gated only on wantsAlpha, never on which path triggered the render.
            if (wantsAlpha) {
                // Transparent matte — no background fill.
                deps.envVisible = false;
                deps.localHdriShowBg = false;
                deps.maxjsFx.setEnvironmentVisible(false);
                deps.scene.background = null;
            } else {
                // Opaque output still renders the scene against alpha. File
                // formats without alpha may matte later, but Bloom never sees
                // the viewport background as source pixels.
                deps.maxjsFx.setEnvironmentVisible(deps.envVisible);
                if (deps.isLocalHdriActive()) {
                    deps.localHdriShowBg = deps.envVisible;
                    deps.applyLocalHDRIToScene();
                } else {
                    deps.scene.background = deps.envVisible && deps.scene.environment
                        ? deps.scene.environment
                        : null;
                }
            }
            if (deps.pendingRenderToImage.pathTracing) {
                deps.resetPathTracingStartupWarmup();
                deps.pathTracingFx.setCaptureMode?.(true);
                deps.pathTracingFx.markSceneDirty?.();
            } else {
                deps.pathTracingFx.setCaptureMode?.(false);
            }

            if (frameNumber >= 0) {
                deps.animationSystem?.seekAllClips?.(frameNumber / fps);
            }

            // Set renderer to exact requested resolution, pixel ratio 1:1
            deps.renderer.setPixelRatio(1);
            deps.renderer.setSize(w, h);
            const captureRect = { x: 0, y: 0, width: w, height: h, aspect: w / h };
            deps.applyFrameElementStyle(deps.renderer.domElement, captureRect);
            if (deps.camera.isPerspectiveCamera) {
                deps.camera.aspect = w / h;
            } else {
                const viewWidth = Math.max(0.001, deps.camera.right - deps.camera.left);
                const aspect = w / h;
                deps.camera.left = -viewWidth / 2;
                deps.camera.right = viewWidth / 2;
                deps.camera.top = viewWidth / (2 * aspect);
                deps.camera.bottom = -viewWidth / (2 * aspect);
            }
            deps.camera.updateProjectionMatrix();
            deps.maxjsFx.resize();
            deps.webglBasicFx.resize?.();
            if (deps.splatsSystem.overlay?.renderer) {
                deps.splatsSystem.overlay.renderer.setPixelRatio(1);
                deps.splatsSystem.overlay.renderer.setSize(w, h, false);
                deps.applyFrameElementStyle(deps.splatsSystem.overlay.renderer.domElement, captureRect);
            }
            css3dOverlay.setSize(w, h);
            css3dOverlay.setViewportRect(captureRect);

            try {
                // Wait for the fresh synced frame to land; renderFrame will perform the one-shot render.
            } catch (error) {
                console.warn(`[max.js ${isSequenceFrame ? 'render_sequence_frame' : 'render_to_image'}] render failed`, error);
                if (responseType === 'render_to_image_ready') {
                    deps.bridge.send('render_to_image_ready');
                } else {
                    deps.bridge.send(responseType, { error: error?.message || String(error) });
                }
            }
        }

        function finishRenderImageFrame() {
            deps.renderToImageActive = false;
            deps.pendingRenderToImage = null;
            deps.renderToImageForcePathTracing = false;
            deps.renderCaptureComposited = false;
            deps.pathTracingFx.setCaptureMode?.(false);

            // Restore all UI elements
            for (const el of document.body.children) {
                if ('_rtiPrevDisplay' in el) {
                    el.style.display = el._rtiPrevDisplay;
                    delete el._rtiPrevDisplay;
                }
            }
            document.body.style.background = '';

            // Restore performance settings and viewport size
            if (savedPerformanceSettings) {
                Object.assign(deps.performanceSettings, savedPerformanceSettings);
                savedPerformanceSettings = null;
            }
            if (savedRenderToImageState) {
                deps.envVisible = savedRenderToImageState.envVisible;
                deps.localHdriShowBg = savedRenderToImageState.localHdriShowBg;
                deps.animationSystem?.restorePlaybackState?.(savedRenderToImageState.playbackState);
                try {
                    if (savedRenderToImageState.rendererClearColor) {
                        deps.renderer.setClearColor?.(
                            savedRenderToImageState.rendererClearColor,
                            savedRenderToImageState.rendererClearAlpha ?? 1
                        );
                    } else if (typeof deps.renderer.setClearAlpha === 'function' &&
                               Number.isFinite(savedRenderToImageState.rendererClearAlpha)) {
                        deps.renderer.setClearAlpha(savedRenderToImageState.rendererClearAlpha);
                    }
                } catch {}
                savedRenderToImageState = null;
                deps.syncEnvButtonUi();
                if (deps.isLocalHdriActive()) {
                    deps.applyLocalHDRIToScene();
                } else {
                    deps.syncEnvironmentDisplay();
                }
            }
            deps.applyRendererPerformanceSettings({ resizePostFx: true });
        }

        deps.bridge.on('render_to_image', msg => beginRenderImageFrame(msg, 'render_to_image_ready'));
        deps.bridge.on('render_to_image_done', finishRenderImageFrame);
        deps.bridge.on('render_sequence_frame', msg => beginRenderImageFrame(msg, 'render_sequence_frame_file'));
        deps.bridge.on('render_sequence_done', finishRenderImageFrame);
        deps.bridge.on('render_css3d_mask_begin', msg => {
            cleanupCss3dMaskDomLeaks();
            renderCss3dMaskFrame(msg);
            requestAnimationFrame(() => {
                renderCss3dMaskFrame(msg);
                requestAnimationFrame(() => {
                    renderCss3dMaskFrame(msg);
                    sendCss3dMaskPng(msg).catch(error => {
                        deps.bridge.send('render_css3d_mask_ready', {
                            error: error?.message || String(error),
                        });
                    });
                });
            });
        });
        deps.bridge.on('render_css3d_mask_end', cleanupCss3dMaskDomLeaks);


        return {
            sendCurrentCanvasRenderFile,
            cleanupCss3dMaskDomLeaks,
            renderCss3dMaskFrame,
            sendCss3dMaskPng,
            renderCurrentFrameOnce,
            beginRenderImageFrame,
            finishRenderImageFrame,
        };
}

export { createRenderCapture };
