// scene_init.js — renderer + scene + camera + controls bootstrap for
// snapshot mode. Slim counterpart to the inline setup in web/index.html
// lines ~1565-1875.
//
// Snapshot-mode scope (intentional differences from live):
//   - No TSL_GL backend or headset runtime. Snapshots stay renderer-only.
//   - No backend persistence (the snapshot wrapper declares the target).
//   - No editor performance panel coupling — uses devicePixelRatio at 1×scale.
//   - No grid helper, no postfx panel.
//
// Returns concrete handles only — no facades. The applier and layer manager
// later reach into these directly the same way they do in live mode.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { copyMaxComponentsToWorld } from './max_basis.js';

// ─── Renderer ─────────────────────────────────────────────────────────

export function measureCanvasSize(canvas, width, height) {
    const rect = canvas?.getBoundingClientRect?.();
    const fallbackWidth = globalThis.innerWidth || canvas?.clientWidth || canvas?.width || 1;
    const fallbackHeight = globalThis.innerHeight || canvas?.clientHeight || canvas?.height || 1;
    const rawWidth = Number.isFinite(width) && width > 0
        ? width
        : (rect?.width || canvas?.clientWidth || fallbackWidth);
    const rawHeight = Number.isFinite(height) && height > 0
        ? height
        : (rect?.height || canvas?.clientHeight || fallbackHeight);
    return {
        width: Math.max(1, Math.round(rawWidth)),
        height: Math.max(1, Math.round(rawHeight)),
    };
}

function configureRenderer(renderer, canvas) {
    const { width, height } = measureCanvasSize(canvas);
    renderer.setPixelRatio(devicePixelRatio || 1);
    renderer.setSize(width, height, /* updateStyle */ false);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
}

async function initializeRenderer(renderer) {
    if (typeof renderer.init === 'function') await renderer.init();
}

/**
 * Picks the renderer backend.
 *   backend === 'webgl'  → WebGLRenderer
 *   backend === 'webgpu' → WebGPURenderer, native WebGPU required
 *   default              → 'webgl'
 *
 * Always renders into the supplied canvas (no implicit DOM injection).
 */
export async function createRenderer(canvas, { backend = 'webgl' } = {}) {
    if (!canvas) throw new Error('createRenderer: canvas is required');

    const normalizedBackend = String(backend || 'webgl').toLowerCase().includes('webgpu')
        ? 'webgpu'
        : 'webgl';
    const renderer = normalizedBackend === 'webgpu'
        ? await createWebGpuRenderer(canvas)
        : createWebGlRenderer(canvas);
    configureRenderer(renderer, canvas);
    await initializeRenderer(renderer);

    if (normalizedBackend === 'webgpu' && renderer.backend?.isWebGPUBackend !== true) {
        renderer.dispose?.();
        throw new Error(
            '[scene_init] Native WebGPU is not available. ' +
            'Open snapshot.html for the WebGL deploy target instead.',
        );
    }

    return {
        renderer,
        backendLabel: normalizedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2',
    };
}

function createWebGlRenderer(canvas) {
    if (typeof THREE.WebGLRenderer !== 'function') {
        throw new Error('[scene_init] THREE.WebGLRenderer is not available in this snapshot wrapper.');
    }
    return new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
}

async function createWebGpuRenderer(canvas) {
    if (typeof THREE.WebGPURenderer !== 'function') {
        throw new Error(
            '[scene_init] THREE.WebGPURenderer is not available in this snapshot wrapper. ' +
            'Use snapshot_webgpu.html for the WebGPU deploy target.',
        );
    }
    if (!globalThis.navigator?.gpu) {
        throw new Error(
            '[scene_init] Native WebGPU is not available. ' +
            'Open snapshot.html for the WebGL deploy target instead.',
        );
    }
    const adapter = await globalThis.navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
    }).catch(() => null);
    if (!adapter) {
        throw new Error(
            '[scene_init] Native WebGPU adapter is not available. ' +
            'Open snapshot.html for the WebGL deploy target instead.',
        );
    }
    return new THREE.WebGPURenderer({
        canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
}

// ─── Scene + groups + cameras + controls ──────────────────────────────

const MAXJS_LAYER_SSR_EXCLUDE = 1; // Mirrors index.html constant. Keep in sync.

const DARK_BG = 0x353535;

/**
 * Creates the canonical max.js scene topology:
 *
 *   scene
 *     └── maxBasisRoot   (rotation.x = -PI/2 — Max Z-up → Three Y-up)
 *           ├── maxRoot       (synced Max content)
 *           └── overlayRoot   (HUD-like world content rendered on top)
 *     └── jsRoot          (runtime-owned, Y-up native)
 *
 * Returns concrete handles plus a perspective camera, OrbitControls, a
 * default-lights group (hidden until the applier decides whether to show
 * it), and a `resize(width, height)` helper.
 */
export function createScene({ renderer, canvas } = {}) {
    if (!renderer) throw new Error('createScene: renderer is required');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(DARK_BG);

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

    // Camera — perspective only in snapshot mode (live mode supports an
    // ortho switch, but snapshots always export a single camera state).
    const cameraDefaultPosition = copyMaxComponentsToWorld(new THREE.Vector3(), 200, -200, 150);

    const initialSize = measureCanvasSize(canvas ?? renderer.domElement);
    const camera = new THREE.PerspectiveCamera(60, initialSize.width / initialSize.height, 1, 100000);
    camera.up.set(0, 1, 0);
    camera.position.copy(cameraDefaultPosition);
    camera.layers.enable(MAXJS_LAYER_SSR_EXCLUDE);

    const controls = new OrbitControls(camera, canvas ?? renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = false;
    controls.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: null,
    };
    controls.zoomSpeed = 2.0;
    controls.rotateSpeed = 0.5;
    controls.panSpeed = 1.0;

    // Alt+MMB = orbit (3ds Max style). Uses capture phase to beat OrbitControls.
    const eventTarget = canvas ?? renderer.domElement;
    eventTarget.addEventListener('pointerdown', e => {
        if (e.button === 1 && controls.enabled) {
            controls.mouseButtons.MIDDLE = e.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
        }
    }, true);
    eventTarget.addEventListener('pointerup', e => {
        if (e.button === 1) controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    }, true);
    // Snapshot pages default to *interactive* — opposite of live mode where
    // cam-lock is on by default. Snapshots are demos; users expect to drag.
    controls.enabled = true;

    // Default light handles — intentionally inert. They preserve the old
    // fallback group/API shape without adding synthetic lighting to snapshots.
    const defaultLights = new THREE.Group();
    defaultLights.name = '__maxjs_default_lights__';
    defaultLights.visible = false;
    const defaultAmbient = new THREE.AmbientLight(0xffffff, 0.0);
    defaultAmbient.userData.volumetricBypass = true;
    defaultLights.add(defaultAmbient);
    const defaultKey = new THREE.DirectionalLight(0xffffff, 0.0);
    defaultKey.userData.volumetricBypass = true;
    defaultKey.castShadow = false;
    defaultKey.shadow.mapSize.set(2048, 2048);
    defaultKey.shadow.camera.near = 0.1;
    defaultKey.shadow.camera.far = 2000;
    defaultKey.shadow.camera.left = -500;
    defaultKey.shadow.camera.right = 500;
    defaultKey.shadow.camera.top = 500;
    defaultKey.shadow.camera.bottom = -500;
    defaultLights.add(defaultKey);
    scene.add(defaultLights);

    // Resize handler — call from the wrapper on window resize / canvas changes.
    function resize(width, height) {
        const { width: w, height: h } = measureCanvasSize(canvas ?? renderer.domElement, width, height);
        renderer.setPixelRatio(devicePixelRatio || 1);
        renderer.setSize(w, h, /* updateStyle */ false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        return { width: w, height: h, aspect: w / h };
    }

    return {
        scene,
        camera,
        controls,
        maxBasisRoot, maxRoot, jsRoot, overlayRoot,
        defaultLights, defaultKey, defaultAmbient,
        resize,
    };
}
