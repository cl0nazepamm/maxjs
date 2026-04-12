# MaxJS Physics & Game API

## Overview

MaxJS supports interactive physics-driven gameplay via Rapier3D (WASM) integrated with the layer system. Scene objects from 3ds Max can be controlled by physics, and custom game logic can be implemented in JS layers.

## Physics Engine

**Rapier3D** (`@dimforge/rapier3d-compat`) - Rust-based physics engine compiled to WASM.

Import in layers:
```javascript
import RAPIER from '@dimforge/rapier3d-compat';
```

Initialize before use:
```javascript
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -980, z: 0 }); // gravity in cm/s²
```

## World-Space Transform API

Scene objects can be driven by physics using world-space transforms:

```javascript
// Get node from scene
const node = ctx.maxScene.getNode(handle);

// Set world-space transform (position + quaternion)
node.transform.setWorldTransform(px, py, pz, qx, qy, qz, qw);

// Or individual components
node.transform.setWorldPosition(x, y, z);
node.transform.setWorldQuaternion(x, y, z, w);

// Clear override (return to Max transform)
node.transform.clear();
```

## Camera Modes

Three camera modes available:

| Mode | Description | API |
|------|-------------|-----|
| `viewport` | Synced from Max viewport | `ctx.camera.useViewport()` |
| `physical` | Locked to Max camera object | `ctx.camera.usePhysicalCamera(handle)` |
| `script` | Full JS control | `ctx.camera.useScriptMode()` |

Script mode example:
```javascript
ctx.camera.useScriptMode();
ctx.camera.setPosition(0, 100, 200);
ctx.camera.lookAt(0, 0, 0);
ctx.camera.setFov(60);
```

## Example: Shooting Game

Located at: `examples/shooting_game.js`

Features:
- Click to shoot balls
- Balls use simple manual physics (velocity + gravity)
- Scene objects use Rapier physics
- Objects sleep until hit, then activate with impulse
- Convex hull colliders from mesh geometry

Key pattern:
```javascript
// Create sleeping physics body for scene object
const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setGravityScale(0)  // No gravity until hit
);

// On hit, activate
body.setGravityScale(1);
body.wakeUp();
body.applyImpulse({ x, y, z }, true);

// Sync to scene each frame
const pos = body.translation();
const rot = body.rotation();
node.transform.setWorldTransform(pos.x, pos.y, pos.z, rot.x, rot.y, rot.z, rot.w);
```

## Units

MaxJS uses centimeters (cm) to match 3ds Max:
- Gravity: 980 cm/s²
- Typical object sizes: 10-100 cm
- Ball speed: 500-1500 cm/s

## Vendor Dependencies

- `vendor/three-r183.2/` - Three.js
- `vendor/rapier/` - Rapier3D WASM physics
