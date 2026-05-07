// scene_init.js — renderer + scene + camera + controls bootstrap for
// snapshot mode. Slim counterpart to the inline setup in web/index.html
// lines ~1565-1875.
//
// Snapshot-mode scope (intentional differences from live):
//   - No WebXR / VR backend. XR is explicitly out of snapshot parity.
//   - No backend persistence (snapshot.json declares the preference).
//   - No editor performance panel coupling — uses devicePixelRatio at 1×scale.
//   - No grid helper, no postfx panel.
//
// Returns concrete handles only — no facades. The applier and layer manager
// later reach into these directly the same way they do in live mode.

import * as THREE from 'three/webgpu';
import * as THREE_STD from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { copyMaxComponentsToWorld } from './max_basis.js';

// ─── Renderer ─────────────────────────────────────────────────────────

function configureRenderer(renderer, canvas) {
    renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight);
    renderer.setPixelRatio(devicePixelRatio || 1);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
}

async function initializeRenderer(renderer) {
    if (typeof renderer.init === 'function') await renderer.init();
}

function disposeRenderer(renderer) {
    try { renderer?.dispose?.(); } catch {}
}

/**
 * Picks the renderer backend.
 *   backend === 'webgl'  → WebGLRenderer
 *   backend === 'webgpu' → WebGPURenderer with forceWebGL fallback on init failure
 *   default              → 'webgpu'
 *
 * Always renders into the supplied canvas (no implicit DOM injection).
 */
export async function createRenderer(canvas, { backend = 'webgpu' } = {}) {
    if (!canvas) throw new Error('createRenderer: canvas is required');

    if (backend === 'webgl') {
        const renderer = new THREE_STD.WebGLRenderer({
            canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
        });
        configureRenderer(renderer, canvas);
        await initializeRenderer(renderer);
        return { renderer, backendLabel: 'WebGL2' };
    }

    // WebGPU path with forceWebGL fallback.
    let renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
    try {
        configureRenderer(renderer, canvas);
        await initializeRenderer(renderer);
        return { renderer, backendLabel: 'WebGPU' };
    } catch (error) {
        console.warn('[scene_init] WebGPU init failed, retrying with forceWebGL.', error);
        disposeRenderer(renderer);
        renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true, forceWebGL: true });
        configureRenderer(renderer, canvas);
        await initializeRenderer(renderer);
        return { renderer, backendLabel: 'WebGPU(forceWebGL)' };
    }
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

    const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100000);
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

    // Default lighting — hidden until phase 6 / 7 decides. Existence here so
    // an empty scene still has the option of showing something.
    const defaultLights = new THREE.Group();
    defaultLights.name = '__maxjs_default_lights__';
    defaultLights.visible = false;
    const defaultAmbient = new THREE.AmbientLight(0xffffff, 0.4);
    defaultAmbient.userData.volumetricBypass = true;
    defaultLights.add(defaultAmbient);
    const defaultKey = new THREE.DirectionalLight(0xffffff, 2.5);
    defaultKey.userData.volumetricBypass = true;
    defaultKey.castShadow = true;
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
        const w = width ?? innerWidth;
        const h = height ?? innerHeight;
        renderer.setSize(w, h, /* updateStyle */ false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
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
