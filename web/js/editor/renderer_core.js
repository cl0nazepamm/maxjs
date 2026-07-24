// renderer_core.js - editor renderer creation, viewport frame layout, and backend switching.
import * as THREE from 'three';
import * as THREE_STD from 'three-std';

function createRendererCore(deps = {}) {
        function getViewportFrameRect() {
            const fullWidth = Math.max(1, innerWidth || 1);
            const fullHeight = Math.max(1, innerHeight || 1);
            const aspect = deps.safeFrameEnabled ? deps.getRenderOutputAspect() : null;
            if (!aspect) return { x: 0, y: 0, width: fullWidth, height: fullHeight, aspect: fullWidth / fullHeight };

            const viewportAspect = fullWidth / fullHeight;
            let width = fullWidth;
            let height = fullHeight;
            if (viewportAspect > aspect) {
                width = Math.max(1, Math.round(fullHeight * aspect));
            } else {
                height = Math.max(1, Math.round(fullWidth / aspect));
            }
            return {
                x: Math.round((fullWidth - width) * 0.5),
                y: Math.round((fullHeight - height) * 0.5),
                width,
                height,
                aspect: width / height,
            };
        }

        function applyFrameElementStyle(el, rect = getViewportFrameRect()) {
            if (!el?.style) return;
            el.style.position = 'absolute';
            el.style.inset = 'auto';
            el.style.left = `${rect.x}px`;
            el.style.top = `${rect.y}px`;
            el.style.width = `${rect.width}px`;
            el.style.height = `${rect.height}px`;
        }

        function syncSafeFrameButtonUi() {
            const button = document.getElementById('btnSafeFrame');
            const label = document.getElementById('safeFrameLabel');
            if (!button) return;
            const aspect = deps.getRenderOutputAspect();
            const sizeLabel = aspect && deps.renderOutputSettings.width > 0 && deps.renderOutputSettings.height > 0
                ? `${deps.renderOutputSettings.width}x${deps.renderOutputSettings.height}`
                : 'render output';
            button.classList.toggle('active', deps.safeFrameEnabled);
            button.setAttribute('aria-pressed', deps.safeFrameEnabled ? 'true' : 'false');
            button.title = deps.safeFrameEnabled
                ? `Safe Frame on - cropped to ${sizeLabel}`
                : `Safe Frame off - click to crop viewport to ${sizeLabel}`;
            button.setAttribute('aria-label', deps.safeFrameEnabled ? 'Safe Frame on' : 'Safe Frame off');
            if (label) label.textContent = aspect ? `Safe Frame ${sizeLabel}` : 'Safe Frame';
        }

        function updateCameraProjectionForViewportRect() {
            const rect = getViewportFrameRect();
            const aspect = rect.aspect || 1;
            if (deps.camera?.isPerspectiveCamera) {
                deps.camera.aspect = aspect;
            } else if (deps.camera?.isOrthographicCamera) {
                const viewWidth = Math.max(0.001, deps.camera.right - deps.camera.left);
                deps.camera.left = -viewWidth / 2;
                deps.camera.right = viewWidth / 2;
                deps.camera.top = viewWidth / (2 * aspect);
                deps.camera.bottom = -viewWidth / (2 * aspect);
            }
            deps.camera?.updateProjectionMatrix?.();
            return rect;
        }

        function applyRenderViewportLayout({ resizeBuffers = false, resizePostFx = false } = {}) {
            const rect = updateCameraProjectionForViewportRect();
            if (deps.renderer) {
                if (resizeBuffers) deps.renderer.setSize(rect.width, rect.height);
                applyFrameElementStyle(deps.renderer.domElement, rect);
            }
            if (deps.asciiEffect?.domElement) {
                deps.asciiEffect.setSize(rect.width, rect.height);
                applyFrameElementStyle(deps.asciiEffect.domElement, rect);
            }
            if (deps.blobOverlayCvs) {
                if (deps.blobOverlayCvs.width !== rect.width) deps.blobOverlayCvs.width = rect.width;
                if (deps.blobOverlayCvs.height !== rect.height) deps.blobOverlayCvs.height = rect.height;
                applyFrameElementStyle(deps.blobOverlayCvs, rect);
            }
            deps.compositionOverlay?.resize(rect);
            deps.css3dOverlay.setSize(rect.width, rect.height);
            deps.css3dOverlay.setViewportRect(rect);
            if (resizePostFx) {
                deps.maxjsFx.resize();
                deps.webglBasicFx.resize?.();
            }
            syncSafeFrameButtonUi();
            return rect;
        }

        function getEffectivePixelRatio() {
            const scale = Number.isFinite(deps.performanceSettings.renderScale) ? deps.performanceSettings.renderScale : 1.0;
            return Math.max(0.25, devicePixelRatio * scale);
        }

        function getEffectivePostFxResolutionScale() {
            const scale = Number.isFinite(deps.performanceSettings.postFxScale) ? deps.performanceSettings.postFxScale : 1.0;
            return Math.max(0.25, Math.min(1.0, scale));
        }

        function applyRendererPerformanceSettings({ resizePostFx = false } = {}) {
            const rect = getViewportFrameRect();
            if (deps.renderer) {
                deps.renderer.setPixelRatio(getEffectivePixelRatio());
                deps.renderer.setSize(rect.width, rect.height);
                applyFrameElementStyle(deps.renderer.domElement, rect);
            }
            if (deps.blobOverlayCvs) {
                if (deps.blobOverlayCvs.width !== rect.width) deps.blobOverlayCvs.width = rect.width;
                if (deps.blobOverlayCvs.height !== rect.height) deps.blobOverlayCvs.height = rect.height;
                applyFrameElementStyle(deps.blobOverlayCvs, rect);
            }
            deps.lastRenderTimestamp = 0;
            deps.maxjsFx.setResolutionScale?.(getEffectivePostFxResolutionScale());
            deps.webglBasicFx.setResolutionScale?.(getEffectivePostFxResolutionScale());
            updateCameraProjectionForViewportRect();
            deps.css3dOverlay.setSize(rect.width, rect.height);
            deps.css3dOverlay.setViewportRect(rect);
            if (resizePostFx) {
                deps.maxjsFx.resize();
                deps.webglBasicFx.resize?.();
            }
        }

        function configureRenderer(nextRenderer) {
            const rect = getViewportFrameRect();
            nextRenderer.setSize(rect.width, rect.height);
            nextRenderer.setPixelRatio(getEffectivePixelRatio());
            nextRenderer.toneMapping = THREE.NeutralToneMapping;
            nextRenderer.toneMappingExposure = 1.0;
            nextRenderer.shadowMap.enabled = true;
            nextRenderer.setClearColor?.(0x000000, 0);
            applyFrameElementStyle(nextRenderer.domElement, rect);
            nextRenderer.domElement.style.zIndex = '0';
            document.body.appendChild(nextRenderer.domElement);
        }

        async function initializeRenderer(nextRenderer) {
            if (typeof nextRenderer.init === 'function') {
                await nextRenderer.init();
            }
        }

        function disposeRenderer(nextRenderer) {
            nextRenderer?.domElement?.remove?.();
            nextRenderer?.dispose?.();
        }

        const RENDERER_BACKEND_STORAGE_KEY = 'maxjs_renderer_backend_preference';

        function normalizeRendererBackend(value) {
            if (value === 'webgl-vr' || value === 'webgl-xr' || value === 'webgl-headset') return 'webgl2';
            if (value === 'webgl') return 'webgl2';
            return value === 'webgl2' || value === 'webgpu' || value === 'webgl-fallback' ? value : '';
        }

        function persistRendererBackendPreference(mode) {
            const normalized = normalizeRendererBackend(mode);
            if (normalized === 'webgl2' || normalized === 'webgl-fallback' || normalized === 'webgpu') {
                try { localStorage.setItem(RENDERER_BACKEND_STORAGE_KEY, normalized); } catch {}
            }
        }

        function consumeRequestedRendererBackend() {
            if (deps.isProductionRenderPage) return 'webgl-fallback';
            const explicit = sessionStorage.getItem('maxjs_renderer_backend');
            if (explicit) {
                sessionStorage.removeItem('maxjs_renderer_backend');
                return normalizeRendererBackend(explicit);
            }
            const forceFallback = sessionStorage.getItem('maxjs_force_webgl') === '1';
            if (forceFallback) {
                sessionStorage.removeItem('maxjs_force_webgl');
                return 'webgl-fallback';
            }
            try {
                return normalizeRendererBackend(localStorage.getItem(RENDERER_BACKEND_STORAGE_KEY));
            } catch {}
            return '';
        }

        async function createRenderer() {
            const requestedBackend = consumeRequestedRendererBackend();

            let nextRenderer;
            let backendLabel;
            // GPU device loss was invisible before 2026-07-23: no handler
            // existed, so a TDR / driver reset / OOM device kill left a black
            // canvas or a silently restarted panel with nothing to attribute.
            // Record every non-intentional loss where it survives the page:
            // localStorage (read back on next boot) + the host failure log.
            const DEVICE_LOSS_LOG_KEY = 'maxjs_device_loss_log';
            const watchGpuDeviceLoss = (renderer, label) => {
                const device = renderer?.backend?.device;
                if (!device?.lost?.then) return;
                device.lost.then((info) => {
                    if (info?.reason === 'destroyed') return; // intentional dispose
                    const entry = {
                        when: new Date().toISOString(),
                        backend: label,
                        reason: info?.reason ?? 'unknown',
                        message: String(info?.message || ''),
                    };
                    console.error('[max.js] WebGPU device LOST:', entry);
                    try {
                        const prior = JSON.parse(localStorage.getItem(DEVICE_LOSS_LOG_KEY) || '[]');
                        const entries = Array.isArray(prior) ? prior : [];
                        entries.push(entry);
                        localStorage.setItem(DEVICE_LOSS_LOG_KEY, JSON.stringify(entries.slice(-10)));
                    } catch {}
                    try {
                        window.chrome?.webview?.postMessage({ type: 'client_log', kind: 'gpu_device_lost', ...entry });
                    } catch {}
                }).catch(() => {});
            };
            try {
                const prior = JSON.parse(localStorage.getItem(DEVICE_LOSS_LOG_KEY) || '[]');
                if (Array.isArray(prior) && prior.length) {
                    console.warn('[max.js] GPU device losses recorded by earlier sessions '
                        + '(localStorage maxjs_device_loss_log):', prior);
                }
            } catch {}

            // WebGPU devices come up at spec-MINIMUM limits unless asked
            // otherwise — 16 sampled textures per shader stage is one
            // shadow-casting light away from overflowing a scene material's
            // bind group once shadow maps and the HALO-GI probe atlases fold
            // in (2026-07-24: "add one light and the floor vanishes" —
            // BindGroupLayout creation failed, every mesh on that material
            // stopped rendering). Mirror the adapter's real limits into the
            // device request so the hardware ceiling, not the spec floor, is
            // the budget. Probe with the SAME adapter options three's
            // WebGPUBackend uses (featureLevel 'compatibility') so the
            // mirrored values are valid for the adapter it will pick.
            async function resolveWebGPULimits() {
                try {
                    const adapter = await navigator.gpu?.requestAdapter?.({ featureLevel: 'compatibility' });
                    if (!adapter?.limits) return undefined;
                    const MIRROR = [
                        'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D',
                        'maxTextureArrayLayers', 'maxBindGroups', 'maxBindingsPerBindGroup',
                        'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout',
                        'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage',
                        'maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage',
                        'maxUniformBuffersPerShaderStage', 'maxUniformBufferBindingSize',
                        'maxStorageBufferBindingSize', 'maxVertexBuffers', 'maxBufferSize',
                        'maxVertexAttributes', 'maxVertexBufferArrayStride', 'maxInterStageShaderVariables',
                        'maxColorAttachments', 'maxColorAttachmentBytesPerSample',
                        'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
                        'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
                        'maxComputeWorkgroupsPerDimension',
                    ];
                    const requiredLimits = {};
                    for (const key of MIRROR) {
                        const value = adapter.limits[key];
                        if (typeof value === 'number' && Number.isFinite(value)) requiredLimits[key] = value;
                    }
                    return Object.keys(requiredLimits).length ? requiredLimits : undefined;
                } catch (_) {
                    return undefined;
                }
            }

            // The WebGPU spectral path tracer requires the NATIVE WebGPU
            // backend (backend.isWebGPUBackend). Ignore any forced-WebGL
            // preference while in pathtracing mode so PT always lands on the
            // native WebGPU renderer below.
            if (requestedBackend === 'webgl2' && !deps.isPathTracingMode) {
                nextRenderer = new THREE_STD.WebGLRenderer({
                    antialias: true,
                    alpha: true,
                    preserveDrawingBuffer: deps.shouldPreserveCanvasForCapture,
                    powerPreference: 'high-performance',
                });
                backendLabel = 'WebGL Mode';
                configureRenderer(nextRenderer);
                await initializeRenderer(nextRenderer);
            } else if (requestedBackend === 'webgl-fallback' && !deps.isPathTracingMode) {
                // Normal viewer WebGL2 uses the modern renderer stack so TSL /
                // Shader Lab can compile to the forced WebGL backend.
                nextRenderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true, preserveDrawingBuffer: deps.shouldPreserveCanvasForCapture });
                backendLabel = 'TSL_GL';
                configureRenderer(nextRenderer);
                await initializeRenderer(nextRenderer);
            } else {
                const requiredLimits = await resolveWebGPULimits();
                nextRenderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, preserveDrawingBuffer: deps.shouldPreserveCanvasForCapture, requiredLimits });
                backendLabel = 'WebGPU';
                try {
                    configureRenderer(nextRenderer);
                    await initializeRenderer(nextRenderer);
                } catch (error) {
                    // Adapter-limit mirroring can theoretically over-ask (e.g.
                    // adapter races between probe and init) — retry the stock
                    // native device before surrendering to WebGL.
                    console.warn('max.js WebGPU init failed, retrying with default limits.', error);
                    disposeRenderer(nextRenderer);
                    try {
                        nextRenderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, preserveDrawingBuffer: deps.shouldPreserveCanvasForCapture });
                        configureRenderer(nextRenderer);
                        await initializeRenderer(nextRenderer);
                    } catch (error2) {
                        console.warn('max.js WebGPU init failed, retrying with forced WebGL2 backend.', error2);
                        disposeRenderer(nextRenderer);
                        nextRenderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true, preserveDrawingBuffer: deps.shouldPreserveCanvasForCapture });
                        backendLabel = 'TSL_GL';
                        configureRenderer(nextRenderer);
                        await initializeRenderer(nextRenderer);
                    }
                }
            }

            deps.renderer = nextRenderer;
            deps.rendererBackendLabel = backendLabel;
            watchGpuDeviceLoss(nextRenderer, backendLabel);
            return { renderer: nextRenderer, backendLabel };
        }

        const btnRenderer = document.getElementById('btnRenderer');
        const rendererPipelineSwitch = document.getElementById('rendererPipelineSwitch');
        const btnForceWebGL = document.getElementById('btnForceWebGL');
        const forceWebGLRow = document.getElementById('forceWebGLRow');
        const RENDERER_PIPELINE_LABELS = {
            webgl2: 'WebGL Mode',
            webgpu: 'WebGPU Mode',
            'webgl-fallback': 'WebGPU Mode (Force WebGL)',
        };
        const RENDERER_PIPELINE_BADGES = {
            webgl2: 'WebGL',
            webgpu: 'WGPU',
            'webgl-fallback': 'WGPU',
        };
        const WEBGL_PIPELINE_CONFIRM_MESSAGE =
            'This is the simple WebGL pipeline. It is snapshot friendly, supported by every browser and has superior light probing. But you will lose rendering modes, TSL materials and the max.js post processing stack.';
        function isWgl2FallbackBackendActive() {
            const label = String(deps.rendererBackendLabel || '');
            return label === 'TSL_GL' || label === 'WGL2 Fallback';
        }
        function isWgl2BackendActive() {
            const label = String(deps.rendererBackendLabel || '');
            return deps.renderer?.isWebGLRenderer === true
                && (label === 'WebGL Mode' || label === 'WebGL (Pathtracing)');
        }
        function isSimpleWebGLPipelineActive() {
            return isWgl2BackendActive() && !deps.isPathTracingMode;
        }
        function isWebGLPipelineActive() {
            return isWgl2BackendActive();
        }
        function getRendererPipelineMode() {
            if (isWgl2BackendActive()) return 'webgl2';
            if (isWgl2FallbackBackendActive()) return 'webgl-fallback';
            if (String(deps.rendererBackendLabel || '') === 'WebGPU') return 'webgpu';
            return 'webgl-fallback';
        }
        function syncRendererButtonUi() {
            const pipelineMode = getRendererPipelineMode();
            const pipelineLabel = RENDERER_PIPELINE_LABELS[pipelineMode] || pipelineMode;
            if (btnRenderer) {
                deps.setRailButtonMeta(btnRenderer, { badge: RENDERER_PIPELINE_BADGES[pipelineMode] || 'WGPU' });
                btnRenderer.classList.toggle('active', pipelineMode !== 'webgpu');
                btnRenderer.title = `Renderer pipeline: ${pipelineLabel}`;
            }
            if (rendererPipelineSwitch) {
                rendererPipelineSwitch.querySelectorAll('[data-renderer-pipeline]').forEach(button => {
                    const mode = normalizeRendererBackend(button.dataset.rendererPipeline);
                    const active = mode === pipelineMode
                        || (mode === 'webgpu' && pipelineMode === 'webgl-fallback');
                    button.classList.toggle('active', active);
                    button.setAttribute('aria-pressed', active ? 'true' : 'false');
                    button.title = mode === 'webgpu' && pipelineMode === 'webgl-fallback'
                        ? 'WebGPU pipeline active with Force WebGL enabled'
                        : `${RENDERER_PIPELINE_LABELS[mode] || mode} pipeline${active ? ' active' : ''}`;
                });
            }
            const forceWebGLActive = pipelineMode === 'webgl-fallback';
            deps.setViewportMenuItemHidden(forceWebGLRow, pipelineMode === 'webgl2');
            if (btnForceWebGL) {
                btnForceWebGL.classList.toggle('active', forceWebGLActive);
                btnForceWebGL.setAttribute('aria-pressed', forceWebGLActive ? 'true' : 'false');
                btnForceWebGL.title = forceWebGLActive
                    ? 'Force WebGL is active. Click to restart in native WebGPU.'
                    : 'Restart WebGPU mode using the forced WebGL backend.';
            }
        }
        function restartWithRendererBackend(mode, options = {}) {
            const normalizedMode = normalizeRendererBackend(mode) || 'webgpu';
            if (normalizedMode === 'webgl2' && deps.hasActiveLightLinks?.()) {
                alert('Light Linking is active. Set every linked light to None before switching to the simple WebGL pipeline.');
                return false;
            }
            const reason = options.reason || 'manual';
            const label = RENDERER_PIPELINE_LABELS[normalizedMode] || normalizedMode;
            const confirmMessage = options.confirmMessage
                || `Restart max.js with ${label} pipeline now?`;
            if (options.prompt === false || confirm(confirmMessage)) {
                persistRendererBackendPreference(normalizedMode);
                // Pathtracing now runs on WebGPU; only the WebGL2 backend (which
                // can't host the spectral tracer) drops back to standard mode.
                if (normalizedMode === 'webgl2') {
                    try { localStorage.setItem(deps.MAXJS_MODE_KEY, 'standard'); } catch {}
                }
                sessionStorage.setItem('maxjs_renderer_backend', normalizedMode);
                location.reload();
                return true;
            }
            return false;
        }
        function getNextRendererPipelineMode() {
            const order = ['webgl2', 'webgpu', 'webgl-fallback'];
            const current = getRendererPipelineMode();
            const index = order.indexOf(current);
            return order[(index + 1) % order.length] || 'webgl-fallback';
        }
        btnRenderer?.addEventListener('click', () => {
            const nextMode = getNextRendererPipelineMode();
            restartWithRendererBackend(nextMode, {
                reason: 'manual',
                confirmMessage: nextMode === 'webgl2'
                    ? WEBGL_PIPELINE_CONFIRM_MESSAGE
                    : `Restart max.js with ${RENDERER_PIPELINE_LABELS[nextMode]} pipeline now?`,
            });
        });
        if (rendererPipelineSwitch) {
            rendererPipelineSwitch.querySelectorAll('[data-renderer-pipeline]').forEach(button => {
                const mode = normalizeRendererBackend(button.dataset.rendererPipeline);
                button.addEventListener('click', () => {
                    if (!mode || mode === getRendererPipelineMode()) return;
                    restartWithRendererBackend(mode, {
                        reason: mode === 'webgl-fallback' ? 'fallback' : 'manual',
                        confirmMessage: mode === 'webgl2'
                            ? WEBGL_PIPELINE_CONFIRM_MESSAGE
                            : mode === 'webgl-fallback'
                            ? 'Force WebGL runs the WebGPU renderer stack through WebGL and reloads the panel.\n\nUse this when native WebGPU is not usable.\n\nEnable Force WebGL now?'
                            : `Restart max.js with ${RENDERER_PIPELINE_LABELS[mode]} pipeline now?`,
                    });
                });
            });
        }
        btnForceWebGL?.addEventListener('click', () => {
            const forceWebGLActive = getRendererPipelineMode() === 'webgl-fallback';
            restartWithRendererBackend(forceWebGLActive ? 'webgpu' : 'webgl-fallback', {
                reason: forceWebGLActive ? 'manual' : 'fallback',
                confirmMessage: forceWebGLActive
                    ? 'Disable Force WebGL and restart with native WebGPU now?'
                    : 'Force WebGL runs the WebGPU renderer stack through WebGL and reloads the panel.\n\nUse this when native WebGPU is not usable.\n\nEnable Force WebGL now?',
            });
        });

        return {
            getViewportFrameRect,
            applyFrameElementStyle,
            syncSafeFrameButtonUi,
            updateCameraProjectionForViewportRect,
            applyRenderViewportLayout,
            getEffectivePixelRatio,
            getEffectivePostFxResolutionScale,
            applyRendererPerformanceSettings,
            configureRenderer,
            initializeRenderer,
            disposeRenderer,
            normalizeRendererBackend,
            persistRendererBackendPreference,
            consumeRequestedRendererBackend,
            createRenderer,
            isWgl2FallbackBackendActive,
            isWgl2BackendActive,
            isSimpleWebGLPipelineActive,
            isWebGLPipelineActive,
            getRendererPipelineMode,
            syncRendererButtonUi,
            restartWithRendererBackend,
            getNextRendererPipelineMode,
        };
}

export { createRendererCore };
