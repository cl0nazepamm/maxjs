// webxr.js — WebXR session runtime for the editor viewport (WebGL pipelines
// only). Extracted verbatim from boot.js; XR is editor-only and explicitly out
// of snapshot parity. `deps.camera` / `deps.camLock` are getter properties —
// boot swaps the active camera (persp/ortho) and toggles the lock live, so
// they must be read at call time, never captured.
import * as THREE from 'three';
import { XRButton } from 'three/addons/webxr/XRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

function createWebXRRuntime(deps = {}) {
    const { renderer, scene, controls, perfHud, cameraDefaultPosition,
            rendererBackendLabel, computeVisibleSceneBounds,
            isWgl2FallbackBackendActive } = deps;
            const runtime = {
                active: false,
                supportsXR: false,
                shouldBypassPostFx: false,
                update() {},
            };

            if (renderer?.isWebGLRenderer !== true && !isWgl2FallbackBackendActive()) {
                return runtime;
            }
            if (!('xr' in navigator)) {
                return runtime;
            }

            try {
                renderer.xr.enabled = true;
                renderer.xr.setReferenceSpaceType?.('local-floor');
                runtime.supportsXR = true;

                const xrButton = XRButton.createButton(renderer, {
                    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
                });
                xrButton.style.zIndex = '100';
                const suppressUnsupportedButton = () => {
                    const text = String(xrButton.textContent || xrButton.innerText || '').trim().toUpperCase();
                    if (/XR NOT SUPPORTED|XR NOT ALLOWED|WEBXR NOT AVAILABLE|WEBXR NEEDS HTTPS/.test(text)) {
                        xrButtonObserver.disconnect();
                        xrButton.remove();
                        runtime.supportsXR = false;
                    }
                };
                const xrButtonObserver = new MutationObserver(suppressUnsupportedButton);
                xrButtonObserver.observe(xrButton, { childList: true, characterData: true, subtree: true });
                setTimeout(suppressUnsupportedButton, 500);
                setTimeout(suppressUnsupportedButton, 2000);
                // Keep three.js's button (it owns support detection + session
                // request) but hide it — the viewport menu's "Enter VR" button
                // proxies clicks to it and mirrors its state.
                xrButton.style.display = 'none';
                document.body.appendChild(xrButton);
                runtime.xrButton = xrButton;

                const xrOrigin = new THREE.Group();
                xrOrigin.name = '__maxjs_xr_origin__';
                xrOrigin.visible = false;
                scene.add(xrOrigin);

                const controllerModelFactory = new XRControllerModelFactory();
                const pointerGeometry = new THREE.BufferGeometry();
                pointerGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
                const controllerStates = [];
                const savedCameraState = {
                    position: new THREE.Vector3(),
                    quaternion: new THREE.Quaternion(),
                    up: new THREE.Vector3(),
                    target: new THREE.Vector3(),
                    hasValue: false,
                };
                const moveForward = new THREE.Vector3();
                const moveRight = new THREE.Vector3();
                const moveDelta = new THREE.Vector3();
                const worldUp = new THREE.Vector3(0, 1, 0);
                const focusBounds = new THREE.Box3();
                const focusCenter = new THREE.Vector3();

                const inputDeadzone = 0.16;
                const moveSpeed = 180;
                const verticalSpeed = 120;
                const snapTurnAngle = THREE.MathUtils.degToRad(30);
                const snapTurnThreshold = 0.72;
                const snapTurnReset = 0.28;

                function applyDeadzone(value, deadzone = inputDeadzone) {
                    if (!Number.isFinite(value) || Math.abs(value) <= deadzone) return 0;
                    return ((Math.abs(value) - deadzone) / (1 - deadzone)) * Math.sign(value);
                }

                function readPrimaryStick(inputSource) {
                    const axes = inputSource?.gamepad?.axes;
                    if (!axes?.length) return { x: 0, y: 0 };

                    let bestX = 0;
                    let bestY = 0;
                    let bestStrength = 0;
                    const pairCount = Math.floor(axes.length / 2);
                    for (let i = 0; i < pairCount; i++) {
                        const x = applyDeadzone(axes[i * 2] ?? 0);
                        const y = applyDeadzone(axes[i * 2 + 1] ?? 0);
                        const strength = x * x + y * y;
                        if (strength > bestStrength) {
                            bestStrength = strength;
                            bestX = x;
                            bestY = y;
                        }
                    }
                    return { x: bestX, y: bestY };
                }

                function isButtonPressed(inputSource, index) {
                    return !!inputSource?.gamepad?.buttons?.[index]?.pressed;
                }

                function setControllerInputSource(state, inputSource) {
                    if (state.inputSource === inputSource) return;
                    state.inputSource = inputSource ?? null;
                    const visible = !!state.inputSource;
                    state.controller.visible = visible;
                    state.grip.visible = visible;
                    if (!visible) state.turnReady = true;
                }

                function syncControllerInputSources() {
                    const session = renderer.xr?.getSession?.();
                    const inputSources = Array.from(session?.inputSources ?? [])
                        .filter(source => !!source && (!!source.gamepad || source.targetRayMode === 'tracked-pointer'))
                        .sort((a, b) => {
                            const rank = (source) => {
                                switch (source?.handedness) {
                                    case 'left': return 0;
                                    case 'right': return 1;
                                    default: return 2;
                                }
                            };
                            return rank(a) - rank(b);
                        });

                    for (let i = 0; i < controllerStates.length; i++) {
                        setControllerInputSource(controllerStates[i], inputSources[i] ?? null);
                    }
                }

                function getControllerState(handedness, fallbackIndex = -1) {
                    for (const state of controllerStates) {
                        if (state.inputSource?.handedness === handedness) return state;
                    }
                    if (fallbackIndex >= 0 && controllerStates[fallbackIndex]?.inputSource) {
                        return controllerStates[fallbackIndex];
                    }
                    return controllerStates.find(state => !!state.inputSource) ?? null;
                }

                function recenterOrigin() {
                    const box = computeVisibleSceneBounds(focusBounds);
                    if (box.isEmpty()) {
                        xrOrigin.position.set(0, 0, 0);
                        xrOrigin.rotation.set(0, 0, 0);
                        return;
                    }

                    box.getCenter(focusCenter);
                    xrOrigin.position.copy(focusCenter);
                    xrOrigin.position.y = 0;
                    xrOrigin.rotation.set(0, 0, 0);
                }

                function captureCameraState() {
                    savedCameraState.position.copy(deps.camera.position);
                    savedCameraState.quaternion.copy(deps.camera.quaternion);
                    savedCameraState.up.copy(deps.camera.up);
                    savedCameraState.target.copy(controls.target);
                    savedCameraState.hasValue = true;
                }

                function restoreCameraState() {
                    if (!savedCameraState.hasValue) {
                        deps.camera.up.set(0, 1, 0);
                        deps.camera.position.copy(cameraDefaultPosition);
                        deps.camera.lookAt(controls.target);
                        return;
                    }
                    deps.camera.position.copy(savedCameraState.position);
                    deps.camera.quaternion.copy(savedCameraState.quaternion);
                    deps.camera.up.copy(savedCameraState.up);
                    controls.target.copy(savedCameraState.target);
                }

                function handleSessionStart() {
                    runtime.active = true;
                    runtime.shouldBypassPostFx = true;
                    captureCameraState();
                    controls.enabled = false;
                    xrOrigin.visible = true;
                    // Scale up for cm units (Max) vs meters (headset session)
                    xrOrigin.scale.setScalar(100);
                    xrOrigin.add(deps.camera);
                    syncControllerInputSources();
                    recenterOrigin();
                    perfHud.setStatus('max.js - headset session active');
                }

                function handleSessionEnd() {
                    runtime.active = false;
                    runtime.shouldBypassPostFx = false;
                    scene.add(deps.camera);
                    xrOrigin.visible = false;
                    xrOrigin.position.set(0, 0, 0);
                    xrOrigin.rotation.set(0, 0, 0);
                    xrOrigin.scale.setScalar(1);
                    restoreCameraState();
                    deps.camera.updateProjectionMatrix();
                    deps.syncCameraControlAvailability?.();
                    controls.update();
                    perfHud.setStatus(`max.js - ${rendererBackendLabel} renderer ready`);
                }

                function updateLocomotion(dt) {
                    if (!runtime.active) return;

                    syncControllerInputSources();

                    const leftState = getControllerState('left', 0);
                    const rightState = getControllerState('right', 1);
                    const moveState = leftState ?? rightState;
                    const turnState = rightState && rightState !== moveState ? rightState : null;

                    if (moveState?.inputSource) {
                        const { x, y } = readPrimaryStick(moveState.inputSource);
                        moveForward.set(0, 0, -1).applyQuaternion(xrOrigin.quaternion);
                        moveForward.y = 0;
                        if (moveForward.lengthSq() < 1e-6) moveForward.set(0, 0, -1);
                        moveForward.normalize();
                        moveRight.crossVectors(moveForward, worldUp).normalize();

                        moveDelta.set(0, 0, 0);
                        if (x) moveDelta.addScaledVector(moveRight, x * moveSpeed * dt);
                        if (y) moveDelta.addScaledVector(moveForward, -y * moveSpeed * dt);
                        if (moveDelta.lengthSq() > 0) xrOrigin.position.add(moveDelta);

                        if (isButtonPressed(moveState.inputSource, 1)) {
                            xrOrigin.position.y += verticalSpeed * dt;
                        }
                    }

                    if (rightState?.inputSource && isButtonPressed(rightState.inputSource, 1)) {
                        xrOrigin.position.y -= verticalSpeed * dt;
                    }

                    if (turnState?.inputSource) {
                        const { x } = readPrimaryStick(turnState.inputSource);
                        if (turnState.turnReady && Math.abs(x) >= snapTurnThreshold) {
                            xrOrigin.rotateY(-Math.sign(x) * snapTurnAngle);
                            turnState.turnReady = false;
                        } else if (!turnState.turnReady && Math.abs(x) <= snapTurnReset) {
                            turnState.turnReady = true;
                        }
                    }
                }

                for (let i = 0; i < 2; i++) {
                    const controller = renderer.xr.getController(i);
                    const grip = renderer.xr.getControllerGrip(i);
                    const ray = new THREE.Line(pointerGeometry, new THREE.LineBasicMaterial({
                        color: i === 0 ? 0x66d9ef : 0xffc857,
                        transparent: true,
                        opacity: 0.85,
                    }));
                    ray.name = `__maxjs_xr_ray_${i}`;
                    ray.scale.z = 0.75;
                    controller.visible = false;
                    grip.visible = false;
                    controller.add(ray);
                    grip.add(controllerModelFactory.createControllerModel(grip));
                    xrOrigin.add(controller);
                    xrOrigin.add(grip);

                    const state = {
                        index: i,
                        controller,
                        grip,
                        ray,
                        inputSource: null,
                        turnReady: true,
                    };

                    controller.addEventListener('connected', event => {
                        state.inputSource = event.data ?? null;
                        controller.visible = true;
                        grip.visible = true;
                    });
                    controller.addEventListener('disconnected', () => {
                        state.inputSource = null;
                        state.turnReady = true;
                        controller.visible = false;
                        grip.visible = false;
                    });

                    controllerStates.push(state);
                }

                renderer.xr.addEventListener('sessionstart', handleSessionStart);
                renderer.xr.addEventListener('sessionend', handleSessionEnd);
                runtime.update = updateLocomotion;
            } catch (error) {
                console.warn('[max.js] WebXR init failed:', error);
            }

            return runtime;
}

export { createWebXRRuntime };
