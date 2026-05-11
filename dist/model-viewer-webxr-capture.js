import { html, css, LitElement } from 'lit';
import { property, query, customElement } from 'lit/decorators.js';
import { Texture, RGBAFormat, UnsignedByteType, LinearFilter, ShaderMaterial, Mesh, PlaneGeometry, WebGLRenderTarget, SRGBColorSpace } from 'three';

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
// Background quad rendered behind the 3D scene during capture.
// gl_Position.z = 0.999 puts it at the far plane in NDC so the model is
// drawn on top.
//
// The fragment decodes the sRGB-encoded camera texture to linear (pow 2.2)
// because the capture render target is tagged SRGBColorSpace — three.js
// re-encodes linear → sRGB on write, so the camera quad must feed it linear
// values. Without this decode the camera image stays sRGB-correct but the
// 3D model output is darkened (verified empirically on device).
const CAMERA_QUAD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.999, 1.0);
  }
`;
const CAMERA_QUAD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D cameraTex;
  varying vec2 vUv;
  void main() {
    vec4 color = texture2D(cameraTex, vUv);
    color.rgb = pow(color.rgb, vec3(2.2));
    gl_FragColor = color;
  }
`;

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
/**
 * Chrome WebXR workarounds for three.js #33404.
 * https://github.com/mrdoob/three.js/issues/33404
 *
 * applyProjectionLayerWorkaround (Chrome 147+): deletes
 *   XRWebGLBinding.prototype.createProjectionLayer so three.js falls back to
 *   the legacy XRWebGLLayer path.
 *
 * applyUpdateRenderStateWorkaround (Chrome 148): wraps
 *   XRSession.prototype.updateRenderState to re-inject the last known
 *   baseLayer, preventing Chrome 148 from losing the reference when
 *   updateRenderState is called without a baseLayer argument.
 *
 * ensureXRCameraTexture / bindXRCameraTexture / releaseXRCameraTexture:
 *   manually wraps the raw WebGLTexture from XRWebGLBinding.getCameraImage
 *   in a plain THREE.Texture and injects it via renderer.properties,
 *   bypassing the ExternalTexture / WebXRManager.getCameraTexture path
 *   that crashes on Chrome 147+.
 *
 * Chrome 149+ (≥149.0.7819.0) fixes the underlying Chrome crash;
 * these workarounds remain as safety guards and are harmless on newer builds.
 *
 * To remove individual workarounds:
 *   applyProjectionLayerWorkaround — remove import + call in host-bridge.ts
 *     when Chrome 147 is no longer a concern.
 *   applyUpdateRenderStateWorkaround — remove import + call in host-bridge.ts
 *     when Chrome 148 is no longer a concern.
 *   Texture helpers — remove imports from WebXRCapture.ts and restore the
 *     original getCameraTexture / ExternalTexture logic.
 *   If all workarounds are removed, delete this file entirely.
 */
const UPDATE_RENDER_STATE_MARKER = '__captureUpdateRenderStateWrapped';
function applyProjectionLayerWorkaround() {
    const win = window;
    try {
        if (win.XRWebGLBinding != null &&
            win.XRWebGLBinding.prototype.createProjectionLayer != null) {
            delete win.XRWebGLBinding.prototype.createProjectionLayer;
        }
    }
    catch (e) {
        console.warn('[model-viewer-webxr-capture] Could not delete projection-layer ' +
            'prototype; AR capture may crash on Chrome 147+.', e);
    }
}
function ensureXRCameraTexture(current, xrCamera, canvasWidth, canvasHeight) {
    var _a, _b;
    if (current != null) {
        return current;
    }
    const tex = new Texture();
    tex.image = {
        width: (_a = xrCamera.width) !== null && _a !== void 0 ? _a : canvasWidth,
        height: (_b = xrCamera.height) !== null && _b !== void 0 ? _b : canvasHeight,
    };
    tex.flipY = false;
    tex.format = RGBAFormat;
    tex.type = UnsignedByteType;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    return tex;
}
function bindXRCameraTexture(renderer, tex, glTexture) {
    const props = renderer.properties.get(tex);
    props.__webglTexture = glTexture;
    props.__webglInit = true;
}
function releaseXRCameraTexture(renderer, tex) {
    const props = renderer.properties.get(tex);
    if (props != null) {
        props.__webglTexture = undefined;
    }
}
/**
 * Chrome 148 workaround — https://github.com/mrdoob/three.js/issues/33404
 *
 * Chrome 148 clears the XRWebGLLayer baseLayer reference when
 * XRSession.updateRenderState is called without a baseLayer argument (e.g.
 * to update depthNear/depthFar only). This wraps the prototype method to
 * re-inject the last known baseLayer on every call, preventing the crash.
 *
 * Chrome 149+ (≥149.0.7819.0) fixes this on the Chrome side; this wrapper
 * is harmless on newer builds.
 */
function applyUpdateRenderStateWorkaround() {
    const proto = XRSession.prototype;
    if (proto.updateRenderState[UPDATE_RENDER_STATE_MARKER] === true) {
        return;
    }
    const original = proto.updateRenderState;
    const baseLayerBySession = new WeakMap();
    const wrapped = function (options) {
        if ((options === null || options === void 0 ? void 0 : options.baseLayer) != null) {
            baseLayerBySession.set(this, options.baseLayer);
        }
        const last = baseLayerBySession.get(this);
        original.call(this, last != null ? Object.assign({ baseLayer: last }, options) : options);
    };
    wrapped[UPDATE_RENDER_STATE_MARKER] = true;
    proto.updateRenderState = wrapped;
}

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
/**
 * Implements WebXR AR screenshot capture by composing the raw camera image
 * with the rendered 3D scene into a single Blob.
 *
 *  - Owns its own XRWebGLBinding (created at session start).
 *  - Delegates camera-texture injection to helpers in
 *    `workarounds/chrome-xrwebgllayer.ts`, bypassing the ExternalTexture /
 *    WebXRManager.getCameraTexture path that crashes Chrome 147+ (#33404).
 *  - Adds the background quad as a scene member with renderOrder=-999
 *    and toggles renderer.xr.enabled = false during the offscreen render.
 */
class WebXRCapture {
    constructor(threeRenderer, session) {
        this.threeRenderer = threeRenderer;
        this.xrGlBinding = null;
        this.cameraTexture = null;
        this.bgQuad = null;
        this.renderTarget = null;
        this.pendingCapture = null;
        if (typeof XRWebGLBinding === 'undefined') {
            console.warn('[WebXRCapture] XRWebGLBinding is not available.');
            return;
        }
        try {
            const gl = threeRenderer.getContext();
            this.xrGlBinding = new XRWebGLBinding(session, gl);
        }
        catch (e) {
            console.warn('[WebXRCapture] Failed to create XRWebGLBinding:', e);
            return;
        }
        this.bgQuad = this.createBackgroundQuad();
    }
    /**
     * Schedule a capture for the next XRFrame. Rejects if a capture is already
     * pending.
     */
    requestCapture(options = {}) {
        if (this.xrGlBinding == null) {
            return Promise.resolve(null);
        }
        if (this.pendingCapture != null) {
            return Promise.reject(new Error('AR capture is already in progress'));
        }
        return new Promise((resolve, reject) => {
            this.pendingCapture = { resolve, reject, options };
        });
    }
    /**
     * Called from the AR session's per-frame hook. Executes any pending
     * capture using the current XRView and the live ArrayCamera.
     */
    processFrame(view, modelScene, viewCamera) {
        const pending = this.pendingCapture;
        if (pending == null) {
            return;
        }
        this.pendingCapture = null;
        try {
            this.executeCapture(view, modelScene, viewCamera, pending);
        }
        catch (error) {
            console.error('[WebXRCapture] executeCapture threw:', error);
            pending.reject(error);
        }
    }
    /** Release GPU resources. Safe to call after dispose(). */
    dispose() {
        if (this.cameraTexture != null) {
            // Detach the WebXR-owned WebGLTexture so three.js does not delete it.
            releaseXRCameraTexture(this.threeRenderer, this.cameraTexture);
            this.cameraTexture.dispose();
            this.cameraTexture = null;
        }
        if (this.renderTarget != null) {
            this.renderTarget.dispose();
            this.renderTarget = null;
        }
        if (this.bgQuad != null) {
            this.bgQuad.geometry.dispose();
            this.bgQuad.material.dispose();
            this.bgQuad = null;
        }
        this.xrGlBinding = null;
        if (this.pendingCapture != null) {
            this.pendingCapture.resolve(null);
            this.pendingCapture = null;
        }
    }
    createBackgroundQuad() {
        const material = new ShaderMaterial({
            uniforms: { cameraTex: { value: null } },
            vertexShader: CAMERA_QUAD_VERTEX_SHADER,
            fragmentShader: CAMERA_QUAD_FRAGMENT_SHADER,
            depthTest: false,
            depthWrite: false,
        });
        const mesh = new Mesh(new PlaneGeometry(2, 2), material);
        mesh.frustumCulled = false;
        mesh.renderOrder = -999;
        return mesh;
    }
    executeCapture(view, modelScene, viewCamera, pending) {
        var _a, _b;
        const renderer = this.threeRenderer;
        const xrCamera = view.camera;
        if (xrCamera == null || this.xrGlBinding == null) {
            console.warn('[WebXRCapture] view.camera or XRWebGLBinding unavailable; ' +
                'session may not have camera-access enabled.');
            pending.resolve(null);
            return;
        }
        let glCameraTexture;
        try {
            glCameraTexture = this.xrGlBinding.getCameraImage(xrCamera);
        }
        catch (e) {
            console.error('[WebXRCapture] getCameraImage threw:', e);
            pending.resolve(null);
            return;
        }
        if (glCameraTexture == null) {
            pending.resolve(null);
            return;
        }
        const canvas = renderer.domElement;
        const rtWidth = Math.max(1, Math.floor((_a = pending.options.width) !== null && _a !== void 0 ? _a : canvas.width));
        const rtHeight = Math.max(1, Math.floor((_b = pending.options.height) !== null && _b !== void 0 ? _b : canvas.height));
        this.ensureRenderTarget(rtWidth, rtHeight);
        const renderTarget = this.renderTarget;
        const xrCameraSize = xrCamera;
        this.cameraTexture = ensureXRCameraTexture(this.cameraTexture, xrCameraSize, canvas.width, canvas.height);
        bindXRCameraTexture(renderer, this.cameraTexture, glCameraTexture);
        const bgQuad = this.bgQuad;
        bgQuad.material.uniforms.cameraTex.value =
            this.cameraTexture;
        modelScene.add(bgQuad);
        const prevTarget = renderer.getRenderTarget();
        const wasXrEnabled = renderer.xr.enabled;
        try {
            renderer.xr.enabled = false;
            renderer.setRenderTarget(renderTarget);
            renderer.render(modelScene, viewCamera);
        }
        finally {
            renderer.xr.enabled = wasXrEnabled;
            renderer.setRenderTarget(prevTarget);
            modelScene.remove(bgQuad);
        }
        const pixels = new Uint8Array(rtWidth * rtHeight * 4);
        renderer.readRenderTargetPixels(renderTarget, 0, 0, rtWidth, rtHeight, pixels);
        this.pixelsToBlob(pixels, rtWidth, rtHeight, pending.options)
            .then((blob) => pending.resolve(blob), (err) => pending.reject(err));
    }
    ensureRenderTarget(width, height) {
        if (this.renderTarget != null && this.renderTarget.width === width &&
            this.renderTarget.height === height) {
            return;
        }
        if (this.renderTarget != null) {
            this.renderTarget.setSize(width, height);
            return;
        }
        this.renderTarget = new WebGLRenderTarget(width, height, {
            minFilter: LinearFilter,
            magFilter: LinearFilter,
            format: RGBAFormat,
            type: UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
            // SRGBColorSpace pairs with the pow(2.2) decode in the camera quad
            // shader so the 3D model is output with correct brightness.
            colorSpace: SRGBColorSpace,
        });
    }
    async pixelsToBlob(pixels, width, height, options) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx == null) {
            return null;
        }
        const imageData = ctx.createImageData(width, height);
        const rowBytes = width * 4;
        for (let y = 0; y < height; y++) {
            const srcOffset = (height - 1 - y) * rowBytes;
            const dstOffset = y * rowBytes;
            imageData.data.set(pixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
        }
        ctx.putImageData(imageData, 0, 0);
        return new Promise((resolve) => {
            var _a, _b;
            canvas.toBlob(resolve, (_a = options.mimeType) !== null && _a !== void 0 ? _a : 'image/jpeg', (_b = options.qualityArgument) !== null && _b !== void 0 ? _b : 0.92);
        });
    }
}

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
/**
 * Owns the `WebXRCapture` lifecycle for a single `<model-viewer-webxr-capture>`
 * instance.
 *
 *  - Constructs `WebXRCapture` when `onSessionStart` is invoked with a session
 *    that has `'camera-access'` enabled.
 *  - Drives `WebXRCapture.processFrame` from the host-bridge frame dispatcher.
 *  - Disposes `WebXRCapture` on session end.
 *
 * The global side effects that used to live in `beforeRequestSession`
 * (`'camera-access'` injection, the Chrome 147+ projection-layer workaround)
 * are now installed once at plugin connect time by `host-bridge.ts` —
 * see `ensureGlobalPatches`.
 */
class WebXRCaptureProvider {
    constructor() {
        this.capture = null;
        this._supported = false;
    }
    /**
     * True once an AR session has started with `camera-access` enabled. False
     * before session start, after session end, or if the device declines the
     * feature.
     */
    get supported() {
        return this._supported;
    }
    onSessionStart(threeRenderer, session) {
        const sessionAny = session;
        this._supported = sessionAny.enabledFeatures != null &&
            sessionAny.enabledFeatures.indexOf('camera-access') !== -1;
        if (this._supported) {
            this.capture = new WebXRCapture(threeRenderer, session);
        }
    }
    onFrame(view, scene, viewCamera) {
        if (this.capture == null) {
            return;
        }
        this.capture.processFrame(view, scene, viewCamera);
    }
    onSessionEnd() {
        if (this.capture != null) {
            this.capture.dispose();
            this.capture = null;
        }
        this._supported = false;
    }
    /**
     * Schedules a capture of the current AR view. Resolves with `null` when
     * capture is unavailable (no active session, or `camera-access` not
     * granted).
     */
    requestCapture(options) {
        if (this.capture == null) {
            return Promise.resolve(null);
        }
        return this.capture.requestCapture(options);
    }
}

/* @license
 * Copyright (c) 2026 k1pp0
 * SPDX-License-Identifier: MIT
 *
 * Icon: Lucide "x"
 * Source: https://github.com/lucide-icons/lucide
 * Copyright Lucide Contributors, ISC License
 */
var CaptureCloseIcon = html `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M18 6 6 18"/>
  <path d="m6 6 12 12"/>
</svg>
`;

/* @license
 * Copyright (c) 2026 k1pp0
 * SPDX-License-Identifier: MIT
 *
 * Icon: Lucide "download"
 * Source: https://github.com/lucide-icons/lucide
 * Copyright Lucide Contributors, ISC License
 */
var CaptureDownloadIcon = html `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" x2="12" y1="15" y2="3"/>
</svg>
`;

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
const subscribers = new Set();
const symbolCache = new WeakMap();
let globalPatchesInstalled = false;
let frameHookInstalled = false;
const NAVIGATOR_XR_MARKER = '__captureXRRequestSessionWrapped';
const FRAME_HOOK_MARKER = '__captureOnWebXRFrameWrapped';
/**
 * Walks an object's own properties and prototype chain looking for a symbol
 * whose `.description` matches `description`. Caches results by (proto, desc).
 */
function findSymbol(obj, description) {
    var _a;
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
        return null;
    }
    let target = obj;
    while (target != null) {
        let perTarget = symbolCache.get(target);
        if (perTarget == null) {
            perTarget = new Map();
            symbolCache.set(target, perTarget);
        }
        if (perTarget.has(description)) {
            const cached = (_a = perTarget.get(description)) !== null && _a !== void 0 ? _a : null;
            if (cached != null) {
                return cached;
            }
        }
        else {
            const own = Object.getOwnPropertySymbols(target).find((s) => s.description === description);
            perTarget.set(description, own !== null && own !== void 0 ? own : null);
            if (own != null) {
                return own;
            }
        }
        target = Object.getPrototypeOf(target);
    }
    return null;
}
function readSymbolProperty(host, description, name) {
    const sym = findSymbol(host, description);
    if (sym == null) {
        throw new Error(`[model-viewer-webxr-capture] Could not find ${name} on the host ` +
            '<model-viewer>. This usually means @google/model-viewer was ' +
            'upgraded to an incompatible major version. Pin to ^4.2.0 or file ' +
            'an issue at https://github.com/k1pp0/model-viewer-webxr-capture/issues.');
    }
    return host[sym];
}
/**
 * Returns the host element's internal `ModelScene` (a three.js Scene).
 */
function getModelScene(host) {
    return readSymbolProperty(host, 'scene', '$scene');
}
/**
 * Returns the host's internal `Renderer` (the wrapper that owns the
 * `WebGLRenderer` and the singleton `ARRenderer`).
 */
function getRenderer(host) {
    return readSymbolProperty(host, 'renderer', '$renderer');
}
function getThreeRenderer(host) {
    return getRenderer(host).threeRenderer;
}
function getARRenderer(host) {
    return getRenderer(host).arRenderer;
}
/**
 * Returns the live `XRSession` if one is active on the host's renderer,
 * otherwise `null`.
 */
function getXRSession(host) {
    const xr = getThreeRenderer(host).xr;
    return xr.getSession();
}
/**
 * Idempotently installs:
 *
 *  - `navigator.xr.requestSession` wrapper that appends `'camera-access'` to
 *    the `optionalFeatures` of every `'immersive-ar'` session request.
 *  - `applyProjectionLayerWorkaround()` and `applyUpdateRenderStateWorkaround()`
 *    for Chrome 147/148 regressions (see `workarounds/chrome-xrwebgllayer.ts`).
 *
 * Both are global side effects. They are gated on the first plugin connect,
 * so pages that load the bundle but do not use `<model-viewer-webxr-capture>`
 * see no behavior change.
 */
function ensureGlobalPatches() {
    if (globalPatchesInstalled) {
        return;
    }
    globalPatchesInstalled = true;
    const xr = (typeof navigator !== 'undefined' ? navigator.xr : null);
    if (xr != null && xr[NAVIGATOR_XR_MARKER] !== true &&
        typeof xr.requestSession === 'function') {
        const original = xr.requestSession.bind(xr);
        xr.requestSession = function (mode, options) {
            if (mode === 'immersive-ar') {
                const opts = options !== null && options !== void 0 ? options : {};
                const optional = Array.isArray(opts.optionalFeatures) ?
                    opts.optionalFeatures.slice() :
                    [];
                if (optional.indexOf('camera-access') === -1) {
                    optional.push('camera-access');
                }
                return original(mode, Object.assign(Object.assign({}, opts), { optionalFeatures: optional }));
            }
            return original(mode, options);
        };
        xr[NAVIGATOR_XR_MARKER] = true;
    }
    applyProjectionLayerWorkaround();
    applyUpdateRenderStateWorkaround();
}
/**
 * Idempotently wraps `arRenderer.onWebXRFrame` so that, after the original
 * frame logic runs, every subscriber whose host's scene equals the current
 * `presentedScene` is invoked with `(firstView, scene, viewCamera)`.
 *
 * `arRenderer` is a process-wide singleton (`Renderer.singleton.arRenderer`),
 * so the wrapper is installed exactly once for the entire page.
 */
function ensureFrameHook(host) {
    if (frameHookInstalled) {
        return;
    }
    const arRenderer = getARRenderer(host);
    if (arRenderer.onWebXRFrame[FRAME_HOOK_MARKER] === true) {
        frameHookInstalled = true;
        return;
    }
    const original = arRenderer.onWebXRFrame.bind(arRenderer);
    const wrapped = function (time, frame) {
        original(time, frame);
        dispatchFrame(arRenderer);
    };
    wrapped[FRAME_HOOK_MARKER] = true;
    arRenderer.onWebXRFrame = wrapped;
    frameHookInstalled = true;
}
function dispatchFrame(arRenderer) {
    if (subscribers.size === 0) {
        return;
    }
    const scene = arRenderer.presentedScene;
    if (scene == null) {
        return;
    }
    const frame = arRenderer.frame;
    if (frame == null) {
        return;
    }
    const xr = arRenderer.threeRenderer.xr;
    const refSpace = xr.getReferenceSpace();
    if (refSpace == null) {
        return;
    }
    const pose = frame.getViewerPose(refSpace);
    if (pose == null || pose.views.length === 0) {
        return;
    }
    const view = pose.views[0];
    const xrCamera = xr.getCamera();
    const cameras = xrCamera.cameras;
    const viewCamera = cameras != null && cameras.length > 0 ? cameras[0] : xrCamera;
    for (const sub of subscribers) {
        let hostScene = null;
        try {
            hostScene = getModelScene(sub.host);
        }
        catch (_a) {
            continue;
        }
        if (hostScene === scene) {
            try {
                sub.callback(view, scene, viewCamera);
            }
            catch (e) {
                console.warn('[model-viewer-webxr-capture] frame subscriber threw:', e);
            }
        }
    }
}
/**
 * Subscribes a callback that fires once per AR frame for the matching host
 * (i.e. when `arRenderer.presentedScene === host[$scene]`). Returns an
 * unsubscribe function. Safe to call multiple times for the same host.
 */
function subscribe(host, callback) {
    const entry = { host, callback };
    subscribers.add(entry);
    return () => {
        subscribers.delete(entry);
    };
}

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
// Layout/visuals developed with reference to 8thwall xrextras mediarecorder
// (record-button.css / media-preview.css). Theming is exposed via CSS
// custom properties on the host.
const captureUIStyles = css `
:host {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: block;
  z-index: 20;
}

.style-reset {
  background: none;
  border: none;
  outline: none;
  box-shadow: none !important;
  padding: 0;
  margin: 0;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  font-family: inherit;
}
.style-reset:focus { outline: 0; }

/* --- Shutter --- */
.shutter {
  position: absolute;
  width: 25vmin;
  height: 25vmin;
  max-width: 10em;
  max-height: 10em;
  bottom: 3vmin;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: auto;
  touch-action: none;
  opacity: 1;
  transition: 0.5s opacity;
  display: none;
}
:host(.shutter-enabled) .shutter {
  display: block;
}
.shutter.fade-container {
  opacity: 0;
  pointer-events: none;
}
.shutter .recorder-button {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: var(--webxr-capture-button-color, #fff);
  border-radius: 50%;
  color: transparent;
  transform-origin: 50% 50%;
  transform: scale(0.6);
  transition: 0.3s border-radius, 0.3s transform;
}
.shutter .recorder-button:active {
  transform: scale(0.5);
}
.shutter .progress-container {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  transform: scale(0.9);
}
.shutter .progress-track {
  fill: transparent;
  stroke: var(--webxr-capture-ring-color, #fff);
  stroke-width: 3;
}

/* --- Flash --- */
.flash {
  position: absolute;
  inset: 0;
  background: #fff;
  opacity: 0;
  pointer-events: none;
  transition: 0.6s opacity;
  z-index: 40;
}
.flash.flashing {
  transition: 0s opacity;
  opacity: 1;
  z-index: 100;
}

/* --- Preview --- */
.preview {
  display: none;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  position: absolute;
  inset: 0;
  z-index: 30;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  box-sizing: border-box;
  font-family: var(--webxr-capture-font-family, inherit);
}
:host(.preview-open) .preview {
  display: flex;
}
.preview.fade-in {
  transition: 0.5s opacity;
  opacity: 1;
  pointer-events: auto;
}
.preview .top-bar {
  position: relative;
  flex: 1 0 0;
}
.preview .preview-box {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
.preview .preview-image {
  display: block;
  max-width: 90vw;
  max-height: calc(88vh - 12vmin);
  border-radius: 10px;
  border: 1vmin solid var(--webxr-capture-image-border-color, #fff);
  background-color: #fff;
  filter: drop-shadow(0 0 2px #333);
}
.preview .icon-button {
  padding: 4vmin;
}
.preview .icon-button > svg {
  display: block;
  height: 7.5vmin;
  width: 7.5vmin;
  filter: drop-shadow(0 0 2px #333);
}
.preview .preview-close {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 1;
}
.preview .bottom-bar {
  display: flex;
  justify-content: center;
  position: relative;
  margin: 0 5vmin 5vmin 5vmin;
}
.preview .action-button {
  padding: 0.3em 0.5em;
  font-family: inherit;
  text-align: right;
  color: var(--webxr-capture-action-button-text-color, #000);
  background-color: var(--webxr-capture-action-button-color, #fff);
  border-radius: 0.5em;
  font-size: 5vmin;
  min-width: 3.25em;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  text-decoration: none;
}
.preview .action-button:active {
  filter: brightness(0.85);
}
.preview .action-button > svg {
  height: 0.8em;
  width: 0.8em;
  margin-left: 0.4em;
}
`;

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
var __decorate = (undefined && undefined.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
const PREVIEW_FADE_MS = 500;
/**
 * Companion element that adds WebXR AR screenshot capture, plus a built-in
 * shutter / flash / preview UI, on top of `<model-viewer>`. All capture
 * implementation lives in this package — installing it is what enables the
 * feature; removing it leaves `<model-viewer>` capture-free.
 *
 * Usage:
 *
 *   <model-viewer id="mv" src="…" ar>
 *     <model-viewer-webxr-capture></model-viewer-webxr-capture>
 *   </model-viewer>
 *
 * The `for` attribute resolves to a sibling `<model-viewer>` by id. If
 * omitted, the closest ancestor `<model-viewer>` is used.
 */
let ModelViewerWebXRCapture = class ModelViewerWebXRCapture extends LitElement {
    constructor() {
        super(...arguments);
        this.actionText = 'Save / Share';
        this.filenamePrefix = 'webxr-snap';
        this.shareTitle = 'WebXR Snap';
        this.host = null;
        this.provider = new WebXRCaptureProvider();
        this.unsubscribeFrame = null;
        this.sessionActive = false;
        this.currentBlob = null;
        this.currentUrl = null;
        this.clearSrcTimer = 0;
        this.onFrameTick = (view, scene, viewCamera) => {
            this.provider.onFrame(view, scene, viewCamera);
        };
        this.onARStatus = (event) => {
            const status = event.detail.status;
            if (status === 'session-started') {
                if (this.host != null) {
                    try {
                        const threeRenderer = getThreeRenderer(this.host);
                        const session = getXRSession(this.host);
                        if (session != null) {
                            this.provider.onSessionStart(threeRenderer, session);
                            this.sessionActive = true;
                        }
                    }
                    catch (err) {
                        console.warn('[model-viewer-webxr-capture] could not initialize capture for ' +
                            'session-started:', err);
                    }
                }
                this.updateShutterVisibility();
            }
            else if (status === 'not-presenting' || status === 'failed') {
                if (this.sessionActive) {
                    this.provider.onSessionEnd();
                    this.sessionActive = false;
                }
                this.classList.remove('shutter-enabled');
                this.hidePreview();
            }
        };
        this.onBeforeXRSelect = (event) => {
            event.preventDefault();
        };
        this.onShutterClick = () => {
            const flash = this.flashEl;
            if (flash != null) {
                // Match 8thwall: instant white (.flashing has 0s transition), then
                // fade back via the default 0.6s opacity transition.
                flash.classList.add('flashing');
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => flash.classList.remove('flashing'));
                });
            }
            this.captureWebXRScreenshot()
                .then((blob) => {
                if (blob != null) {
                    this.showPreview(blob);
                }
            })
                .catch((err) => {
                console.warn('[model-viewer-webxr-capture] capture failed:', err);
            });
        };
        this.hidePreview = () => {
            var _a, _b;
            if (!this.classList.contains('preview-open')) {
                return;
            }
            (_a = this.previewEl) === null || _a === void 0 ? void 0 : _a.classList.remove('fade-in');
            // Bring the shutter back via the same fade transition.
            (_b = this.shutterEl) === null || _b === void 0 ? void 0 : _b.classList.remove('fade-container');
            // Hide the <img> immediately so the broken-image icon never flashes
            // through the fade-out; clear src after the transition completes.
            if (this.previewImg != null) {
                this.previewImg.style.visibility = 'hidden';
            }
            if (this.clearSrcTimer !== 0) {
                clearTimeout(this.clearSrcTimer);
            }
            this.clearSrcTimer = window.setTimeout(() => {
                if (this.previewImg != null) {
                    this.previewImg.removeAttribute('src');
                }
                this.classList.remove('preview-open');
                this.releaseCurrentBlob();
                this.clearSrcTimer = 0;
            }, PREVIEW_FADE_MS);
            this.dispatchEvent(new CustomEvent('webxr-capture-preview-closed'));
        };
        this.onActionClick = async () => {
            var _a;
            const blob = this.currentBlob;
            const url = this.currentUrl;
            if (blob == null || url == null) {
                return;
            }
            const filename = `${this.filenamePrefix}-${Date.now()}.jpg`;
            const file = new File([blob], filename, { type: blob.type });
            const nav = navigator;
            if ((_a = nav.canShare) === null || _a === void 0 ? void 0 : _a.call(nav, { files: [file] })) {
                try {
                    await nav.share({ files: [file], title: this.shareTitle });
                    return;
                }
                catch (err) {
                    if (err != null && err.name === 'AbortError') {
                        return;
                    }
                    console.warn('[model-viewer-webxr-capture] share failed, falling back to download:', err);
                }
            }
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
        };
    }
    /**
     * True when the active WebXR AR session has the `camera-access` feature
     * enabled. False before the session starts, after it ends, or when no
     * session is active.
     */
    get canCaptureWebXRScreenshot() {
        return this.provider.supported;
    }
    /**
     * Captures the current WebXR AR view (camera passthrough composed with the
     * rendered 3D scene) as a Blob. Resolves with `null` when capture is
     * unavailable. Also dispatches an `ar-screenshot` event with the result.
     */
    async captureWebXRScreenshot(options) {
        const blob = await this.provider.requestCapture(options);
        this.dispatchEvent(new CustomEvent('ar-screenshot', { detail: { blob, success: blob !== null } }));
        return blob;
    }
    connectedCallback() {
        super.connectedCallback();
        // Suppress WebXR transient-input select for taps that hit our overlay UI,
        // per the WebXR DOM Overlays spec — otherwise a shutter / preview tap also
        // re-places or drags the AR model.
        this.addEventListener('beforexrselect', this.onBeforeXRSelect);
        this.resolveHost();
    }
    disconnectedCallback() {
        super.disconnectedCallback();
        this.removeEventListener('beforexrselect', this.onBeforeXRSelect);
        this.detachHost();
        this.releaseCurrentBlob();
    }
    updated(changed) {
        if (changed.has('for')) {
            this.detachHost();
            this.resolveHost();
        }
    }
    render() {
        return html `
      <div class="flash" aria-hidden="true"></div>
      <div class="shutter" part="shutter">
        <svg class="progress-container" viewBox="0 0 38 38" aria-hidden="true">
          <circle class="progress-track" cx="19" cy="19" r="16"></circle>
        </svg>
        <button class="recorder-button style-reset" type="button"
            aria-label="Capture AR snapshot"
            @click=${this.onShutterClick}></button>
      </div>
      <div class="preview" part="preview" role="dialog"
          aria-label="AR snapshot preview">
        <div class="top-bar">
          <div class="preview-box">
            <button class="preview-close style-reset icon-button" type="button"
                aria-label="Close preview" @click=${this.hidePreview}>
              ${CaptureCloseIcon}
            </button>
            <img class="preview-image" alt="AR snapshot preview">
          </div>
        </div>
        <div class="bottom-bar">
          <button class="action-button style-reset" type="button"
              @click=${this.onActionClick}>
            <span class="action-text">${this.actionText}</span>
            ${CaptureDownloadIcon}
          </button>
        </div>
      </div>
    `;
    }
    resolveHost() {
        var _a;
        const root = this.getRootNode();
        const host = (this.for != null && this.for.length > 0) ?
            (_a = root.getElementById) === null || _a === void 0 ? void 0 : _a.call(root, this.for) :
            this.closest('model-viewer');
        if (host == null) {
            return;
        }
        this.host = host;
        try {
            ensureGlobalPatches();
            ensureFrameHook(host);
            this.unsubscribeFrame = subscribe(host, this.onFrameTick);
        }
        catch (err) {
            console.warn('[model-viewer-webxr-capture] failed to attach to <model-viewer>:', err);
            this.host = null;
            return;
        }
        host.addEventListener('ar-status', this.onARStatus);
        // Plugin attached after AR is already running cannot retroactively
        // request `'camera-access'` for the live session — capture will be
        // available only on the next AR session.
        try {
            if (getARRenderer(host).isPresenting) {
                console.warn('[model-viewer-webxr-capture] attached while AR session is active; ' +
                    'capture will be available on the next AR session.');
            }
        }
        catch (_b) {
            // Symbol resolution already validated above; this is a safety net.
        }
    }
    detachHost() {
        if (this.host == null) {
            return;
        }
        this.host.removeEventListener('ar-status', this.onARStatus);
        if (this.unsubscribeFrame != null) {
            this.unsubscribeFrame();
            this.unsubscribeFrame = null;
        }
        if (this.sessionActive) {
            this.provider.onSessionEnd();
            this.sessionActive = false;
        }
        this.host = null;
    }
    updateShutterVisibility() {
        if (this.canCaptureWebXRScreenshot) {
            this.classList.add('shutter-enabled');
        }
        else {
            this.classList.remove('shutter-enabled');
        }
    }
    showPreview(blob) {
        var _a, _b;
        this.releaseCurrentBlob();
        this.currentBlob = blob;
        this.currentUrl = URL.createObjectURL(blob);
        if (this.previewImg != null) {
            this.previewImg.style.visibility = '';
            this.previewImg.src = this.currentUrl;
        }
        this.classList.add('preview-open');
        (_a = this.previewEl) === null || _a === void 0 ? void 0 : _a.classList.add('fade-in');
        // Hide the shutter behind the preview during the fade-in.
        (_b = this.shutterEl) === null || _b === void 0 ? void 0 : _b.classList.add('fade-container');
        this.dispatchEvent(new CustomEvent('webxr-capture-preview-opened', { detail: { blob } }));
    }
    releaseCurrentBlob() {
        if (this.currentUrl != null) {
            URL.revokeObjectURL(this.currentUrl);
        }
        this.currentUrl = null;
        this.currentBlob = null;
    }
};
ModelViewerWebXRCapture.styles = captureUIStyles;
__decorate([
    property({ type: String })
], ModelViewerWebXRCapture.prototype, "for", void 0);
__decorate([
    property({ type: String, attribute: 'action-text' })
], ModelViewerWebXRCapture.prototype, "actionText", void 0);
__decorate([
    property({ type: String, attribute: 'filename-prefix' })
], ModelViewerWebXRCapture.prototype, "filenamePrefix", void 0);
__decorate([
    property({ type: String, attribute: 'share-title' })
], ModelViewerWebXRCapture.prototype, "shareTitle", void 0);
__decorate([
    query('.flash')
], ModelViewerWebXRCapture.prototype, "flashEl", void 0);
__decorate([
    query('.shutter')
], ModelViewerWebXRCapture.prototype, "shutterEl", void 0);
__decorate([
    query('.preview')
], ModelViewerWebXRCapture.prototype, "previewEl", void 0);
__decorate([
    query('.preview-image')
], ModelViewerWebXRCapture.prototype, "previewImg", void 0);
ModelViewerWebXRCapture = __decorate([
    customElement('model-viewer-webxr-capture')
], ModelViewerWebXRCapture);

export { ModelViewerWebXRCapture };
//# sourceMappingURL=model-viewer-webxr-capture.js.map
