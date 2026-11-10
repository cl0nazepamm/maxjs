// context.js — the shared editor context. One instance is created by boot.js
// and passed to every extracted subsystem factory (createXxx(ctx)); modules
// talk to each other ONLY through it. Fields are assigned by boot as each
// subsystem comes up.
//
// RULE: never alias a mutable ctx field at module scope
// (`const { renderer } = ctx` captures a stale reference the first time the
// renderer is rebuilt on a backend switch). Always read `ctx.renderer` at call
// time.

function createEditorContext() {
    return {
        // host seam (host_bridge.js)
        hostBridge: null,
        bridge: null,

        // core three objects — REBUILT on renderer backend switch; see RULE above
        renderer: null,
        scene: null,
        activeCamera: null,
        controls: null,

        // subsystem APIs, registered by boot as waves extract them
        // (environment, sky, gi, materials, sceneSync, lights, camera, postFx, ...)
    };
}

export { createEditorContext };
