        import * as THREE from 'three';
        import * as THREE_STD from 'three-std';
        import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
        import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
        import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
        import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
        import { createWebXRRuntime } from './webxr.js';
        import { Inspector } from 'three/addons/inspector/Inspector.js';
        import {
            installMaxLightsRenderer,
        } from '../max_lights_node.js';
        import { createRendererCore } from './renderer_core.js';
        import { createTexturePipeline } from './texture_pipeline.js';
        import { createMaterials } from './materials.js';
        import { createBakeSystem } from './bake_system.js';
        import { createSceneSync } from './scene_sync.js';
        import { createSceneExtras } from './scene_extras.js';
        import { createCameraSystem } from './camera_system.js';
        import { createSnapshotExport } from './snapshot_export.js';
        import { createPostFxGlue } from './postfx_glue.js';
        import { createPathTracingGlue } from './pathtracing_glue.js';
        import { createRenderCapture } from './render_capture.js';
        import { createRenderLoop } from './render_loop.js';
        import { createPanelsMisc } from './panels_misc.js';
        import { createLights } from './lights.js';
        import { createEnvironment } from './environment.js';
        import { createSky } from './sky.js';
        import { createGiVolumeGlue } from './gi_volume_glue.js';
        import {
            materialEnvIntensity,
        } from 'three/tsl';
        import * as TSL from 'three/tsl';

        const maxjsHdriDiffuseIntensity = THREE.TSL.uniform(1.0);

        // Patch materialEnvIntensity so scene.environment still respects
        // per-material envMapIntensity, while scene.environmentIntensity remains
        // the global HDRI/node intensity control.
        materialEnvIntensity.onObjectUpdate(({ material, scene }) => {
            const materialIntensity = Number.isFinite(material?.envMapIntensity)
                ? material.envMapIntensity
                : 1.0;
            const sceneIntensity = Number.isFinite(scene?.environmentIntensity)
                ? scene.environmentIntensity
                : 1.0;
            return materialIntensity * sceneIntensity;
        });

        function patchEnvironmentNodeDiffuseSplit() {
            const EnvironmentNode = THREE.EnvironmentNode;
            const tsl = THREE.TSL || {};
            if (!EnvironmentNode?.prototype || EnvironmentNode.prototype.maxjsHdriDiffuseSplitPatched) return;

            const {
                isolate,
                roughness,
                clearcoatRoughness,
                cameraWorldMatrix,
                normalView,
                clearcoatNormalView,
                normalWorld,
                positionViewDirection,
                float,
                pow4,
                bentNormalView,
                pmremTexture,
            } = tsl;
            if (!isolate || !roughness || !cameraWorldMatrix || !normalView || !normalWorld || !positionViewDirection || !float || !pow4 || !pmremTexture) {
                return;
            }

            const originalSetup = EnvironmentNode.prototype.setup;
            const createRadianceContext = (roughnessNode, normalViewNode) => {
                let reflectVec = null;
                return {
                    getUV: () => {
                        if (reflectVec === null) {
                            reflectVec = positionViewDirection.negate().reflect(normalViewNode);
                            reflectVec = pow4(roughnessNode).mix(reflectVec, normalViewNode).normalize();
                            reflectVec = reflectVec.transformDirection(cameraWorldMatrix);
                        }
                        return reflectVec;
                    },
                    getTextureLevel: () => roughnessNode,
                };
            };
            const createIrradianceContext = (normalWorldNode) => ({
                getUV: () => normalWorldNode,
                getTextureLevel: () => float(1.0),
            });

            EnvironmentNode.prototype.setup = function setupMaxjsEnvironmentNode(builder) {
                try {
                    const { material } = builder;
                    let envNode = this.envNode;

                    if (envNode.isTextureNode || envNode.isMaterialReferenceNode) {
                        const value = envNode.isTextureNode ? envNode.value : material[envNode.property];
                        const cache = this._getPMREMNodeCache(builder.renderer);
                        let cacheEnvNode = cache.get(value);
                        if (cacheEnvNode === undefined) {
                            cacheEnvNode = pmremTexture(value);
                            cache.set(value, cacheEnvNode);
                        }
                        envNode = cacheEnvNode;
                    }

                    const useAnisotropy = material.useAnisotropy === true || material.anisotropy > 0;
                    const radianceNormalView = useAnisotropy ? bentNormalView : normalView;

                    const radiance = envNode.context(createRadianceContext(roughness, radianceNormalView)).mul(materialEnvIntensity);
                    const irradiance = envNode.context(createIrradianceContext(normalWorld)).mul(Math.PI).mul(materialEnvIntensity);

                    builder.context.radiance.addAssign(isolate(radiance));

                    const isNativeWebGPU = builder.renderer?.backend?.isWebGPUBackend === true;
                    const isolatedIrradiance = isolate(irradiance);
                    builder.context.iblIrradiance.addAssign(
                        isNativeWebGPU ? isolatedIrradiance.mul(maxjsHdriDiffuseIntensity) : isolatedIrradiance
                    );

                    const clearcoatRadiance = builder.context.lightingModel.clearcoatRadiance;
                    if (clearcoatRadiance && clearcoatRoughness && clearcoatNormalView) {
                        const clearcoatRadianceContext = envNode
                            .context(createRadianceContext(clearcoatRoughness, clearcoatNormalView))
                            .mul(materialEnvIntensity);
                        clearcoatRadiance.addAssign(isolate(clearcoatRadianceContext));
                    }
                } catch (error) {
                    return originalSetup.call(this, builder);
                }
            };

            Object.defineProperty(EnvironmentNode.prototype, 'maxjsHdriDiffuseSplitPatched', { value: true });
        }

        patchEnvironmentNodeDiffuseSplit();
        import { maxTimeline } from '../maxjs_timeline.js';
        import { createHostBridge } from './host_bridge.js';
        import { createEditorContext } from './context.js';
        import { createPerfHud } from '../perf_hud.js';
        import { createMaxJSFxController } from '../maxjs_fx.js';
        import { createWebGLBasicFx } from '../webgl_basicfx.js';
        import { createSpectralTracer } from 'speedball-gi/spectral-tracer';
        import { createLayerManager } from '../layer_manager.js';
        import { MAXJS_LAYER_SSR_EXCLUDE } from '../render_layers.js';
        import { createMaxJSAnimationSystem } from '../maxjs_animation.js';
        import { createMaxJSAudioSystem } from '../maxjs_audio.js';
        import { createMaxJSGLTFSystem } from '../maxjs_gltf.js';
        import { createMaxJSWebAppSystem } from '../maxjs_webapp.js';
        import { attachDomPanelForwarding } from '../dom_panel_forwarding.js';
        import { createProjectRuntime } from '../project_runtime.js';
        import * as css3dOverlay from '../css3d_overlay.js';
        import { attachHTMLClickForwarding } from '../html_texture.js';
        import { createShaderLabFx } from '../shader_lab_fx.js';
        import { createCompositionOverlay } from '../composition_overlay.js';
        import { installDockDragHide } from '../dock_drag.js';
        import {
            copyMaxArrayToWorld,
            copyMaxComponentsToWorld,
            sceneSpace,
        } from '../scene_space.js';
        import {
            getShaderLabSnapshot,
            setShaderLabSnapshot,
            onShaderLabSnapshotChange,
            updateShaderLabEnabled,
        } from '../shader_lab_panel.js';
        const THEME_STORAGE_KEY = 'maxjs-theme';
        const AUDIO_MUTED_STORAGE_KEY = 'maxjs-audio-muted';
        const BACKGROUND_COLOR_STORAGE_KEY = 'maxjs-background-color';
        const DEFAULT_BACKGROUND_COLOR = 0x353535;
        function hexColorInputValue(hex) {
            return `#${(hex >>> 0).toString(16).padStart(6, '0')}`;
        }
        function parseHexColorInput(value) {
            if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return null;
            return parseInt(value.slice(1), 16);
        }
        function readPersistedBackgroundColor() {
            try {
                const raw = localStorage.getItem(BACKGROUND_COLOR_STORAGE_KEY);
                if (raw) {
                    const value = Number(raw);
                    if (Number.isFinite(value) && value >= 0 && value <= 0xffffff) {
                        return value >>> 0;
                    }
                }
                const legacy = localStorage.getItem('maxjs-bg-colors');
                if (legacy) {
                    const parsed = JSON.parse(legacy);
                    const migrated = parsed?.custom ?? parsed?.dark ?? parsed?.light;
                    if (Number.isFinite(migrated) && migrated >= 0 && migrated <= 0xffffff) {
                        return migrated >>> 0;
                    }
                }
            } catch { /* private mode / corrupt */ }
            return DEFAULT_BACKGROUND_COLOR;
        }
        function saveBackgroundColor() {
            try {
                localStorage.setItem(BACKGROUND_COLOR_STORAGE_KEY, String(hiddenBackgroundColor));
            } catch { /* private mode */ }
        }
        function applyViewportBackdropColor(hex = null) {
            if (hex == null) {
                document.documentElement.style.setProperty('--maxjs-viewport-bg', 'transparent');
                return;
            }
            const value = Number.isFinite(hex) ? (hex >>> 0) : DEFAULT_BACKGROUND_COLOR;
            document.documentElement.style.setProperty(
                '--maxjs-viewport-bg',
                `#${value.toString(16).padStart(6, '0')}`
            );
        }
        function readPersistedLightMode() {
            try {
                return localStorage.getItem(THEME_STORAGE_KEY) === 'light';
            } catch {
                return false;
            }
        }
        function readPersistedAudioMuted() {
            try {
                return localStorage.getItem(AUDIO_MUTED_STORAGE_KEY) === 'true';
            } catch {
                return false;
            }
        }
        let lightMode = readPersistedLightMode();
        document.body.classList.toggle('light-mode', lightMode);

        // ── Scene Setup (Y-up world + Max basis boundary) ───
        let hiddenBackgroundColor = readPersistedBackgroundColor();
        applyViewportBackdropColor(null);
        const viewportBackgroundColor = new THREE.Color(hiddenBackgroundColor);
        const scene = new THREE.Scene();
        scene.background = null;
        const maxBasisRoot = new THREE.Group();
        maxBasisRoot.name = '__maxjs_max_basis_root__';
        maxBasisRoot.rotation.x = -Math.PI / 2;
        scene.add(maxBasisRoot);
        const maxRoot = new THREE.Group();
        maxRoot.name = '__maxjs_max_root__';
        maxBasisRoot.add(maxRoot);
        const jsRoot = new THREE.Group();
        jsRoot.name = '__maxjs_js_root__';
        scene.add(jsRoot);
        const overlayRoot = new THREE.Group();
        overlayRoot.name = '__maxjs_overlay_root__';
        maxBasisRoot.add(overlayRoot);

        const cameraTargetWorld = new THREE.Vector3();
        const cameraPositionWorld = new THREE.Vector3();

        const cameraDefaultPosition = copyMaxComponentsToWorld(new THREE.Vector3(), 200, -200, 150);
        const cameraDefaultDirection = cameraDefaultPosition.clone().normalize();
        function getActiveCameraWorldPosition(target = new THREE.Vector3()) {
            const activeCamera = renderer.xr?.isPresenting ? renderer.xr.getCamera(camera) : camera;
            return activeCamera.getWorldPosition(target);
        }

        const DEFAULT_CAMERA_NEAR = 1.0;
        const DEFAULT_CAMERA_FAR = 100000;
        const perspCamera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, DEFAULT_CAMERA_NEAR, DEFAULT_CAMERA_FAR);
        const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, DEFAULT_CAMERA_NEAR, DEFAULT_CAMERA_FAR);
        perspCamera.up.set(0, 1, 0);
        orthoCamera.up.set(0, 1, 0);
        perspCamera.position.copy(cameraDefaultPosition);
        perspCamera.layers.enable(MAXJS_LAYER_SSR_EXCLUDE);
        orthoCamera.layers.enable(MAXJS_LAYER_SSR_EXCLUDE);
        let camera = perspCamera;

        const PERFORMANCE_DEFAULTS = Object.freeze({
            fpsCap: 0,
            renderScale: 1.0,
            postFxScale: 1.0,
            optimizeMaxInstances: true,
            maxInstanceBucketThreshold: 50,
            // Merge static Max group members into one mesh per material.
            // Off by default: merged members lose per-node picking until the
            // cluster dissolves.
            flattenGroups: false,
        });
        let performanceSettings = { ...PERFORMANCE_DEFAULTS };
        const SAFE_FRAME_STORAGE_KEY = 'maxjs_safe_frame_enabled';
        const renderOutputSettings = { width: 0, height: 0, aspect: 0 };
        let safeFrameEnabled = false;
        let blobOverlayCvs = null;
        let blobOverlayCtx = null;
        let compositionOverlay = null;

        try {
            safeFrameEnabled = localStorage.getItem(SAFE_FRAME_STORAGE_KEY) === 'true';
        } catch {}

        function getRenderOutputAspect() {
            const width = Number(renderOutputSettings.width);
            const height = Number(renderOutputSettings.height);
            const aspect = Number(renderOutputSettings.aspect);
            if (Number.isFinite(aspect) && aspect > 0) return aspect;
            return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
                ? width / height
                : null;
        }

        // User-overridable camera clip planes. null means "use auto-fit value".
        // Raise `near` to reclaim depth precision on large scenes where distant geo z-fights.
        const cameraClip = { near: null, far: null };
        function applyCameraClipOverrides(cam) {
            if (!cam) return;
            if (Number.isFinite(cameraClip.near) && cameraClip.near > 0) cam.near = cameraClip.near;
            if (Number.isFinite(cameraClip.far) && cameraClip.far > cam.near) cam.far = cameraClip.far;
            cam.updateProjectionMatrix();
        }
        function applySyncedCameraClip(cam, source = null) {
            if (!cam || cam.isOrthographicCamera) return;
            const near = Number(source?.near);
            const far = Number(source?.far);
            if (Number.isFinite(near) && near > 0 && Number.isFinite(far) && far > near) {
                cam.near = near;
                cam.far = far;
                return;
            }
            if (!Number.isFinite(cam.near) || cam.near < DEFAULT_CAMERA_NEAR) cam.near = DEFAULT_CAMERA_NEAR;
            if (!Number.isFinite(cam.far) || cam.far <= cam.near) cam.far = DEFAULT_CAMERA_FAR;
        }
        let lastRenderTimestamp = 0;

        const MAXJS_MODE_KEY = 'maxjs-render-mode';
        // 'spectral' replaces the old 'studio' (Advanced) mode and absorbs the
        // old top-level 'pathtracing' mode: the path tracer is now a live VIEW
        // inside spectral mode (same spectral scene core as the probe GI).
        const MAXJS_RENDER_MODES = ['standard', 'spectral'];
        const isHostedWebView = !!window.chrome?.webview?.postMessage;
        const pageParams = new URLSearchParams(window.location.search);
        const isProductionRenderPage = pageParams.has('productionRender');
        const shouldPreserveCanvasForCapture = isHostedWebView || isProductionRenderPage;

        function readMaxjsRenderMode() {
            if (isProductionRenderPage) return 'standard';
            try {
                let value = localStorage.getItem(MAXJS_MODE_KEY);
                // migrate legacy tokens: Advanced ('studio') and the old
                // top-level 'pathtracing' mode both fold into 'spectral'.
                if (value === 'studio' || value === 'pathtracing') {
                    value = 'spectral';
                    try { localStorage.setItem(MAXJS_MODE_KEY, value); } catch {}
                }
                return MAXJS_RENDER_MODES.includes(value) ? value : 'standard';
            } catch {
                return 'standard';
            }
        }

        const maxjsRenderMode = readMaxjsRenderMode();
        // internal flag name kept ('studio') — it gates every advanced feature
        // and renaming hundreds of references buys nothing. UI label: Spectral.
        const isStudioMode = maxjsRenderMode === 'spectral';
        // Spectral view: 'probes' = live DDGI probe GI (default), 'trace' =
        // the spectral path tracer. Live-switchable WITHOUT reload — both run
        // on the same spectral scene core. setSpectralView() flips it.
        // Session-only by design: every viewer start begins in 'probes' (PT off)
        // so a restart never boots straight into the tracer.
        let spectralView = 'probes';
        let isPathTracingMode = false;
        document.body.classList.toggle('pathtracing-mode', isPathTracingMode);

        let renderer = null;
        let rendererBackendLabel = 'WebGPU';
        let lightLinkingRef = null;
        const rendererCore = createRendererCore({
            MAXJS_MODE_KEY,
            getRenderOutputAspect,
            setRailButtonMeta: (...args) => setRailButtonMeta(...args),
            setViewportMenuItemHidden: (...args) => setViewportMenuItemHidden(...args),
            get renderer() { return renderer; },
            set renderer(value) { renderer = value; },
            get rendererBackendLabel() { return rendererBackendLabel; },
            set rendererBackendLabel(value) { rendererBackendLabel = value; },
            get performanceSettings() { return performanceSettings; },
            get renderOutputSettings() { return renderOutputSettings; },
            get safeFrameEnabled() { return safeFrameEnabled; },
            get camera() { return camera; },
            get asciiEffect() { return asciiEffect; },
            get blobOverlayCvs() { return blobOverlayCvs; },
            get compositionOverlay() { return compositionOverlay; },
            get css3dOverlay() { return css3dOverlay; },
            get maxjsFx() { return maxjsFx; },
            get webglBasicFx() { return webglBasicFx; },
            get lastRenderTimestamp() { return lastRenderTimestamp; },
            set lastRenderTimestamp(value) { lastRenderTimestamp = value; },
            get isProductionRenderPage() { return isProductionRenderPage; },
            get shouldPreserveCanvasForCapture() { return shouldPreserveCanvasForCapture; },
            get isPathTracingMode() { return isPathTracingMode; },
            hasActiveLightLinks: () => lightLinkingRef?.hasActiveLinks?.() === true,
        });
        const {
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
        } = rendererCore;
        try {
            await createRenderer();
        } catch (error) {
            const message = error?.message || String(error);
            document.getElementById('info').textContent = `max.js - renderer init failed: ${message}`;
            throw error;
        }

        if (THREE.RectAreaLightNode?.setLTC) {
            THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
        }

        // Tell the plugin whether deform normals can be rebuilt GPU-side; when
        // true the C++ fast lane streams positions only (all mesh sizes) and
        // gpu_normals.js recomputes normals per update in a compute pass.
        // Announced false while the GPU path is hard-disabled (see
        // gpu_normals.js — three r185 mutates itemSize-3 storage attributes,
        // which corrupts live-streamed geometry). CPU normal streaming covers
        // everything below the compact-channel threshold instead.
        window.chrome?.webview?.postMessage({ type: 'gpu_normals', enabled: false });

        // ── Render mode ───────────────────────────────────────
        // MaxLightsNode is the adaptive factory in every node-renderer mode.
        // Unlinked lights stay on Three's own dynamic/native light nodes; only
        // a light with an explicit include/exclude mode enters the masked path.
        // The same factory also carries the opt-in HALO-GI nodes, replacing the
        // old Standard=GiLights / Spectral=MaxLights split.
        // Pathtracing = isolated legacy WebGL2 progressive path tracer.
        //               This is live-viewer only and is not exported to snapshots.
        //
        // Mode is frozen before renderer init; switching requires reload.
        // Three caches lighting.createNode() per scene, so the adaptive factory
        // must be installed before frame one; switching it when a checkbox is
        // clicked is too late. Simple WGL2 has no node-lighting factory and is
        // intentionally left on stock WebGLRenderer behavior.
        installMaxLightsRenderer(renderer);

        let giVolume = null;
        let haloGi = null; // HALO-GI BVH-traced DDGI probe field (opt-in; see init below)
        // HALO-GI idle tracking: the probe field holds its synchronous BVH rebuild + GPU
        // solve until the view rests (camera quiet, not playing, delta-sync settled), so
        // a freeze can never land during interaction. Updated in the render loop.
        let haloGiLastInteractionMs = 0;

        let controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.zoomToCursor = true;
        controls.screenSpacePanning = false;
        controls.mouseButtons = {
            LEFT: null,               // reserved for selection
            MIDDLE: THREE.MOUSE.PAN,  // middle = pan
            RIGHT: null               // reserved
        };
        controls.zoomSpeed = 2.0;
        controls.rotateSpeed = 0.5;
        controls.panSpeed = 1.0;
        // Alt+MMB = orbit (3ds Max style) — capture phase to beat OrbitControls
        renderer.domElement.addEventListener('pointerdown', e => {
            if (e.button === 1 && controls.enabled) {
                controls.mouseButtons.MIDDLE = e.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
            }
        }, true);
        renderer.domElement.addEventListener('pointerup', e => {
            if (e.button === 1) {
                controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
            }
        }, true);
        controls.enabled = false;  // cam lock ON by default

        // Grid lives in Max space under the basis root, so the default helper plane
        // lands on Max's XY ground plane without extra rotations.
        const grid = new THREE.GridHelper(200, 20, 0x555555, 0x444444);
        grid.visible = false;
        grid.userData.maxjsExcludeFromRuntimeSnapshot = true;
        overlayRoot.add(grid);

        // Live viewer fallback lighting — camera-following headlight rig used
        // when the Max scene has no authored lights or environment.
        const defaultLights = new THREE.Group();
        const defaultAmbient = new THREE.AmbientLight(0xffffff, 0.4);
        defaultAmbient.userData.volumetricBypass = true;
        defaultLights.add(defaultAmbient);
        const defaultKey = new THREE.DirectionalLight(0xffffff, 2.5);
        defaultKey.userData.volumetricBypass = true;
        defaultKey.castShadow = false;
        defaultKey.shadow.mapSize.set(2048, 2048);
        defaultKey.shadow.camera.near = 0.1;
        defaultKey.shadow.camera.far = 2000;
        defaultKey.shadow.camera.left = -500;
        defaultKey.shadow.camera.right = 500;
        defaultKey.shadow.camera.top = 500;
        defaultKey.shadow.camera.bottom = -500;
        defaultKey.shadow.bias = -0.001;
        defaultKey.shadow.normalBias = 0.02;
        const defaultFill = new THREE.DirectionalLight(0xe8e8e8, 0.8);
        defaultFill.userData.volumetricBypass = true;
        defaultFill.position.set(-1, 1, 0.5);
        defaultLights.add(defaultKey);
        defaultLights.add(defaultFill);
        scene.add(defaultLights);
        const lightHandleMap = new Map();
        let lightHelpersVisible = false;
        let lastLightsSignature = '';
        let lightLinkPanelVisible = false;
        const LIGHT_LINK_STORAGE_KEY = 'maxjs-light-linking';
        const lightProbe = new THREE.LightProbe();
        scene.add(lightProbe);

        // ── Loaders & Caches ────────────────────────────────
        const textureLoader = new THREE.TextureLoader();
        const webglTextureLoader = new THREE_STD.TextureLoader();
        const rgbeLoader = new HDRLoader();
        const exrLoader = new EXRLoader();
        suppressKnownExrMetadataWarnings(exrLoader);
        textureLoader.setCrossOrigin?.('anonymous');
        webglTextureLoader.setCrossOrigin?.('anonymous');
        rgbeLoader.setCrossOrigin?.('anonymous');
        exrLoader.setCrossOrigin?.('anonymous');
        const PMREMGeneratorCtor = renderer?.isWebGLRenderer === true
            ? THREE_STD.PMREMGenerator
            : THREE.PMREMGenerator;
        const pmremGenerator = new PMREMGeneratorCtor(renderer);
        pmremGenerator.compileEquirectangularShader();

        function getTextureExtension(source) {
            try {
                const url = new URL(String(source || ''), window.location.href);
                return (url.pathname.split('.').pop() || '').toLowerCase();
            } catch {
                const clean = String(source || '').split(/[?#]/, 1)[0];
                return (clean.split('.').pop() || '').toLowerCase();
            }
        }

        const hdrTextureExtensions = new Set(['hdr', 'exr']);

        function colorSpaceForTextureExtension(ext, requestedColorSpace) {
            return hdrTextureExtensions.has(ext) && requestedColorSpace === THREE.SRGBColorSpace
                ? THREE.LinearSRGBColorSpace
                : requestedColorSpace;
        }

        function suppressKnownExrMetadataWarnings(loader) {
            if (!loader || loader.userData?.maxjsQuietM44fHeader) return loader;
            const originalParse = typeof loader.parse === 'function' ? loader.parse.bind(loader) : null;
            if (!originalParse) return loader;
            loader.parse = (...args) => {
                const previousWarn = console.warn;
                console.warn = (...warnArgs) => {
                    const msg = String(warnArgs?.[0] ?? '');
                    if (msg.includes('THREE.EXRLoader: Skipped unknown header attribute type') &&
                        msg.includes('m44f')) {
                        return;
                    }
                    previousWarn.apply(console, warnArgs);
                };
                try {
                    return originalParse(...args);
                } finally {
                    console.warn = previousWarn;
                }
            };
            loader.userData = { ...(loader.userData || {}), maxjsQuietM44fHeader: true };
            return loader;
        }

        const browserTextureExtensions = new Set([
            'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'svg',
            'exr', 'hdr',
        ]);

        function canBrowserLoadTextureExtension(ext) {
            return !ext || browserTextureExtensions.has(ext);
        }

        const videoTextureExtensions = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);

        function isVideoTextureExtension(ext) {
            return !!ext && videoTextureExtensions.has(ext);
        }

        let pendingTextureLoads = 0;
        const nodeMap = new Map();
        const maxInstanceBuckets = new Map(); // bucketKey -> { mesh, materialKey, sourceHandle, handles:Set, handleToIndex:Map, transforms:Map, visible:Map }
        const maxInstanceHandleToBucket = new Map(); // handle -> bucketKey
        let animationSystem = null;
        let audioSystem = null;
        let audioMuted = readPersistedAudioMuted();
        let gltfSystem = null;
        let webappSystem = null;
        const perfHud = createPerfHud(document.getElementById('info'));
        perfHud.setStatus(`max.js - ${rendererBackendLabel} renderer ready`);

        const DEBUG_STORAGE_KEY = 'maxjs_debug';
        const PROFILE_SCENE_STORAGE_KEY = 'maxjs_profile_scene';
        const isStandalone = !(window.chrome?.webview?.postMessage);
        const urlMode = new URLSearchParams(location.search).get('mode');
        let buildMode = urlMode || (isStandalone ? 'release' : 'dev');
        var debugMode = false;
        // Session-only by design: sync always boots LIVE; SLOW is a per-session
        // debugging escape hatch, never a restored state. FLOW is likewise
        // opt-in per session — it changes Max-side pacing, so it must never be
        // a state a user finds themselves in without having chosen it.
        const SYNC_MODES = ['live-fast', 'flow', 'slow-json'];
        let syncMode = 'live-fast';
        // Retained so every existing read keeps its exact meaning: FLOW is a
        // live-fast variant, never a slow-JSON one.
        let slowJsonSyncMode = false;

        function setAudioMuted(nextMuted, { persist = true } = {}) {
            audioMuted = !!nextMuted;
            audioSystem?.setMuted?.(audioMuted);
            if (persist) {
                try { localStorage.setItem(AUDIO_MUTED_STORAGE_KEY, audioMuted ? 'true' : 'false'); } catch {}
            }
            syncAudioMuteButtonUi();
        }

        try {
            const raw = localStorage.getItem(DEBUG_STORAGE_KEY);
            if (raw === 'true') debugMode = true;
            else if (raw === 'false') debugMode = false;
            else {
                // Unset: loud inside Max; quiet for hosted snapshots (release). ?mode=dev defaults verbose.
                debugMode = !isStandalone || buildMode !== 'release';
            }
        } catch (_) {
            debugMode = !isStandalone;
        }
        function maxjsDebugLog(...args) {
            if (debugMode) console.log(...args);
        }
        function maxjsDebugWarn(...args) {
            if (debugMode) console.warn(...args);
        }
        function isSceneProfilingEnabled() {
            try {
                return localStorage.getItem(PROFILE_SCENE_STORAGE_KEY) === 'true';
            } catch (_) {
                return false;
            }
        }

        const maxjsFx = createMaxJSFxController({
            renderer,
            scene,
            camera,
            backendLabel: rendererBackendLabel,
            environmentVisible: false,
            hiddenBackgroundColor,
            onError(message) {
                perfHud.setStatus(`max.js - ${message}`);
            },
        });
        // Default camera light available for contact shadows from the start
        if (maxjsFx.setMainLight) maxjsFx.setMainLight(defaultKey);

        function setBackgroundColor(hex = hiddenBackgroundColor) {
            hiddenBackgroundColor = hex >>> 0;
            viewportBackgroundColor.setHex(hiddenBackgroundColor);
            syncViewportBackdrop();
            maxjsFx.setHiddenBackgroundColor(hiddenBackgroundColor);
            geospatialSky?.setFallbackBackground?.(hiddenBackgroundColor);
            saveBackgroundColor();
            syncBackgroundColorSlot();
            savePostFxState();
        }

        const webglBasicFx = createWebGLBasicFx({
            THREE: THREE_STD,
            renderer,
            scene,
            camera,
            backendLabel: rendererBackendLabel,
            onError(message, error) {
                console.warn(message, error);
            },
        });
        window.maxjsWebGLBasicFx = webglBasicFx;

        // Forward viewport clicks to HTML texmap content. Raycast hits a
        // mesh whose material has any HTML-texture map slot → convert UV
        // hit to host pixel coords → dispatch click to the matching DOM
        // element inside the texture's shadow tree.
        attachHTMLClickForwarding(THREE, renderer, () => ({ camera, scene }));

        // Pointer input for depth-occluded web panels (behind-canvas CSS3D).
        // Reads targets lazily — webappSystem is created later in startup.
        attachDomPanelForwarding({
            THREE,
            renderer,
            getCameraScene: () => ({ camera, scene }),
            getTargets: () => webappSystem?.listForwardTargets?.() ?? [],
        });

        // Shader Lab FX — optional custom pass consumed by the unified
        // Post FX controller. Toggled from the right rail. Loads React +
        // @basementstudio/shader-lab from esm.sh on first enable.
        const shaderLabFx = createShaderLabFx({ THREE, renderer, scene, camera });
        maxjsFx.setShaderLabFx?.(shaderLabFx);
        const pathTracingSettings = {
            samplesPerFrame: 64,
            giClamp: 8.0,
            freezeSync: false,
            paused: false,
            sampleLimit: 0, // 0 = unlimited; >0 converges then stops (frees GPU)
        };
        let ptPauseUiSync = null; // set when the PT pause toggle is created

        function beginTextureLoad() {
            pendingTextureLoads += 1;
        }

        function endTextureLoad() {
            pendingTextureLoads = Math.max(0, pendingTextureLoads - 1);
        }
        const pathTracingFx = createSpectralTracer({
            renderer,
            scene,
            camera,
            enabled: isStudioMode, // spectral mode: view toggles live via setSpectralView()
            settings: pathTracingSettings,
            onStatus(message) {
                perfHud.setStatus(message);
            },
            onError(error) {
                reportBridgeError('pathtracing', error);
            },
        });
        if (isStudioMode || String(rendererBackendLabel || '') === 'WebGL Mode') {
            pathTracingFx.preload?.();
        }
        const PATH_TRACING_RASTER_WARMUP_FRAMES = 2;
        const PATH_TRACING_TEXTURE_WAIT_MS = 3000;
        const PATH_TRACING_CAPTURE_DEFAULT_SAMPLES = 64;
        const PATH_TRACING_LIVE_REBUILD_DELAY_MS = 180;

        let pathTracingRasterWarmupFrames = 0;
        let pathTracingWarmupStartedAt = 0;
        let pathTracingBridge = null;
        let refreshSkyForSpectralViewNow = () => false;
        const pathTracingGlue = createPathTracingGlue({
            PATH_TRACING_RASTER_WARMUP_FRAMES,
            PATH_TRACING_TEXTURE_WAIT_MS,
            PATH_TRACING_LIVE_REBUILD_DELAY_MS,
            maxTimeline,
            syncPathTracingDofFromPostFx: (...args) => syncPathTracingDofFromPostFx(...args),
            bridgeHasInitialSync: (...args) => bridgeHasInitialSync(...args),
            hasActiveLightLinks: () => lightLinkingRef?.hasActiveLinks?.() === true,
            get isStudioMode() { return isStudioMode; },
            get spectralView() { return spectralView; },
            set spectralView(value) { spectralView = value; },
            get isPathTracingMode() { return isPathTracingMode; },
            set isPathTracingMode(value) { isPathTracingMode = value; },
            get pathTracingFx() { return pathTracingFx; },
            get maxjsFx() { return maxjsFx; },
            get renderer() { return renderer; },
            get shaderLabFx() { return shaderLabFx; },
            get renderToImageActive() { return renderToImageActive; },
            get pathTracingSettings() { return pathTracingSettings; },
            get pathTracingRasterWarmupFrames() { return pathTracingRasterWarmupFrames; },
            set pathTracingRasterWarmupFrames(value) { pathTracingRasterWarmupFrames = value; },
            get pathTracingWarmupStartedAt() { return pathTracingWarmupStartedAt; },
            set pathTracingWarmupStartedAt(value) { pathTracingWarmupStartedAt = value; },
            get pendingTextureLoads() { return pendingTextureLoads; },
            get bridge() { return pathTracingBridge; },
            get perfHud() { return perfHud; },
            get ptPauseUiSync() { return ptPauseUiSync; },
            refreshSkyForSpectralView: () => refreshSkyForSpectralViewNow(),
        });
        const {
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
        } = pathTracingGlue;

        // Clone blob overlay — 2D canvas for bounding rectangles
        blobOverlayCvs = document.createElement('canvas');
        blobOverlayCvs.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10';
        const initialBlobFrameRect = getViewportFrameRect();
        blobOverlayCvs.width = initialBlobFrameRect.width;
        blobOverlayCvs.height = initialBlobFrameRect.height;
        applyFrameElementStyle(blobOverlayCvs, initialBlobFrameRect);
        document.body.appendChild(blobOverlayCvs);
        blobOverlayCtx = blobOverlayCvs.getContext('2d');

        // Composition guide overlay — always-on-top framing helpers pinned to
        // the viewport frame so they track Safe Frame cropping automatically.
        compositionOverlay = createCompositionOverlay({
            applyFrameStyle: applyFrameElementStyle,
            getFrameRect: getViewportFrameRect,
        });
        compositionOverlay.resize(getViewportFrameRect());

        addEventListener('resize', () => {
            const rect = getViewportFrameRect();
            blobOverlayCvs.width = rect.width;
            blobOverlayCvs.height = rect.height;
            applyFrameElementStyle(blobOverlayCvs, rect);
            compositionOverlay?.resize(rect);
            if (asciiActive && asciiEffect) {
                asciiEffect.setSize(rect.width, rect.height);
                applyFrameElementStyle(asciiEffect.domElement, rect);
            }
        });

        function createSolidTexture(r, g, b, a = 255) {
            const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
            tex.colorSpace = THREE.NoColorSpace;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.minFilter = tex.magFilter = THREE.LinearFilter;
            tex.needsUpdate = true;
            tex.updateMatrix();
            return tex;
        }

        function createSteppedGradientTexture(values) {
            const data = new Uint8Array(values.length * 4);
            for (let i = 0; i < values.length; i++) {
                const value = values[i];
                const offset = i * 4;
                data[offset + 0] = value;
                data[offset + 1] = value;
                data[offset + 2] = value;
                data[offset + 3] = 255;
            }
            const tex = new THREE.DataTexture(data, values.length, 1);
            tex.colorSpace = THREE.NoColorSpace;
            tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.minFilter = tex.magFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            tex.updateMatrix();
            return tex;
        }

        const fallbackWhiteTexture = createSolidTexture(255, 255, 255, 255);
        const fallbackFlatNormalTexture = createSolidTexture(128, 128, 255, 255);
        const fallbackHeightTexture = createSolidTexture(255, 255, 255, 255);
        const fallbackToonGradientTexture = createSteppedGradientTexture([32, 96, 160, 255]);

        let camLock = true;
        let physicalCameraDofActive = false;
        let envVisible = false;
        let lightProbeEnabled = true;
        const lightProbeIntensity = 1.0;
        let currentHdriUrl = null;
        let currentHdriProbeSignature = '';
        let currentEnvParams = null;
        let hasLightProbeData = false;
        let lightProbeGrid = null;
        let hasLightProbeGridData = false;
        let hdriLoadGeneration = 0;
        let lightProbeRefreshTimer = 0;

        let localHdriFile = null;        // original picked/restored file for snapshot export

        // No-op — env intensity is now controlled per-material via
        // material.envMapIntensity using the patched materialEnvIntensity
        // node (see import section). No need to stamp envMap on materials.
        function syncMaterialEnvMaps() {}
        let localHdriEnabled = true;     // on/off toggle (file stays loaded)
        let localHdriFileName = '';
        let localHdriRotation = 0;
        let localHdriIntensity = 1.0;
        let localHdriShowBg = false;
        let localHdriBlur = 0;
        let localHdriFlip = false;
        let localHdriReflectionOnly = false;

        const texturePipeline = await createTexturePipeline({
            TSL,
            textureLoader,
            webglTextureLoader,
            rgbeLoader,
            exrLoader,
            fallbackWhiteTexture,
            fallbackFlatNormalTexture,
            fallbackHeightTexture,
            fallbackToonGradientTexture,
            isFiniteArray: (...args) => isFiniteArray(...args),
            getTextureExtension,
            colorSpaceForTextureExtension,
            canBrowserLoadTextureExtension,
            isVideoTextureExtension,
            maxjsDebugWarn,
            beginTextureLoad,
            endTextureLoad,
            rememberMaterialEmissiveBase: (...args) => rememberMaterialEmissiveBase(...args),
            reapplyBakeOverridesToScene: () => reapplyBakeOverridesToScene(),
            get renderer() { return renderer; },
            get rendererBackendLabel() { return rendererBackendLabel; },
            get bakeOverrides() { return bakeOverrides; },
            get maxjsFx() { return maxjsFx; },
        });
        const {
            configureGradientTexture,
            maxMapChannelFromMapName,
            textureWithUvChannel,
            resolveLightMapMaxMapChannel,
            createPendingMaterialXMaterial,
            ensureMaterialXTemplateLoaded,
            loadTexture,
            tslCompiler,
            isWebGLTexturePathActive,
            loadBakeTextureFromCandidates,
            bakeExposureScale,
            isDisplayBakedBeautyProxy,
            clearBakeTextureLoadFailures,
            HTML_TEXTURE_AUTO_FIT_KEYS,
            htmlTextureAutoFitEnabled,
            matrixScaleSignature,
            withHTMLAutoFitIdentity,
            loadMapSlot,
            applyOpacityTextureSlot,
            preserveOpacityForHTMLColorMap,
            wantsHTMLTextureOverrideMaterial,
            htmlTextureOverrideIdentity,
            createHTMLTextureOverrideMaterial,
            textureCache,
        } = texturePipeline;
        const MAXJS_SELF_HIDDEN_LAYER = 31;
        let jsmodVisibilityOwnedByLayer = null;
        const materials = createMaterials({
            MAXJS_SELF_HIDDEN_LAYER,
            fallbackWhiteTexture,
            fallbackFlatNormalTexture,
            fallbackHeightTexture,
            fallbackToonGradientTexture,
            configureGradientTexture,
            textureWithUvChannel,
            resolveLightMapMaxMapChannel,
            createPendingMaterialXMaterial,
            ensureMaterialXTemplateLoaded,
            loadTexture,
            tslCompiler,
            HTML_TEXTURE_AUTO_FIT_KEYS,
            htmlTextureAutoFitEnabled,
            matrixScaleSignature,
            withHTMLAutoFitIdentity,
            loadMapSlot,
            applyOpacityTextureSlot,
            preserveOpacityForHTMLColorMap,
            wantsHTMLTextureOverrideMaterial,
            htmlTextureOverrideIdentity,
            createHTMLTextureOverrideMaterial,
            applyWebGpuLightMapUvContext: (...args) => applyWebGpuLightMapUvContext(...args),
            applyBakeOverridesToSceneMaterial: (...args) => applyBakeOverridesToSceneMaterial(...args),
            get rendererBackendLabel() { return rendererBackendLabel; },
            get bakeOverrides() { return bakeOverrides; },
            get nodeMap() { return nodeMap; },
            get maxInstanceBuckets() { return maxInstanceBuckets; },
            get hairMeshes() { return hairMeshes; },
            get forestMeshes() { return forestMeshes; },
            get layerManager() { return layerManager; },
            get jsmodVisibilityOwnedByLayer() { return jsmodVisibilityOwnedByLayer; },
        });
        const {
            rememberMaterialEmissiveBase,
            applyMaterialSelectionState,
            applyMeshShadowState,
            applyNodeProps,
            applyJsmodSyncState,
            applyUserPropsSyncState,
            setObjectSelfVisibleLayer,
            restoreRenderableMaterialVisibility,
            applyMaxObjectVisibility,
            applyBridgeVisibility,
            applyInstanceSyncState,
            getSSSRoughnessInfluence,
            applySSSRoughnessInfluence,
            applySSSMaterialNodes,
            createBackdropUtilityMaterial,
            normalizeMaxVertexColorChannel,
            maxVertexColorAttributeName,
            createUtilityMaterial,
            materialIdentityValue,
            materialIdentityKey,
            materialTemplateCacheKey,
            getMaterialPayloads,
            countMaterialTextureSlots,
            getOrCreateMaterialRegistryEntry,
            refreshMaterialRegistry,
            materialRegistryHudStats,
            getMaterialRegistryStats,
            getMaterialRegistryEntries,
            resolveSnapshotMaterialRefs,
            shouldRouteBlackSpecularToLambert,
            createMaterial,
            createSceneMaterial,
            createDefaultSceneMaterial,
            materialPayloadHasHTMLAutoFit,
            nodePayloadHasHTMLAutoFit,
            disposeSceneMaterial,
            collectMaterialRefs,
            collectLiveSceneMaterials,
            flushMaterialDisposals,
            createSceneLineMaterial,
            sceneMaterialSignature,
            isCachedMaterialTemplate,
            createSceneRenderableMaterial,
            cloneGeometryGroups,
            applyGeometryGroups,
            geometryGroupsMatch,
            resolveInstancedNodeGeometry,
            isGeometrySharedByAnotherMesh,
            syncGeometryGroupsForNode,
            applyFastMaterialPayload,
            stampSceneMaterial,
            ensureSceneRenderableMaterial,
        } = materials;
        const environment = createEnvironment({
            textureLoader,
            rgbeLoader,
            exrLoader,
            getTextureExtension,
            colorSpaceForTextureExtension,
            maxjsDebugWarn,
            maxjsHdriDiffuseIntensity,
            applyViewportBackdropColor,
            setDefaultLightsVisible: (...args) => setDefaultLightsVisible(...args),
            syncMaterialEnvMaps,
            clearLightProbe: (...args) => clearLightProbe(...args),
            markLightProbeSceneDirty: (...args) => markLightProbeSceneDirty(...args),
            markLightProbeMaterialsDirty: (...args) => markLightProbeMaterialsDirty(...args),
            applyLightProbeState: (...args) => applyLightProbeState(...args),
            updateLightProbeFromHDRI: (...args) => updateLightProbeFromHDRI(...args),
            scheduleLightProbeFromCurrentScene: (...args) => scheduleLightProbeFromCurrentScene(...args),
            markPathTracingSceneDirtyNow: (...args) => markPathTracingSceneDirtyNow(...args),
            setBackgroundColor,
            applyCoreToneMappingState: (options) => applyCoreToneMappingState(options),
            savePostFxState: () => savePostFxState(),
            hasAuthoredEnvironmentActive: () => hasAuthoredEnvironmentActive(),
            restoreAuthoredEnvironmentAfterLocalHDRIChange: () => restoreAuthoredEnvironmentAfterLocalHDRIChange(),
            get renderer() { return renderer; },
            get rendererBackendLabel() { return rendererBackendLabel; },
            get scene() { return scene; },
            get pmremGenerator() { return pmremGenerator; },
            get maxjsFx() { return maxjsFx; },
            get hiddenBackgroundColor() { return hiddenBackgroundColor; },
            get envVisible() { return envVisible; },
            get lightHandleMap() { return lightHandleMap; },
            get skyActive() { return skyActive; },
            get isPathTracingMode() { return isPathTracingMode; },
            get lightProbeEnabled() { return lightProbeEnabled; },
            get hasLightProbeData() { return hasLightProbeData; },
            get lightProbeRefreshTimer() { return lightProbeRefreshTimer; },
            set lightProbeRefreshTimer(value) { lightProbeRefreshTimer = value; },
            get currentHdriUrl() { return currentHdriUrl; },
            set currentHdriUrl(value) { currentHdriUrl = value; },
            get currentHdriProbeSignature() { return currentHdriProbeSignature; },
            set currentHdriProbeSignature(value) { currentHdriProbeSignature = value; },
            get currentEnvParams() { return currentEnvParams; },
            set currentEnvParams(value) { currentEnvParams = value; },
            get hdriLoadGeneration() { return hdriLoadGeneration; },
            set hdriLoadGeneration(value) { hdriLoadGeneration = value; },
            get localHdriFile() { return localHdriFile; },
            set localHdriFile(value) { localHdriFile = value; },
            get localHdriEnabled() { return localHdriEnabled; },
            set localHdriEnabled(value) { localHdriEnabled = value; },
            get localHdriFileName() { return localHdriFileName; },
            set localHdriFileName(value) { localHdriFileName = value; },
            get localHdriRotation() { return localHdriRotation; },
            set localHdriRotation(value) { localHdriRotation = value; },
            get localHdriIntensity() { return localHdriIntensity; },
            set localHdriIntensity(value) { localHdriIntensity = value; },
            get localHdriShowBg() { return localHdriShowBg; },
            set localHdriShowBg(value) { localHdriShowBg = value; },
            get localHdriBlur() { return localHdriBlur; },
            set localHdriBlur(value) { localHdriBlur = value; },
            get localHdriFlip() { return localHdriFlip; },
            set localHdriFlip(value) { localHdriFlip = value; },
            get localHdriReflectionOnly() { return localHdriReflectionOnly; },
            set localHdriReflectionOnly(value) { localHdriReflectionOnly = value; },
        });
        const {
            retainPMREMTexture,
            loadEnvironmentTexture,
            getEnvironmentBackgroundMap,
            syncViewportBackdrop,
            syncEnvironmentDisplay,
            syncDefaultLightsVisibility,
            resetEnvironmentLighting,
            isLocalHdriLoaded,
            isLocalHdriActive,
            isHdriReflectionOnlyEffective,
            applyHdriReflectionOnlyState,
            clearCurrentHdriEnvMap,
            refreshLightProbeFromCurrentHDRI,
            loadHDRI,
            restoreStashedHdri,
            loadLocalHDRIFile,
            applyLocalHDRIToScene,
            applyLocalHDRISettings,
            toggleLocalHDRI,
            clearLocalHDRI,
            syncHdriPanel,
        } = environment;

        // ── Sky Environment ──────────────────────────────────
        let skyActive = false;
        let geospatialSky = null;
        const sky = createSky({
            copyMaxComponentsToWorld,
            retainPMREMTexture,
            syncMaterialEnvMaps,
            clearLightProbe: (...args) => clearLightProbe(...args),
            applyLightProbeState: (...args) => applyLightProbeState(...args),
            applyHdriReflectionOnlyState,
            clearCurrentHdriEnvMap,
            applyCoreToneMappingState: (options) => applyCoreToneMappingState(options),
            syncDefaultLightsVisibility,
            syncHdriPanel,
            loadHDRI,
            get isStudioMode() { return isStudioMode; },
            get renderer() { return renderer; },
            get rendererBackendLabel() { return rendererBackendLabel; },
            get scene() { return scene; },
            get camera() { return camera; },
            get pmremGenerator() { return pmremGenerator; },
            get maxjsFx() { return maxjsFx; },
            get hiddenBackgroundColor() { return hiddenBackgroundColor; },
            get lightProbe() { return lightProbe; },
            get lightHandleMap() { return lightHandleMap; },
            get isPathTracingMode() { return isPathTracingMode; },
            get haloGi() { return haloGi; },
            get currentEnvParams() { return currentEnvParams; },
            get skyActive() { return skyActive; },
            set skyActive(value) { skyActive = value; },
            get geospatialSky() { return geospatialSky; },
            set geospatialSky(value) { geospatialSky = value; },
            get lightProbeGrid() { return lightProbeGrid; },
            set lightProbeGrid(value) { lightProbeGrid = value; },
            get hasLightProbeData() { return hasLightProbeData; },
            set hasLightProbeData(value) { hasLightProbeData = value; },
            get hasLightProbeGridData() { return hasLightProbeGridData; },
            set hasLightProbeGridData(value) { hasLightProbeGridData = value; },
            get currentHdriUrl() { return currentHdriUrl; },
            set currentHdriUrl(value) { currentHdriUrl = value; },
            get currentHdriProbeSignature() { return currentHdriProbeSignature; },
            set currentHdriProbeSignature(value) { currentHdriProbeSignature = value; },
        });
        const {
            addSkyProbeSample,
            sampleSkyProbeRadiance,
            sampleSkyReflectionRadiance,
            disposeSkyReflectionEnvironment,
            disposeSkyPathTraceEnvironment,
            updateSkyPathTraceEnvironment,
            buildProceduralSkyReflectionEnvironment,
            updateSkyReflectionEnvironment,
            updateSkyAmbientLightProbe,
            skyNumber,
            hasAuthoredEnvironmentActive,
            restoreAuthoredEnvironmentAfterLocalHDRIChange,
            normalizeSkyParams,
            getSkySunDirectionWorld,
            isSkyLinkCandidateLight,
            getDirectionalLightSunVector,
            findSkyLinkedSunDirection,
            withLinkedSkySun,
            updateSkyTime,
            refreshSkyFromLinkedSun,
            refreshSkyAmbientLightProbeFromCurrentSky,
            removeClassicSkyObjects,
            applySky,
            removeSky,
            refreshSkyForSpectralView,
        } = sky;
        refreshSkyForSpectralViewNow = refreshSkyForSpectralView;

        function materialListHasRawShader(material) {
            if (Array.isArray(material)) return material.some((entry) => entry?.isRawShaderMaterial);
            return !!material?.isRawShaderMaterial;
        }

        function removeWebGPUIncompatibleSceneMaterials() {
            if (rendererBackendLabel !== 'WebGPU') return;
            const removals = [];
            scene.traverse((object) => {
                if (!object?.parent) return;
                if (
                    materialListHasRawShader(object.material)
                    || materialListHasRawShader(object.customDepthMaterial)
                    || materialListHasRawShader(object.customDistanceMaterial)
                ) {
                    removals.push(object);
                }
            });
            for (const object of removals) {
                object.parent?.remove(object);
                if (!object.userData?.maxjsRawShaderPurgeLogged) {
                    object.userData.maxjsRawShaderPurgeLogged = true;
                    console.warn('[max.js] removed WebGPU-incompatible RawShaderMaterial object:', object.name || object.type || '(unnamed)');
                }
            }
        }

        function removeAuthoredEnvironment() {
            // Idempotent: every settle full-sync re-sends "no environment".
            // Tearing down an environment that is not there resets env
            // lighting, which dirties EVERY material — a one-frame full
            // pipeline recompile on each timeline scrub release.
            if (!skyActive && !currentHdriUrl && !currentEnvParams && !scene.environment) return;
            removeSky();
            currentHdriUrl = null;
            currentHdriProbeSignature = '';
            currentEnvParams = null;
            clearCurrentHdriEnvMap();
            scene.environment = null;
            syncMaterialEnvMaps();
            scene.environmentIntensity = 1.0;
            applyHdriReflectionOnlyState();
            scene.environmentRotation.set(0, 0, 0);
            scene.backgroundRotation.set(0, 0, 0);
            scene.backgroundBlurriness = 0;
            syncEnvironmentDisplay();
            resetEnvironmentLighting();
            if (isLocalHdriLoaded()) {
                applyLocalHDRIToScene();
            }
            syncHdriPanel();
        }

        // ── Max Bridge ────────────────────────────────────── (core in ./host_bridge.js — the host seam)
        const ctx = createEditorContext();
        const hostBridge = createHostBridge({
            setInfoText: text => setInfoText(text),
            // Restore Studio manifest state now that lights + meshes are populated.
            onFirstSync: () => { restoreStudioState(); restoreBakeState(); },
            onBeforeReady: () => sendPathTracingRuntimeState(),
        });
        const bridge = hostBridge.bridge;
        pathTracingBridge = bridge;
        const { requestHostAction, toBase64Utf8, bytesToBase64, reportBridgeError,
                startBridgeHandshake, markInitialSync } = hostBridge;
        const bridgeHasInitialSync = hostBridge.hasInitialSync;
        ctx.hostBridge = hostBridge;
        ctx.bridge = bridge;

        const giVolumeGlue = createGiVolumeGlue({
            pageParams,
            maxTimeline,
            hostBridge,
            bridge,
            maxjsDebugWarn,
            savePostFxState: () => savePostFxState(),
            bakeStateSignature: () => bakeStateSignature(),
            isLocalHdriActive: () => isLocalHdriActive(),
            isHdriReflectionOnlyEffective: () => isHdriReflectionOnlyEffective(),
            refreshSkyAmbientLightProbeFromCurrentSky: () => refreshSkyAmbientLightProbeFromCurrentSky(),
            setSpectralSkyDiffuseOwnership(active) {
                const next = active === true;
                if ((scene.userData.maxjsSpectralSkyDdgiOwnsDiffuse === true) === next) return;
                scene.userData.maxjsSpectralSkyDdgiOwnsDiffuse = next;
                applyHdriReflectionOnlyState({ markOutput: true });
            },
            get renderer() { return renderer; },
            get scene() { return scene; },
            get nodeMap() { return nodeMap; },
            get defaultLights() { return defaultLights; },
            get isStudioMode() { return isStudioMode; },
            get isPathTracingMode() { return isPathTracingMode; },
            get renderToImageActive() { return renderToImageActive; },
            get lightProbe() { return lightProbe; },
            get lightProbeEnabled() { return lightProbeEnabled; },
            get lightProbeIntensity() { return lightProbeIntensity; },
            get lightProbeGrid() { return lightProbeGrid; },
            set lightProbeGrid(value) { lightProbeGrid = value; },
            get hasLightProbeData() { return hasLightProbeData; },
            set hasLightProbeData(value) { hasLightProbeData = value; },
            get hasLightProbeGridData() { return hasLightProbeGridData; },
            set hasLightProbeGridData(value) { hasLightProbeGridData = value; },
            get currentHdriUrl() { return currentHdriUrl; },
            get currentHdriProbeSignature() { return currentHdriProbeSignature; },
            set currentHdriProbeSignature(value) { currentHdriProbeSignature = value; },
            get hdriLoadGeneration() { return hdriLoadGeneration; },
            set hdriLoadGeneration(value) { hdriLoadGeneration = value; },
            get lightProbeRefreshTimer() { return lightProbeRefreshTimer; },
            set lightProbeRefreshTimer(value) { lightProbeRefreshTimer = value; },
            get lastLightsSignature() { return lastLightsSignature; },
            get giVolume() { return giVolume; },
            set giVolume(value) { giVolume = value; },
            get haloGi() { return haloGi; },
            set haloGi(value) { haloGi = value; },
            get haloGiLastInteractionMs() { return haloGiLastInteractionMs; },
            set haloGiLastInteractionMs(value) { haloGiLastInteractionMs = value; },
        });
        const {
            HALO_GI_NUMERIC_CONTROLS,
            GI_VOLUME_CAMERA_DEBOUNCE_MS,
            getHaloGiSettings,
            clampHaloGiNumber,
            formatHaloGiValue,
            normalizeHaloGiSettings,
            applyHaloGiTuning,
            serializeHaloGiState,
            applyHaloGiState,
            setHaloGiSetting,
            resetHaloGiToDefaults,
            shouldAutoStartStudioGiVolume,
            ensureStudioGiVolume,
            installStudioGiConsoleHandle,
            applyLightProbeState,
            clearLightProbe,
            supportsWebGLLightProbeGrid,
            computeLightProbeGridBounds,
            chooseLightProbeGridResolution,
            markLightProbeSceneDirty,
            markLightProbeLightsDirty,
            markLightProbeMaterialsDirty,
            currentLightProbeSceneSignature,
            updateLightProbeGridFromScene,
            giVolumeNowMs,
            giVolumeEase,
            fadeGiVolumeTo,
            hideGiVolumeForDebounce,
            revealGiVolumeAfterDebounce,
            startGiVolumeHiddenSolve,
            clearGiVolumeNativeWait,
            maybeStartGiVolumeAfterNativePacket,
            requestNativeGiPackets,
            runGiVolumeAfterDebounce,
            syncGiVolumeActive,
            updateGiVolumeFromScene,
            scheduleGiVolumeFromCurrentScene,
            updateGiVolumeIdleWork,
            giVolumeCameraSignature,
            noteGiVolumeCameraSync,
            updateLightProbeFromCurrentScene,
            scheduleLightProbeFromCurrentScene,
            updateLightProbeFromHDRI,
            buildHaloProbeVolumes,
            serializeHaloGiProbeVolumes,
            syncHaloProbeVolumes,
            disposeProbeHelpers,
            updateProbeHelpers,
            setProbeHelpersVisible,
        } = giVolumeGlue;
        if (skyActive) refreshSkyForSpectralView();

        const SYNC_MODE_UI = {
            'live-fast': {
                label: 'LIVE',
                title: 'Live fast sync enabled',
                aria: 'Switch to FLOW paced sync',
                status: 'live fast sync',
            },
            'flow': {
                label: 'FLOW',
                title: 'FLOW: paced geometry sync — even Max-side load, smoother 3ds Max viewport',
                aria: 'Switch to slow JSON sync',
                status: 'flow paced sync',
            },
            'slow-json': {
                label: 'SLOW',
                title: 'Slow JSON sync: fastsync callbacks disabled',
                aria: 'Switch to live fast sync',
                status: 'slow JSON sync',
            },
        };

        function syncLiveSyncButtonUi() {
            const button = document.getElementById('btnLiveSync');
            if (!button) return;
            const ui = SYNC_MODE_UI[syncMode] || SYNC_MODE_UI['live-fast'];
            button.textContent = ui.label;
            button.classList.toggle('active', !slowJsonSyncMode);
            button.classList.toggle('is-gated', slowJsonSyncMode);
            button.setAttribute('aria-pressed', slowJsonSyncMode ? 'false' : 'true');
            button.title = ui.title;
            button.setAttribute('aria-label', ui.aria);
        }

        function applyLiveSyncSettings(next = {}, { notify = false, sendHost = false } = {}) {
            if (next.mode != null && SYNC_MODES.includes(next.mode)) {
                syncMode = next.mode;
            } else if (next.disabled != null) {
                // Pre-FLOW payload: the boolean only distinguishes SLOW from
                // live, so it must not silently knock FLOW back to LIVE.
                const wantSlow = next.disabled === true;
                if (wantSlow) syncMode = 'slow-json';
                else if (syncMode === 'slow-json') syncMode = 'live-fast';
            }
            slowJsonSyncMode = syncMode === 'slow-json';
            syncLiveSyncButtonUi();
            if (sendHost && window.chrome?.webview) {
                bridge.send('live_sync_settings', { disabled: slowJsonSyncMode, mode: syncMode });
            }
            if (notify) {
                const ui = SYNC_MODE_UI[syncMode] || SYNC_MODE_UI['live-fast'];
                perfHud.setStatus(`max.js - ${ui.status}`);
            }
        }

        document.getElementById('btnLiveSync')?.addEventListener('click', () => {
            const nextMode = SYNC_MODES[(SYNC_MODES.indexOf(syncMode) + 1) % SYNC_MODES.length];
            applyLiveSyncSettings({ mode: nextMode }, { notify: true, sendHost: true });
        });

        bridge.on('live_sync_settings', msg => {
            applyLiveSyncSettings(
                { mode: msg.mode, disabled: msg.disabled === true },
                { notify: true, sendHost: false });
        });

        // Animation-gate telemetry. swept/deform are what the playback sweeps
        // still walk each tick; parked is what the gate removed from them.
        // parked staying 0 on a heavy scene means the gate found nothing
        // static and FLOW cannot help there. promoted climbing means validity
        // intervals are lying and the audit is catching it.
        bridge.on('flow_stats', msg => {
            if (syncMode !== 'flow') return;
            const swept = Number(msg.swept) || 0;
            const deform = Number(msg.deform) || 0;
            const parked = Number(msg.parked) || 0;
            const promoted = Number(msg.promoted) || 0;
            perfHud.setStatus(
                `max.js - flow · sweep ${swept}+${deform} · parked ${parked}`
                + (promoted ? ` · promoted ${promoted}` : ''));
        });

        applyLiveSyncSettings({ mode: syncMode }, { sendHost: true });

        bridge.on('render_output_settings', msg => {
            const width = Math.max(1, Math.round(Number(msg.width) || 0));
            const height = Math.max(1, Math.round(Number(msg.height) || 0));
            const aspect = Math.max(0, Number(msg.aspect) || 0);
            if (
                renderOutputSettings.width === width &&
                renderOutputSettings.height === height &&
                Math.abs((renderOutputSettings.aspect || 0) - aspect) < 1.0e-4
            ) {
                syncSafeFrameButtonUi();
                return;
            }
            renderOutputSettings.width = width;
            renderOutputSettings.height = height;
            renderOutputSettings.aspect = aspect;
            if (safeFrameEnabled) {
                applyRenderViewportLayout({ resizeBuffers: true, resizePostFx: true });
            } else {
                syncSafeFrameButtonUi();
            }
        });

        bridge.on('pathtracing_settings', msg => {
            applyPathTracingSettings({
                samplesPerFrame: msg.samplesPerFrame,
                giClamp: msg.giClamp,
                freezeSync: msg.freezeSync,
            }, { notify: true });
        });

        let transportMode = 'waiting';
        let latestAppliedSyncFrame = 0;
        let latestAppliedSyncSerial = 0;

        function setInfoText(text) {
            perfHud.setStatus(text);
        }

        function setTransportMode(mode) {
            transportMode = mode;
        }

        function countInstances() {
            const sharedGeoms = new Set();
            let count = 0;
            for (const [handle, mesh] of nodeMap) {
                if (!mesh?.geometry) continue;
                if (maxInstanceHandleToBucket.has(handle)) continue; // counted via bucket below
                // Explicit Max instance (instOf from C++)
                if (Number.isFinite(mesh.userData?.maxjsInstOf) && mesh.userData.maxjsInstOf > 0) {
                    count++;
                    continue;
                }
                // Implicit: multiple meshes sharing same BufferGeometry
                if (sharedGeoms.has(mesh.geometry)) count++;
                else sharedGeoms.add(mesh.geometry);
            }
            // Max instance GPU buckets
            for (const [, bucket] of maxInstanceBuckets) {
                count += bucket.handles.size;
            }
            for (const [, entry] of hairMeshes) {
                count += entry?.mesh?.count ?? 0;
            }
            // Forest Pack GPU instances
            for (const [, im] of forestMeshes) {
                count += im.count;
            }
            return count;
        }

        function updateSyncHud(partial = {}) {
            if (partial.countAsAppliedSync !== false) {
                latestAppliedSyncSerial += 1;
            }
            if (Number.isFinite(partial.frameId) && partial.frameId > 0) {
                latestAppliedSyncFrame = Math.max(latestAppliedSyncFrame, partial.frameId);
            }
            // Release / static snapshot: no HUD churn (perfHud.updateSync repaints + countInstances).
            if (!debugMode || buildMode === 'release') return;
            perfHud.updateSync({
                transport: partial.transport ?? transportMode,
                frameId: partial.frameId ?? 0,
                producerBytes: partial.producerBytes ?? 0,
                decodeMs: partial.decodeMs ?? 0,
                applyMs: partial.applyMs ?? 0,
                nodeCount: nodeMap.size,
                instanceCount: countInstances(),
                ...materialRegistryHudStats(),
                textureCount: textureCache.size,
            });
        }

        bridge.on('debug', msg => {
            if (!bridgeHasInitialSync()) {
                setInfoText('max.js - ' + (msg.msg || 'debug'));
            } else {
                maxjsDebugLog('[max.js debug]', msg.msg || 'debug');
            }
        });

        const sceneSync = createSceneSync({
            hostBridge,
            bridge,
            setTransportMode,
            updateSyncHud,
            markInitialSync,
            resolveSnapshotMaterialRefs,
            applyJsmodSyncState,
            applyUserPropsSyncState,
            applyInstanceSyncState,
            applyBridgeVisibility,
            applyMeshShadowState,
            applyNodeProps,
            matrixScaleSignature,
            ensureSceneRenderableMaterial,
            applyGeometryGroups,
            syncGeometryGroupsForNode,
            resolveInstancedNodeGeometry,
            isGeometrySharedByAnotherMesh,
            createSceneRenderableMaterial,
            stampSceneMaterial,
            disposeSceneMaterial,
            materialIdentityKey,
            sceneMaterialSignature,
            isSceneProfilingEnabled,
            getMaterialRegistryStats,
            refreshMaterialRegistry,
            applyFastMaterialPayload,
            cloneGeometryGroups,
            nodePayloadHasHTMLAutoFit,
            shouldRouteBlackSpecularToLambert,
            createMaterial,
            isCachedMaterialTemplate,
            applySSSRoughnessInfluence,
            rememberMaterialEmissiveBase,
            applyMaterialSelectionState,
            normalizeMaxVertexColorChannel,
            maxVertexColorAttributeName,
            resetPathTracingStartupWarmup: (...args) => resetPathTracingStartupWarmup(...args),
            markPathTracingSceneDirtyNow: (...args) => markPathTracingSceneDirtyNow(...args),
            markLightProbeSceneDirty,
            markLightProbeLightsDirty,
            scheduleLightProbeFromCurrentScene,
            syncHaloProbeVolumes,
            schedulePathTracingLiveRebuild: (...args) => schedulePathTracingLiveRebuild(...args),
            applyCamera: (...args) => applyCamera(...args),
            applySky: (...args) => applySky(...args),
            removeSky: (...args) => removeSky(...args),
            loadHDRI: (...args) => loadHDRI(...args),
            removeAuthoredEnvironment: (...args) => removeAuthoredEnvironment(...args),
            applyLights: (...args) => applyLights(...args),
            updateSceneCameraList: (...args) => updateSceneCameraList(...args),
            applyHairInstances: (...args) => applyHairInstances(...args),
            applyForestInstances: (...args) => applyForestInstances(...args),
            applyVolumes: (...args) => applyVolumes(...args),
            fitCamera: (...args) => fitCamera(...args),
            applyHairTransform: (...args) => applyHairTransform(...args),
            applyHairVisibility: (...args) => applyHairVisibility(...args),
            applyLightData: (...args) => applyLightData(...args),
            refreshSkyFromLinkedSun: (...args) => refreshSkyFromLinkedSun(...args),
            applyLightUpdates: (...args) => applyLightUpdates(...args),
            get nodeMap() { return nodeMap; },
            get maxInstanceBuckets() { return maxInstanceBuckets; },
            get maxInstanceHandleToBucket() { return maxInstanceHandleToBucket; },
            get layerManager() { return layerManager; },
            get performanceSettings() { return performanceSettings; },
            get maxRoot() { return maxRoot; },
            get debugMode() { return debugMode; },
            get buildMode() { return buildMode; },
            get maxjsFx() { return maxjsFx; },
            get scene() { return scene; },
            get lightLinking() { return lightLinking; },
            get pathTracingFx() { return pathTracingFx; },
            get camLock() { return camLock; },
            get renderer() { return renderer; },
            get lightHandleMap() { return lightHandleMap; },
            get audioSystem() { return audioSystem; },
            get gltfSystem() { return gltfSystem; },
            get webappSystem() { return webappSystem; },
            get animationSystem() { return animationSystem; },
        });
        const {
            finalizeSceneNode,
            applyIncrementalNodeUpdate,
            buildNodeGeometryRefCounts,
            retainGeometryRef,
            releaseGeometryRef,
            disposeMaxInstanceBuckets,
            setLightLinkTargetHandles,
            disposeFlattenedGroups,
            getMaxInstanceBucketForHandle,
            matrixArraysAlmostEqual,
            updateMaxInstanceBucketVisibility,
            updateMaxInstanceBucketTransform,
            updateMaxInstanceBucketNode,
            createMaxInstanceBucketMaterial,
            computeMaxInstanceBucketGroups,
            planMaxInstanceBuckets,
            buildMaxInstanceBuckets,
            profileSceneNodes,
            findSnapshotSkySunDirection,
            withSnapshotLinkedSkySun,
            finalizeSceneSnapshot,
            handleBinaryScene,
            handleBinaryDelta,
            normalizeVertexColorDescriptors,
            setGeometryVertexColorAttributes,
            buildGeometry,
            isFiniteArray,
            removeMaxNodeObject,
            getNodeParentObject,
            syncNodeParent,
            ensureTransformOnlyNode,
            applyTransform,
            applySelection,
            applyMaterialScalar,
        } = sceneSync;

        const sceneExtras = createSceneExtras({
            bridge,
            countMaterialTextureSlots,
            buildGeometry,
            markLightProbeSceneDirty,
            scheduleLightProbeFromCurrentScene,
            schedulePathTracingLiveRebuild: (...args) => schedulePathTracingLiveRebuild(...args),
            updateSyncHud,
            maxjsDebugLog,
            getActiveCameraWorldPosition: (...args) => getActiveCameraWorldPosition(...args),
            get hairMeshes() { return hairMeshes; },
            set hairMeshes(value) { hairMeshes = value; },
            get forestMeshes() { return forestMeshes; },
            set forestMeshes(value) { forestMeshes = value; },
            get disposeSceneMaterial() { return disposeSceneMaterial; },
            get createMaterial() { return createMaterial; },
            get maxRoot() { return maxRoot; },
            get renderer() { return renderer; },
            get rendererBackendLabel() { return rendererBackendLabel; },
            get scene() { return scene; },
            get layerManager() { return layerManager; },
            get maxjsFx() { return maxjsFx; },
            get transportMode() { return transportMode; },
            get cameraPositionWorld() { return cameraPositionWorld; },
        });
        const {
            createHairBladeGeometry,
            disposeHairEntry,
            disposeHairInstances,
            applyHairTransform,
            applyHairVisibility,
            buildHairEntry,
            applyHairInstances,
            getForestBinaryFloatView,
            getForestGeometryPayload,
            getForestTransformPayload,
            setForestInstanceMatrix,
            writeForestInstanceMatrixAt,
            nextForestBuildFrame,
            disposeForestBuildMaterial,
            disposeForestBuildResources,
            usingWebGpuInstanceMaterials,
            copyInstanceTextureSlot,
            webGpuSafeInstanceMaterialDescriptor,
            dominantForestMaterialIndex,
            shouldCollapseForestMaterialsForWebGpu,
            createForestInstanceMaterial,
            applyForestInstances,
            createSmokePalette,
            createVolumeMesh,
            applyVolumes,
            updateVolumeUniforms,
        } = sceneExtras;

        const cameraSystem = createCameraSystem({
            bridge,
            updateSyncHud,
            getRenderOutputAspect,
            getViewportFrameRect,
            applySyncedCameraClip,
            applyCameraClipOverrides,
            applyRenderViewportLayout,
            updateCameraProjectionForViewportRect,
            copyMaxArrayToWorld,
            noteGiVolumeCameraSync,
            syncPostFxPanel: (...args) => syncPostFxPanel(...args),
            syncPathTracingDofFromPostFx: (...args) => syncPathTracingDofFromPostFx(...args),
            maxjsDebugLog,
            isFiniteArray,
            DEFAULT_CAMERA_NEAR,
            get camera() { return camera; },
            set camera(value) { camera = value; },
            get controls() { return controls; },
            set controls(value) { controls = value; },
            get camLock() { return camLock; },
            set camLock(value) { camLock = value; },
            get physicalCameraDofActive() { return physicalCameraDofActive; },
            set physicalCameraDofActive(value) { physicalCameraDofActive = value; },
            get renderToImageActive() { return renderToImageActive; },
            get pendingRenderToImage() { return pendingRenderToImage; },
            get safeFrameEnabled() { return safeFrameEnabled; },
            get scene() { return scene; },
            get perspCamera() { return perspCamera; },
            get orthoCamera() { return orthoCamera; },
            get cameraTargetWorld() { return cameraTargetWorld; },
            get cameraDefaultDirection() { return cameraDefaultDirection; },
            get maxjsFx() { return maxjsFx; },
            get webglBasicFx() { return webglBasicFx; },
            get shaderLabFx() { return shaderLabFx; },
            get pathTracingFx() { return pathTracingFx; },
            get layerManager() { return layerManager; },
            get xrRuntime() { return xrRuntime; },
            get nodeMap() { return nodeMap; },
        });
        const {
            updateSceneCameraList,
            syncCameraLockButtonUi,
            applyLayerCameraMode,
            getCameraProjectionAspect,
            applyCameraProjectionFromMax,
            syncCameraConsumersAfterSwap,
            applyCamera,
            computeVisibleSceneBounds,
            serializeCurrentCameraState,
            applyStandaloneCameraState,
            fitCamera,
            syncOrbitNavigationFeel,
            getKnownSceneCameras,
        } = cameraSystem;

        hostBridge.installHostWiring();
        window.maxJS = bridge;
        bridge.materials = {
            getStats() {
                return { ...getMaterialRegistryStats() };
            },
            getEntries() {
                return getMaterialRegistryEntries();
            },
        };

        const DEFAULT_BAKE_STATE = Object.freeze({
            version: 1,
            enabled: false,
            mode: 'lightmap',
            match: 'scene',
            folder: '',
            sceneName: 'scene',
            lightSuffix: '_lightmap',
            beautySuffix: '_beauty',
            extension: 'png',
            intensity: 1.0,
            bakeExposure: 0,
            proxyDisplay: false,
        });
        let bakeOverrides = { ...DEFAULT_BAKE_STATE };

        const bakeSystem = createBakeSystem({
            DEFAULT_BAKE_STATE,
            maxMapChannelFromMapName,
            textureWithUvChannel,
            loadBakeTextureFromCandidates,
            bakeExposureScale,
            isDisplayBakedBeautyProxy,
            clearBakeTextureLoadFailures,
            isWebGLTexturePathActive,
            getTextureExtension,
            colorSpaceForTextureExtension,
            textureLoader,
            exrLoader,
            rgbeLoader,
            isCachedMaterialTemplate,
            rememberMaterialEmissiveBase,
            disposeSceneMaterial,
            ensureSceneRenderableMaterial,
            stampSceneMaterial,
            markLightProbeSceneDirty,
            scheduleLightProbeFromCurrentScene,
            requestHostAction,
            bytesToBase64,
            reportBridgeError,
            maxjsDebugWarn,
            get bakeOverrides() { return bakeOverrides; },
            set bakeOverrides(value) { bakeOverrides = value; },
            get rendererBackendLabel() { return rendererBackendLabel; },
            get nodeMap() { return nodeMap; },
            get layerManager() { return layerManager; },
            get maxjsFx() { return maxjsFx; },
            get lightLinking() { return lightLinkingRef; },
            get bridge() { return bridge; },
            get perfHud() { return perfHud; },
            get projectRuntime() { return _projectRuntimeRef; },
            get currentToneMapping() { return currentToneMapping; },
            get currentExposure() { return currentExposure; },
        });
        const {
            normalizeBakeState,
            serializeBakeState,
            serializeSnapshotBakeState,
            bakeStateSignature,
            stripWrappingQuotes,
            encodeAssetPath,
            normalizeBakeFolderUrl,
            sanitizeBakeFileStem,
            getMaterialBakeName,
            getBakeTargetName,
            getBakeTextureUrl,
            bakeFilenameHasExplicitUvChannel,
            getBakeFilenameCandidates,
            getBakeTextureCandidates,
            hasGeometryUV2,
            getBakeMaxMapChannel,
            hasGeometryMaxMapChannel,
            restoreWebGpuLightMapUvContext,
            applyWebGpuLightMapUvContext,
            markBakeMissingUv,
            clearBakeMissingUv,
            maybeRequestBakeUv2Resync,
            createBeautyBakeMaterial,
            bakeOverrideOwnerKey,
            stampBakeOverrideOwner,
            ensureBakeOverrideMaterialInstance,
            applyBakeOverrideToMaterial,
            applyBakeOverridesToSceneMaterial,
            withBakePersistenceSuppressed,
            escapeBakeHtml,
            getBakeSceneStats,
            getBakeUv2RequirementStats,
            mutateLightmapBakeOnMaterial,
            reapplyBakeOverridesToScene,
            applyBakeState,
            saveBakeState,
            restoreBakeState,
            syncProjectBakeState,
            setBakePanelVisible,
            readBakeStateFromPanel,
            updateBakePanelPreview,
            getBakeTargetPreviewRows,
            renderBakeTargetPreview,
            getAllBakeProxyTargets,
            loadProxySourceTexture,
            cloneProxyTextureForWebGL,
            getBakeProxyRenderer,
            stdToneMappingForCurrentMode,
            renderBakeTextureProxy,
            encodeBeautyBakeProxyMaps,
            isBakeTextInput,
            updateBakeStateFromPanel,
            rebuildBakePanel,
        } = bakeSystem;

        // ── Environment live update (standalone, change-only) ──
        bridge.on('env_update', msg => {
            let pathTraceSceneChanged = false;
            if (msg.env) {
                if (msg.env.sky) {
                    applySky(msg.env.sky);
                    markLightProbeSceneDirty();
                    scheduleLightProbeFromCurrentScene();
                    pathTraceSceneChanged = true;
                } else if (msg.env.hdri) {
                    removeSky();
                    loadHDRI(msg.env);
                    pathTraceSceneChanged = true;
                } else if (msg.env.enabled === false || msg.env.type === 'none') {
                    removeAuthoredEnvironment();
                    pathTraceSceneChanged = true;
                }
                maxjsFx.markEnvironmentChanged?.();
            }
            if (pathTraceSceneChanged) schedulePathTracingLiveRebuild();
        });




        // Audio param edits ride a standalone JSON message because the binary
        // delta's UpdateAudio command only carries transform + visibility.
        bridge.on('audio_update', msg => {
            if (Array.isArray(msg?.audios)) audioSystem?.applyAudioUpdates(msg.audios);
        });

        // Same pattern for glTF param edits (file path, rootScale, autoplay, displayName).
        // Binary UpdateGLTF carries transform + visibility only.
        bridge.on('gltf_update', msg => {
            if (Array.isArray(msg?.gltfs)) gltfSystem?.applyGLTFUpdates(msg.gltfs);
        });

        // WebApp Animator param channels (curve-driven) + page/size edits.
        // Binary UpdateWebApp carries transform + visibility only.
        bridge.on('webapp_update', msg => {
            if (Array.isArray(msg?.webapps)) webappSystem?.applyWebAppUpdates(msg.webapps);
        });

        const lightsSystem = createLights({
            MAXJS_SELF_HIDDEN_LAYER,
            LIGHT_LINK_STORAGE_KEY,
            setObjectSelfVisibleLayer,
            syncDefaultLightsVisibility,
            markLightProbeLightsDirty,
            scheduleLightProbeFromCurrentScene,
            refreshSkyFromLinkedSun,
            saveStudioState: (...args) => saveStudioState(...args),
            isSimpleWebGLPipelineActive: (...args) => isSimpleWebGLPipelineActive(...args),
            restartWithRendererBackend: (...args) => restartWithRendererBackend(...args),
            setSpectralView: (...args) => setSpectralView(...args),
            get isPathTracingMode() { return isPathTracingMode; },
            hasActiveLightLinks: () => lightLinkingRef?.hasActiveLinks?.() === true,
            get defaultLights() { return defaultLights; },
            get defaultAmbient() { return defaultAmbient; },
            get defaultKey() { return defaultKey; },
            get defaultFill() { return defaultFill; },
            get lightHandleMap() { return lightHandleMap; },
            get lightHelpersVisible() { return lightHelpersVisible; },
            set lightHelpersVisible(value) { lightHelpersVisible = value; },
            get lastLightsSignature() { return lastLightsSignature; },
            set lastLightsSignature(value) { lastLightsSignature = value; },
            get lightLinkPanelVisible() { return lightLinkPanelVisible; },
            set lightLinkPanelVisible(value) { lightLinkPanelVisible = value; },
            get nodeMap() { return nodeMap; },
            get maxInstanceBuckets() { return maxInstanceBuckets; },
            setLightLinkTargetHandles,
            get maxRoot() { return maxRoot; },
            get scene() { return scene; },
            get camera() { return camera; },
            get maxjsFx() { return maxjsFx; },
            get layerManager() { return layerManager; },
            get isStudioMode() { return isStudioMode; },
            get perfHud() { return perfHud; },
        });
        const {
            setDefaultLightsVisible,
            isShadowMapOriginObject,
            getShadowMapOriginRadiusFromName,
            configureShadowMapOriginObject,
            findShadowMapOriginObject,
            getShadowMapOriginFocus,
            getShadowSceneFocus,
            setObjectWorldPosition,
            applyDirectionalShadowOrigin,
            updateLightShadowCamera,
            createLightHelper,
            clearLightHelpers,
            updateLightHelpers,
            setLightHelpersVisible,
            clearLights,
            getLightParentObject,
            syncLightParent,
            setLightPositionFromMaxRoot,
            setLightTargetFromData,
            applyLightEmitterClass,
            applyLightData,
            createLightFromData,
            finalizeLightState,
            sceneLightsSignature,
            applyLights,
            lightLinking,
            setLightLinkPanelVisible,
            rebuildLightLinkPanel,
            applyLightUpdates,
        } = lightsSystem;
        lightLinkingRef = lightLinking;
        setDefaultLightsVisible(true);

        let asciiActive = false;
        let asciiEffect = null;
        let asciiSettings = { resolution: 0.15, color: 'white', invert: false };
        let postPanelVisible = false;
        let _layerManagerRef = null;
        let _projectRuntimeRef = null;

        const panelsMisc = createPanelsMisc({
            applyFrameElementStyle,
            getViewportFrameRect,
            syncPostFxPanel: (...args) => syncPostFxPanel(...args),
            syncCameraLockButtonUi,
            applyLocalHDRIToScene,
            syncEnvironmentDisplay,
            applyLightProbeState,
            refreshLightProbeFromCurrentHDRI,
            savePostFxState: (...args) => savePostFxState(...args),
            setAudioMuted,
            hexColorInputValue,
            parseHexColorInput,
            setBackgroundColor,
            maxjsDebugWarn,
            reportBridgeError,
            syncProjectBakeState: (...args) => syncProjectBakeState(...args),
            syncProjectPostFxState: (...args) => syncProjectPostFxState(...args),
            setLightHelpersVisible,
            applyPathTracingSettings: (...args) => applyPathTracingSettings(...args),
            setSpectralView: (...args) => setSpectralView(...args),
            setLightLinkPanelVisible,
            rebuildLightLinkPanel,
            MAXJS_MODE_KEY,
            maxjsRenderMode,
            get renderer() { return renderer; },
            get scene() { return scene; },
            get controls() { return controls; },
            get maxjsFx() { return maxjsFx; },
            get shaderLabFx() { return shaderLabFx; },
            get perfHud() { return perfHud; },
            get renderToImageActive() { return renderToImageActive; },
            get bridge() { return bridge; },
            get lightLinking() { return lightLinking; },
            get lightLinkPanelVisible() { return lightLinkPanelVisible; },
            get isStudioMode() { return isStudioMode; },
            isSimpleWebGLPipelineActive: (...args) => isSimpleWebGLPipelineActive(...args),
            isWebGLPipelineActive: (...args) => isWebGLPipelineActive(...args),
            isWgl2FallbackBackendActive: (...args) => isWgl2FallbackBackendActive(...args),
            get spectralView() { return spectralView; },
            get isPathTracingMode() { return isPathTracingMode; },
            get pathTracingSettings() { return pathTracingSettings; },
            get ptPauseUiSync() { return ptPauseUiSync; },
            set ptPauseUiSync(value) { ptPauseUiSync = value; },
            get lightProbeEnabled() { return lightProbeEnabled; },
            set lightProbeEnabled(value) { lightProbeEnabled = value; },
            get camLock() { return camLock; },
            set camLock(value) { camLock = value; },
            get envVisible() { return envVisible; },
            set envVisible(value) { envVisible = value; },
            get lightMode() { return lightMode; },
            set lightMode(value) { lightMode = value; },
            get audioMuted() { return audioMuted; },
            get hiddenBackgroundColor() { return hiddenBackgroundColor; },
            get compositionOverlay() { return compositionOverlay; },
            get _layerManagerRef() { return _layerManagerRef; },
            set _layerManagerRef(value) { _layerManagerRef = value; },
            get _projectRuntimeRef() { return _projectRuntimeRef; },
            set _projectRuntimeRef(value) { _projectRuntimeRef = value; },
            get projectRuntime() { return projectRuntime; },
            get webappSystem() { return webappSystem; },
            get lightHelpersVisible() { return lightHelpersVisible; },
            get postPanelVisible() { return postPanelVisible; },
            set postPanelVisible(value) { postPanelVisible = value; },
            get asciiActive() { return asciiActive; },
            set asciiActive(value) { asciiActive = value; },
            get asciiEffect() { return asciiEffect; },
            set asciiEffect(value) { asciiEffect = value; },
            get asciiSettings() { return asciiSettings; },
            set asciiSettings(value) { asciiSettings = value; },
            isLocalHdriActive: (...args) => isLocalHdriActive(...args),
        });
        const {
            setRailButtonMeta,
            setViewportMenuItemHidden,
            syncAudioMuteButtonUi,
            syncBackgroundColorSlot,
            syncEnvButtonUi,
            enterAsciiMode,
            exitAsciiMode,
            rebuildAsciiEffect,
            setReflPaintPanelVisible,
            serializeStudioState,
            saveStudioState,
            restoreStudioState,
            syncProjectStudioState,
            isShaderLabBackendAvailable,
            syncShaderLabAvailability,
            attachLayerPanelSubscriptions,
            queueLayersPanelRefresh,
            queueWebPanelsRefresh,
            setRightDockWidth,
            clampDockWidth,
            btnLightProbe,
            btnPostFxPanel,
            rightDock,
            postPanel,
            isClayModeActive,
            setClayPreFxSnapshot,
        } = panelsMisc;
        syncRendererButtonUi();

        // ── Hair And Fur GPU Instancing ─────────────────────
        let hairMeshes = new Map(); // handle -> { root, mesh }

        // ── ForestPack GPU Instancing ───────────────────────
        let forestMeshes = new Map(); // key → InstancedMesh
        let renderToImageActive = false;
        let pendingRenderToImage = null;
        let renderToImageForcePathTracing = false;
        // Sticky across sequence frames (pendingRenderToImage clears between
        // them) so punch state doesn't flicker mid-sequence.
        let renderCaptureComposited = false;

        // ── UI Controls ─────────────────────────────────────
        document.getElementById('btnKill').onclick = () => {
            bridge.send('kill');
        };

        document.getElementById('btnRefresh').onclick = () => {
            if (window.chrome?.webview) {
                bridge.send('refresh');
            } else {
                location.reload();
            }
        };

        document.getElementById('btnSafeFrame')?.addEventListener('click', () => {
            safeFrameEnabled = !safeFrameEnabled;
            try {
                localStorage.setItem(SAFE_FRAME_STORAGE_KEY, safeFrameEnabled ? 'true' : 'false');
            } catch {}
            applyRenderViewportLayout({ resizeBuffers: true, resizePostFx: true });
            perfHud.setStatus(safeFrameEnabled
                ? 'max.js - safe frame crop on'
                : 'max.js - safe frame crop off');
        });
        syncSafeFrameButtonUi();

        const snapshotExport = createSnapshotExport({
            bridge,
            requestHostAction,
            toBase64Utf8,
            bytesToBase64,
            reportBridgeError,
            maxjsDebugWarn,
            setInfoText,
            serializeSnapshotUiState: (...args) => serializeSnapshotUiState(...args),
            serializeSnapshotBakeState: (...args) => serializeSnapshotBakeState(...args),
            isLocalHdriLoaded: (...args) => isLocalHdriLoaded(...args),
            get skyActive() { return skyActive; },
            get currentEnvParams() { return currentEnvParams; },
            get localHdriFile() { return localHdriFile; },
            get localHdriFileName() { return localHdriFileName; },
            get layerManager() { return layerManager; },
        });
        const {
            SNAPSHOT_SETTINGS_DEFAULTS,
            sanitizeSnapshotSettings,
            getSnapshotExportSettings,
            loadSnapshotSettings,
            saveSnapshotSettings,
            setSnapshotPanelVisible,
            updateSnapshotSetting,
            resetSnapshotSettings,
            buildSnapshotPanel,
            syncSnapshotPanel,
            escapeSnapshotDiagnosticHtml,
            snapshotDiagnosticRow,
            renderSnapshotDiagnosticsOverlay,
            closeSnapshotDiagnosticsOverlay,
            handleSnapshotDiagnosticsKeydown,
            showSnapshotDiagnosticsOverlay,
            analyzeSnapshotFromHost,
            exportSnapshotWithSettings,
            serveSnapshotWithSettings,
        } = snapshotExport;

        // Toon outline is automatic — no UI button needed

        // Tone mapping modes
        const DEFAULT_TONE_MAPPING = 'Neutral';
        const toneMappingModes = {
            'None': THREE.NoToneMapping,
            'Linear': THREE.LinearToneMapping,
            'Reinhard': THREE.ReinhardToneMapping,
            'Cineon': THREE.CineonToneMapping,
            'AgX': THREE.AgXToneMapping,
            'Neutral': THREE.NeutralToneMapping,
        };
        let currentToneMapping = DEFAULT_TONE_MAPPING;
        let currentExposure = 1.0;
        let currentAAMode = 'off'; // 'traa' | 'off' (MSAA option removed — was a no-op with the deferred MRT pipeline)

        const postFxGlue = createPostFxGlue({
            bridge,
            onShaderLabSnapshotChange,
            applyCameraClipOverrides,
            applyHaloGiState,
            applyHdriReflectionOnlyState,
            applyLightProbeState,
            applyLocalHDRISettings,
            applyLocalHDRIToScene,
            applyRendererPerformanceSettings,
            clampDockWidth,
            clampHaloGiNumber,
            clearLocalHDRI,
            computeVisibleSceneBounds,
            disposeMaxInstanceBuckets,
            disposeFlattenedGroups,
            enterAsciiMode,
            exitAsciiMode,
            formatHaloGiValue,
            getEffectivePixelRatio,
            getEffectivePostFxResolutionScale,
            getHaloGiSettings,
            isLocalHdriActive,
            loadLocalHDRIFile,
            maxjsDebugWarn,
            rebuildAsciiEffect,
            refreshLightProbeFromCurrentHDRI,
            reportBridgeError,
            resetHaloGiToDefaults,
            setBackgroundColor,
            setHaloGiSetting,
            setRightDockWidth,
            setShaderLabSnapshot,
            syncCameraLockButtonUi,
            syncEnvButtonUi,
            syncEnvironmentDisplay,
            syncHdriPanel,
            syncShaderLabAvailability,
            toggleLocalHDRI,
            updateShaderLabEnabled,
            serializeSnapshotUiState: (...args) => serializeSnapshotUiState(...args),
            DEFAULT_CAMERA_NEAR,
            DEFAULT_TONE_MAPPING,
            HALO_GI_NUMERIC_CONTROLS,
            PERFORMANCE_DEFAULTS,
            toneMappingModes,
            btnLightProbe,
            btnPostFxPanel,
            postPanel,
            rightDock,
            isClayModeActive,
            setClayPreFxSnapshot,
            get _projectRuntimeRef() { return _projectRuntimeRef; },
            get asciiActive() { return asciiActive; },
            get asciiSettings() { return asciiSettings; },
            set asciiSettings(value) { asciiSettings = value; },
            get camera() { return camera; },
            get cameraClip() { return cameraClip; },
            get camLock() { return camLock; },
            set camLock(value) { camLock = value; },
            get controls() { return controls; },
            get currentAAMode() { return currentAAMode; },
            set currentAAMode(value) { currentAAMode = value; },
            get currentExposure() { return currentExposure; },
            set currentExposure(value) { currentExposure = value; },
            get currentToneMapping() { return currentToneMapping; },
            set currentToneMapping(value) { currentToneMapping = value; },
            get envVisible() { return envVisible; },
            set envVisible(value) { envVisible = value; },
            get isStudioMode() { return isStudioMode; },
            get lastRenderTimestamp() { return lastRenderTimestamp; },
            set lastRenderTimestamp(value) { lastRenderTimestamp = value; },
            get lightMode() { return lightMode; },
            set lightMode(value) { lightMode = value; },
            get lightProbeEnabled() { return lightProbeEnabled; },
            set lightProbeEnabled(value) { lightProbeEnabled = value; },
            get localHdriBlur() { return localHdriBlur; },
            set localHdriBlur(value) { localHdriBlur = value; },
            get localHdriEnabled() { return localHdriEnabled; },
            set localHdriEnabled(value) { localHdriEnabled = value; },
            get localHdriFlip() { return localHdriFlip; },
            set localHdriFlip(value) { localHdriFlip = value; },
            get localHdriIntensity() { return localHdriIntensity; },
            set localHdriIntensity(value) { localHdriIntensity = value; },
            get localHdriReflectionOnly() { return localHdriReflectionOnly; },
            set localHdriReflectionOnly(value) { localHdriReflectionOnly = value; },
            get localHdriRotation() { return localHdriRotation; },
            set localHdriRotation(value) { localHdriRotation = value; },
            get localHdriShowBg() { return localHdriShowBg; },
            set localHdriShowBg(value) { localHdriShowBg = value; },
            get maxjsFx() { return maxjsFx; },
            get pathTracingFx() { return pathTracingFx; },
            get performanceSettings() { return performanceSettings; },
            set performanceSettings(value) { performanceSettings = value; },
            get perfHud() { return perfHud; },
            get postPanelVisible() { return postPanelVisible; },
            set postPanelVisible(value) { postPanelVisible = value; },
            get renderer() { return renderer; },
            get rendererBackendLabel() { return rendererBackendLabel; },
            get scene() { return scene; },
            get shaderLabFx() { return shaderLabFx; },
            get webglBasicFx() { return webglBasicFx; },
        });
        const {
            applyCoreToneMappingState,
            computePathTracingApertureRadius,
            syncPathTracingDofFromPostFx,
            buildPostFxPanel,
            syncPostFxPanel,
            savePostFxState,
            restorePostFxState,
            syncProjectPostFxState,
        } = postFxGlue;

        function serializeSnapshotFxState() {
            // Full state including powershot — the snapshot viewer replays it
            // via fx/final/powershot.js when runtimeFeatures.post_fx lists
            // 'powershot' (the exporter detects fx.powershot.enabled).
            return maxjsFx.getState();
        }

        function serializeSnapshotUiState({ includeDebug = false } = {}) {
            const snapshotRendererBackend = rendererBackendLabel;
            const authoredEnvironmentActive = !!(skyActive || currentEnvParams?.hdri);
            const payload = {
                buildMode: includeDebug ? 'dev' : 'release',
                rendererBackend: snapshotRendererBackend,
                toneMapping: currentToneMapping,
                exposure: currentExposure,
                aaMode: currentAAMode,
                envVisible,
                camLock,
                lightProbeEnabled,
                lightMode,
                background: hiddenBackgroundColor,
                fx: serializeSnapshotFxState(),
                webglBasicFx: webglBasicFx.getState?.(),
                camera: serializeCurrentCameraState(),
                hdri: {
                    rotation: localHdriRotation,
                    intensity: localHdriIntensity,
                    showBg: envVisible,
                    blur: localHdriBlur,
                    flip: localHdriFlip,
                    reflectionOnly: localHdriReflectionOnly,
                    enabled: authoredEnvironmentActive ? false : localHdriEnabled,
                    fileName: !authoredEnvironmentActive && isLocalHdriLoaded() ? localHdriFileName : '',
                },
                haloGi: serializeHaloGiState(),
                performance: {
                    fpsCap: performanceSettings.fpsCap,
                    renderScale: performanceSettings.renderScale,
                    postFxScale: getEffectivePostFxResolutionScale(),
                    optimizeMaxInstances: performanceSettings.optimizeMaxInstances,
                    maxInstanceBucketThreshold: performanceSettings.maxInstanceBucketThreshold,
                    flattenGroups: performanceSettings.flattenGroups === true,
                },
                cameraClip: { near: cameraClip.near, far: cameraClip.far },
                ascii: { enabled: asciiActive, ...asciiSettings },
                shaderLab: getShaderLabSnapshot(),
                studio: (isStudioMode || lightLinking.hasPortableState())
                    ? serializeStudioState()
                    : null,
                bake: serializeBakeState(),
                timeline: {
                    fps: maxTimeline.fps(),
                    startFrame: 0,
                    endFrame: 0,
                    defaultPlaying: true,
                },
            };
            if (includeDebug) {
                payload.debug = {
                    buildMode, debugMode, standalone: isStandalone,
                    backend: snapshotRendererBackend,
                    nodeMapSize: nodeMap.size,
                    memory: renderer?.info?.memory ?? null,
                };
            }
            return payload;
        }


        buildPostFxPanel();
        // NOTE: Do NOT call syncPostFxPanel here — it would save defaults and overwrite stored settings.
        // restoreInteractiveBrowserState() handles restore then sync.

        // ── Resize + Render ─────────────────────────────────
        // WebGPU pipelines bound to the canvas swap chain get duplicated every
        // time canvas.width / canvas.height change (forces context reconfigure
        // and orphans the old swap-chain textures the pipelines reference).
        // `renderer.setSize` touches canvas.width — so dragging a panel resize
        // handle at 60fps used to fire 60 full pipeline rebuilds across every
        // post-FX pass. The Inspector's "(not in use)" cascade on every pass
        // was that churn being observed in-flight.
        //
        // Strategy: update camera + CSS immediately so the canvas visually
        // tracks the drag (browser scales stale pixels smoothly), but defer
        // the drawing-buffer resize + post-FX rebuild until dragging settles.
        // One pipeline churn event per resize gesture instead of dozens.
        let resizeTimer = null;
        addEventListener('resize', () => {
            // CSS-only update keeps the canvas visually filling the viewport
            // during drag. No drawing-buffer resize → no swap chain churn.
            applyRenderViewportLayout({ resizeBuffers: false, resizePostFx: false });
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                applyRendererPerformanceSettings({ resizePostFx: false });
                maxjsFx.resize();
                webglBasicFx.resize?.();
            }, 150);
        });

        // ── Headset runtime ──────────────────────────────────
        // Fragile integration: this path is intentionally isolated from snapshots/export
        // and has only been tested on Quest 3 via Virtual Desktop (VDXR).
        const xrRuntime = !window.chrome?.webview
            ? { active: false, shouldBypassPostFx: false, update() {} }
            : createWebXRRuntime({
                renderer, scene, controls, perfHud, cameraDefaultPosition,
                rendererBackendLabel, computeVisibleSceneBounds,
                isWgl2FallbackBackendActive,
                get camera() { return camera; },
                get camLock() { return camLock; },
            });

        // "Enter VR" menu button: proxies the (hidden) three.js XRButton and
        // mirrors its state. VR is hidden in the simple WebGL pipeline and only
        // surfaced for renderer modes where we intentionally support it.
        (function wireEnterVrButton() {
            const vrBtn = document.getElementById('btnEnterVR');
            if (!vrBtn) return;
            const vrRow = vrBtn.closest('.vpmenu-row');
            const vrLabel = vrBtn.closest('.vpmenu-row')?.querySelector('.vpmenu-label');
            const setLabel = (text) => { if (vrLabel) vrLabel.textContent = text; };
            function syncVrState() {
                if (isWebGLPipelineActive()) {
                    setViewportMenuItemHidden(vrRow, true);
                    vrBtn.disabled = true;
                    vrBtn.classList.add('is-gated');
                    vrBtn.classList.remove('active');
                    vrBtn.title = 'VR is unavailable in the WebGL/pathtracing pipeline';
                    setLabel('VR Unavailable');
                    return;
                }
                setViewportMenuItemHidden(vrRow, false);
                const xrButton = xrRuntime?.xrButton;
                const ready = !!xrRuntime?.supportsXR && !!xrButton && xrButton.isConnected;
                if (!ready) {
                    setViewportMenuItemHidden(vrRow, !isWgl2FallbackBackendActive());
                    vrBtn.disabled = true;
                    vrBtn.classList.add('is-gated');
                    vrBtn.classList.remove('active');
                    vrBtn.title = 'VR unavailable — needs a supported WebGL pipeline and a headset';
                    setLabel('VR Unavailable');
                    return;
                }
                setViewportMenuItemHidden(vrRow, false);
                vrBtn.disabled = false;
                vrBtn.classList.remove('is-gated');
                const presenting = !!renderer.xr?.isPresenting
                    || String(xrButton.textContent || '').trim().toUpperCase().includes('EXIT');
                vrBtn.classList.toggle('active', presenting);
                vrBtn.title = presenting ? 'Exit VR' : 'Enter VR';
                setLabel(presenting ? 'Exit VR' : 'Enter VR');
            }
            vrBtn.addEventListener('click', () => {
                const xrButton = xrRuntime?.xrButton;
                if (xrButton && !vrBtn.disabled) xrButton.click();
            });
            if (xrRuntime?.xrButton && typeof MutationObserver === 'function') {
                new MutationObserver(syncVrState).observe(xrRuntime.xrButton, {
                    childList: true, characterData: true, subtree: true,
                });
            }
            renderer.xr?.addEventListener?.('sessionstart', syncVrState);
            renderer.xr?.addEventListener?.('sessionend', syncVrState);
            // Initial + after three.js resolves async support detection.
            syncVrState();
            setTimeout(syncVrState, 600);
            setTimeout(syncVrState, 2100);
        })();

        const renderLoop = createRenderLoop({
            GI_VOLUME_CAMERA_DEBOUNCE_MS,
            flushMaterialDisposals: (...args) => flushMaterialDisposals(...args),
            updateSkyTime: (...args) => updateSkyTime(...args),
            syncOrbitNavigationFeel: (...args) => syncOrbitNavigationFeel(...args),
            scheduleGiVolumeFromCurrentScene: (...args) => scheduleGiVolumeFromCurrentScene(...args),
            syncPathTracingDofFromPostFx: (...args) => syncPathTracingDofFromPostFx(...args),
            getActiveCameraWorldPosition: (...args) => getActiveCameraWorldPosition(...args),
            updateVolumeUniforms: (...args) => updateVolumeUniforms(...args),
            updateLightHelpers: (...args) => updateLightHelpers(...args),
            removeWebGPUIncompatibleSceneMaterials: (...args) => removeWebGPUIncompatibleSceneMaterials(...args),
            isPathTracingViewActive: (...args) => isPathTracingViewActive(...args),
            renderPathTracingFallbackFrame: (...args) => renderPathTracingFallbackFrame(...args),
            canStartPathTracingNow: (...args) => canStartPathTracingNow(...args),
            bridgeHasInitialSync: (...args) => bridgeHasInitialSync(...args),
            renderPathTracingLiveFrame: (...args) => renderPathTracingLiveFrame(...args),
            reportBridgeError: (...args) => reportBridgeError(...args),
            updateGiVolumeIdleWork: (...args) => updateGiVolumeIdleWork(...args),
            syncGiVolumeActive: (...args) => syncGiVolumeActive(...args),
            updateProbeHelpers: (...args) => updateProbeHelpers(...args),
            renderCurrentFrameOnce: (...args) => renderCurrentFrameOnce(...args),
            sendCurrentCanvasRenderFile: (...args) => sendCurrentCanvasRenderFile(...args),
            syncPostFxPanel: (...args) => syncPostFxPanel(...args),
            get webglBasicFx() { return webglBasicFx; },
            get renderer() { return renderer; },
            get scene() { return scene; },
            get camera() { return camera; },
            get maxjsFx() { return maxjsFx; },
            get renderToImageActive() { return renderToImageActive; },
            get pendingRenderToImage() { return pendingRenderToImage; },
            set pendingRenderToImage(value) { pendingRenderToImage = value; },
            get performanceSettings() { return performanceSettings; },
            get lastRenderTimestamp() { return lastRenderTimestamp; },
            set lastRenderTimestamp(value) { lastRenderTimestamp = value; },
            get inlineTimer() { return inlineTimer; },
            get inlineClock() { return inlineClock; },
            get xrRuntime() { return xrRuntime; },
            get animationSystem() { return animationSystem; },
            get controls() { return controls; },
            get physicalCameraDofActive() { return physicalCameraDofActive; },
            get defaultLights() { return defaultLights; },
            get defaultKey() { return defaultKey; },
            get cameraPositionWorld() { return cameraPositionWorld; },
            get lightLinking() { return lightLinking; },
            get lightHelpersVisible() { return lightHelpersVisible; },
            get layerManager() { return layerManager; },
            get audioSystem() { return audioSystem; },
            get gltfSystem() { return gltfSystem; },
            get perfHud() { return perfHud; },
            get webappSystem() { return webappSystem; },
            get renderCaptureComposited() { return renderCaptureComposited; },
            get pathTracingFx() { return pathTracingFx; },
            get pathTracingRasterWarmupFrames() { return pathTracingRasterWarmupFrames; },
            set pathTracingRasterWarmupFrames(value) { pathTracingRasterWarmupFrames = value; },
            get asciiActive() { return asciiActive; },
            get asciiEffect() { return asciiEffect; },
            get haloGiLastInteractionMs() { return haloGiLastInteractionMs; },
            set haloGiLastInteractionMs(value) { haloGiLastInteractionMs = value; },
            get haloGi() { return haloGi; },
            get isPathTracingMode() { return isPathTracingMode; },
            get css3dOverlay() { return css3dOverlay; },
            get blobOverlayCtx() { return blobOverlayCtx; },
            get blobOverlayCvs() { return blobOverlayCvs; },
            get latestAppliedSyncSerial() { return latestAppliedSyncSerial; },
            get pendingTextureLoads() { return pendingTextureLoads; },
            get renderToImageForcePathTracing() { return renderToImageForcePathTracing; },
            set renderToImageForcePathTracing(value) { renderToImageForcePathTracing = value; },
            get bridge() { return bridge; },
            get postPanelVisible() { return postPanelVisible; },
            get debugMode() { return debugMode; },
            get buildMode() { return buildMode; },
        });
        const { renderViewerFrame, renderFrame } = renderLoop;

        // ── JS_Inline Layer Manager ──────────────────────────
        const inlineTimer = new THREE.Timer();
        inlineTimer.connect?.(document);
        const inlineClock = inlineTimer;
        let lightLinkSceneRefreshQueued = false;
        const queueLightLinkSceneRefresh = () => {
            if (lightLinkSceneRefreshQueued) return;
            lightLinkSceneRefreshQueued = true;
            queueMicrotask(() => {
                lightLinkSceneRefreshQueued = false;
                lightLinking.refreshSceneBindings?.();
            });
        };
        const layerManager = createLayerManager({
            scene,
            camera,
            renderer,
            THREE,
            nodeMap,
            lightHandleMap,
            maxRoot,
            jsRoot,
            overlayRoot,
            space: sceneSpace,
            controls,
            getCamera: () => camera,
            getCameraTarget: (target) => target?.copy(cameraTargetWorld) ?? cameraTargetWorld.clone(),
            getSceneCameras: () => getKnownSceneCameras(),
            onCameraModeChange: applyLayerCameraMode,
            getGLTFSystem: () => gltfSystem,
            getAnimationSystem: () => animationSystem,
            getAudioSystem: () => audioSystem,
            whenSceneReady: () => hostBridge.whenInitialSync(),
            debugLog: maxjsDebugLog,
            debugWarn: maxjsDebugWarn,
            onRuntimeSceneChanged: () => {
                queueLightLinkSceneRefresh();
                maxjsFx.markSceneChanged?.();
                markLightProbeSceneDirty();
                scheduleLightProbeFromCurrentScene({ delay: 350 });
                schedulePathTracingLiveRebuild();
            },
        });
        jsmodVisibilityOwnedByLayer = (handle) => layerManager.hasRuntimeVisibilityOverride(handle);
        animationSystem = createMaxJSAnimationSystem({
            THREE,
            nodeMap,
            lightHandleMap,
            getCamera: () => camera,
            getControls: () => controls,
            getJsRoot: () => jsRoot,
            getOverlayRoot: () => overlayRoot,
            getViewportAspect: () => getCameraProjectionAspect(),
            buildGeometry,
            applyMaterialScalar,
        });
        audioSystem = createMaxJSAudioSystem({
            THREE,
            parent: maxBasisRoot,
            getActiveCamera: () => renderer.xr?.isPresenting ? renderer.xr.getCamera(camera) : camera,
        });
        setAudioMuted(audioMuted, { persist: false });
        gltfSystem = createMaxJSGLTFSystem({
            THREE,
            parent: maxBasisRoot,
            getBus: () => layerManager?.getBus?.(),
            debugWarn: maxjsDebugWarn,
        });
        layerManager.subscribe?.(() => {
            animationSystem.invalidateTargets();
            queueLightLinkSceneRefresh();
            // Layer mutations can add/remove meshes — cheap scene refresh.
            maxjsFx.markSceneChanged?.();
            markLightProbeSceneDirty();
            scheduleLightProbeFromCurrentScene({ delay: 350 });
            schedulePathTracingLiveRebuild();
        });
        const projectRuntime = window.chrome?.webview
            ? createProjectRuntime({ layerManager, bridge, perfHud, debugLog: maxjsDebugLog, debugWarn: maxjsDebugWarn })
            : null;
        if (projectRuntime) {
            layerManager.bindProjectRuntime(projectRuntime);
        }
        webappSystem = createMaxJSWebAppSystem({
            THREE,
            parent: maxBasisRoot,
            getProjectBaseUrl: () => projectRuntime?.getState?.().projectRootUrl || '',
            onPunchRectsChanged: (rects) => maxjsFx.setWebPanelPunchRects?.(rects),
        });
        webappSystem.subscribe(() => queueWebPanelsRefresh());
        window.maxJS.webapps = webappSystem;
        window.maxJSProjectRuntime = projectRuntime;
        window.maxJS.layers = layerManager;
        window.maxJS.animation = animationSystem;
        window.maxJS.time = maxTimeline;
        window.maxJS.audio = audioSystem;
        window.maxJS.gltf = gltfSystem;
        _layerManagerRef = layerManager;
        _projectRuntimeRef = projectRuntime;
        attachLayerPanelSubscriptions();
        queueLayersPanelRefresh();


        const renderCapture = createRenderCapture({
            PATH_TRACING_CAPTURE_DEFAULT_SAMPLES,
            PATH_TRACING_TEXTURE_WAIT_MS,
            getActiveCameraWorldPosition: (...args) => getActiveCameraWorldPosition(...args),
            updateVolumeUniforms: (...args) => updateVolumeUniforms(...args),
            isPathTracingViewActive: (...args) => isPathTracingViewActive(...args),
            renderPathTracingLiveFrame: (...args) => renderPathTracingLiveFrame(...args),
            renderViewerFrame: (...args) => renderViewerFrame(...args),
            reportBridgeError: (...args) => reportBridgeError(...args),
            getEnvironmentBackgroundMap: (...args) => getEnvironmentBackgroundMap(...args),
            isLocalHdriActive: (...args) => isLocalHdriActive(...args),
            applyLocalHDRIToScene: (...args) => applyLocalHDRIToScene(...args),
            resetPathTracingStartupWarmup: (...args) => resetPathTracingStartupWarmup(...args),
            applyFrameElementStyle: (...args) => applyFrameElementStyle(...args),
            applyRendererPerformanceSettings: (...args) => applyRendererPerformanceSettings(...args),
            syncEnvButtonUi: (...args) => syncEnvButtonUi(...args),
            syncEnvironmentDisplay: (...args) => syncEnvironmentDisplay(...args),
            syncPathTracingDofFromPostFx: (...args) => syncPathTracingDofFromPostFx(...args),
            get bridge() { return bridge; },
            get renderer() { return renderer; },
            get webappSystem() { return webappSystem; },
            get maxjsFx() { return maxjsFx; },
            get scene() { return scene; },
            get camera() { return camera; },
            get controls() { return controls; },
            get xrRuntime() { return xrRuntime; },
            get physicalCameraDofActive() { return physicalCameraDofActive; },
            get defaultLights() { return defaultLights; },
            get defaultKey() { return defaultKey; },
            get cameraPositionWorld() { return cameraPositionWorld; },
            get inlineClock() { return inlineClock; },
            get layerManager() { return layerManager; },
            get animationSystem() { return animationSystem; },
            get gltfSystem() { return gltfSystem; },
            get renderToImageForcePathTracing() { return renderToImageForcePathTracing; },
            set renderToImageForcePathTracing(value) { renderToImageForcePathTracing = value; },
            get renderToImageActive() { return renderToImageActive; },
            set renderToImageActive(value) { renderToImageActive = value; },
            get webglBasicFx() { return webglBasicFx; },
            get pathTracingSettings() { return pathTracingSettings; },
            get pendingRenderToImage() { return pendingRenderToImage; },
            set pendingRenderToImage(value) { pendingRenderToImage = value; },
            get latestAppliedSyncSerial() { return latestAppliedSyncSerial; },
            get envVisible() { return envVisible; },
            set envVisible(value) { envVisible = value; },
            get hiddenBackgroundColor() { return hiddenBackgroundColor; },
            get performanceSettings() { return performanceSettings; },
            set performanceSettings(value) { performanceSettings = value; },
            get localHdriShowBg() { return localHdriShowBg; },
            set localHdriShowBg(value) { localHdriShowBg = value; },
            get pathTracingFx() { return pathTracingFx; },
            get renderCaptureComposited() { return renderCaptureComposited; },
            set renderCaptureComposited(value) { renderCaptureComposited = value; },
        });
        const {
            sendCurrentCanvasRenderFile,
            cleanupCss3dMaskDomLeaks,
            renderCss3dMaskFrame,
            sendCss3dMaskPng,
            renderCurrentFrameOnce,
            beginRenderImageFrame,
            finishRenderImageFrame,
        } = renderCapture;

        // ── Build mode / Standalone / Debug ──
        // buildMode / isStandalone / urlMode are initialized near perfHud (early).
        // three.js r185 Inspector — lazily created, gated by debug mode.
        let threeInspector = null;
        function placeThreeInspectorToggle() {
            const shell = threeInspector?.domElement;
            const toggle = shell?.querySelector?.('#profiler-toggle');
            const miniPanel = shell?.querySelector?.('#profiler-mini-panel');
            if (toggle) {
                toggle.style.top = 'auto';
                toggle.style.right = 'auto';
                toggle.style.bottom = '15px';
                toggle.style.left = '15px';
            }
            if (miniPanel) {
                miniPanel.style.top = 'auto';
                miniPanel.style.right = 'auto';
                miniPanel.style.bottom = '60px';
                miniPanel.style.left = '15px';
            }
        }
        function syncInspector() {
            if (debugMode && buildMode !== 'release') {
                if (!threeInspector) {
                    threeInspector = new Inspector();
                    renderer.inspector = threeInspector;
                    const parent = renderer.domElement.parentElement;
                    if (parent && !threeInspector.domElement.parentElement) {
                        parent.appendChild(threeInspector.domElement);
                    }
                    placeThreeInspectorToggle();
                }
                threeInspector.domElement.style.display = '';
                placeThreeInspectorToggle();
            } else if (threeInspector) {
                threeInspector.domElement.style.display = 'none';
            }
        }

        async function restoreInteractiveBrowserState() {
            restorePostFxState();
            syncPostFxPanel(true, { persist: false });

            const file = await restoreStashedHdri();
            if (file && !isLocalHdriLoaded()) loadLocalHDRIFile(file, { preserveEnabled: true, persist: false });
        }

        function applyBuildMode() {
            const hud = document.getElementById('hud');
            const rail = document.getElementById('viewportMenu');
            const railHandle = document.querySelector('.rail-drag-handle');
            const dockHandle = document.querySelector('.dock-drag-handle');
            const info = document.getElementById('info');
            const debugBtn = document.getElementById('btnDebug');
            // Perf HUD + sync stats: only when not in static release mode (localStorage debug alone must not cost frames).
            perfHud.setDebugEnabled(debugMode && buildMode !== 'release');
            if (buildMode === 'release') {
                hud.style.display = 'none';
                if (rail) rail.style.display = 'none';
                if (railHandle) railHandle.style.display = 'none';
                if (dockHandle) dockHandle.style.display = 'none';
                return;
            }
            hud.style.display = '';
            if (rail) rail.style.display = '';
            if (railHandle) railHandle.style.display = '';
            if (dockHandle) dockHandle.style.display = '';
            info.style.display = debugMode ? '' : 'none';
            debugBtn.classList.toggle('active', debugMode);
            syncInspector();
        }

        function setDebugMode(enabled) {
            debugMode = enabled;
            try { localStorage.setItem(DEBUG_STORAGE_KEY, String(debugMode)); } catch {}
            applyBuildMode();
        }

        void restoreInteractiveBrowserState();

        addEventListener('focus', () => {
            lastRenderTimestamp = 0;
            syncPostFxPanel(true, { persist: false });
        });
        addEventListener('blur', () => {
            lastRenderTimestamp = 0;
            syncPostFxPanel(true, { persist: false });
        });
        document.addEventListener('visibilitychange', () => {
            lastRenderTimestamp = 0;
            syncPostFxPanel(true, { persist: false });
        });

        if (buildMode !== 'release') {
            const debugBtn = document.getElementById('btnDebug');
            debugBtn.style.display = '';
            debugBtn.onclick = () => setDebugMode(!debugMode);
        }

        installDockDragHide();

        applyBuildMode();

        renderer.setAnimationLoop(renderFrame);

        startBridgeHandshake();
