/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

/**
 * Bridges this plugin to an unmodified upstream `<model-viewer>` element by:
 *
 *  1. Resolving private Symbols (`$scene`, `$renderer`) on the host element
 *     via prototype-chain reflection — `Symbol(description)` arguments survive
 *     minification, so the description-based lookup is stable across builds.
 *  2. Lazily monkey-patching `navigator.xr.requestSession` once globally to
 *     append `'camera-access'` to `optionalFeatures` of `'immersive-ar'`
 *     requests, and deleting `XRWebGLBinding.prototype.createProjectionLayer`
 *     to dodge a Chrome 147+ regression (three.js #33404).
 *  3. Wrapping the singleton `ARRenderer.onWebXRFrame` once globally with a
 *     post-original dispatcher that calls subscribed plugin instances back
 *     with `(view, scene, viewCamera)` matching the host that owns the AR
 *     session for that frame.
 *
 * All side-effecting installs are idempotent and gated on the first plugin
 * `connectedCallback` — pages that import this module without using
 * `<model-viewer-webxr-capture>` see no behavior change.
 */

import type { ArrayCamera, Camera, Scene, WebGLRenderer } from 'three';

import {
  applyProjectionLayerWorkaround,
  applyUpdateRenderStateWorkaround,
} from './workarounds/chrome-xrwebgllayer.js';

interface FrameSubscriber {
  host: HTMLElement;
  callback: (view: XRView, scene: Scene, viewCamera: Camera) => void;
}

const subscribers = new Set<FrameSubscriber>();
const symbolCache = new WeakMap<object, Map<string, symbol | null>>();

let globalPatchesInstalled = false;
let frameHookInstalled = false;
let cachedARRenderer: unknown = null;

const NAVIGATOR_XR_MARKER = '__captureXRRequestSessionWrapped';
const FRAME_HOOK_MARKER = '__captureOnWebXRFrameWrapped';

/**
 * Walks an object's own properties and prototype chain looking for a symbol
 * whose `.description` matches `description`. Caches results by (proto, desc).
 */
export function findSymbol(obj: unknown, description: string): symbol | null {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return null;
  }
  let target: object | null = obj as object;
  while (target != null) {
    let perTarget = symbolCache.get(target);
    if (perTarget == null) {
      perTarget = new Map();
      symbolCache.set(target, perTarget);
    }
    if (perTarget.has(description)) {
      const cached = perTarget.get(description) ?? null;
      if (cached != null) {
        return cached;
      }
    } else {
      const own = Object.getOwnPropertySymbols(target).find(
        (s) => s.description === description);
      perTarget.set(description, own ?? null);
      if (own != null) {
        return own;
      }
    }
    target = Object.getPrototypeOf(target);
  }
  return null;
}

function readSymbolProperty<T = unknown>(
  host: HTMLElement, description: string, name: string): T {
  const sym = findSymbol(host, description);
  if (sym == null) {
    throw new Error(
      `[model-viewer-webxr-capture] Could not find ${name} on the host ` +
      '<model-viewer>. This usually means @google/model-viewer was ' +
      'upgraded to an incompatible major version. Pin to ^4.2.0 or file ' +
      'an issue at https://github.com/k1pp0/model-viewer-webxr-capture/issues.');
  }
  return (host as unknown as Record<symbol, T>)[sym];
}

/**
 * Returns the host element's internal `ModelScene` (a three.js Scene).
 */
export function getModelScene(host: HTMLElement): Scene {
  return readSymbolProperty<Scene>(host, 'scene', '$scene');
}

interface UpstreamRenderer {
  threeRenderer: WebGLRenderer;
  arRenderer: UpstreamARRenderer;
}

interface UpstreamARRenderer {
  presentedScene: Scene | null;
  isPresenting: boolean;
  frame: XRFrame | null;
  threeRenderer: WebGLRenderer;
  onWebXRFrame: ((time: number, frame: XRFrame) => void) &
  { [FRAME_HOOK_MARKER]?: boolean };
}

/**
 * Returns the host's internal `Renderer` (the wrapper that owns the
 * `WebGLRenderer` and the singleton `ARRenderer`).
 */
export function getRenderer(host: HTMLElement): UpstreamRenderer {
  return readSymbolProperty<UpstreamRenderer>(host, 'renderer', '$renderer');
}

export function getThreeRenderer(host: HTMLElement): WebGLRenderer {
  return getRenderer(host).threeRenderer;
}

export function getARRenderer(host: HTMLElement): UpstreamARRenderer {
  return getRenderer(host).arRenderer;
}

/**
 * Returns the live `XRSession` if one is active on the host's renderer,
 * otherwise `null`.
 */
export function getXRSession(host: HTMLElement): XRSession | null {
  const xr =
    getThreeRenderer(host).xr as unknown as { getSession(): XRSession | null };
  return xr.getSession();
}

interface XRWithRequestSession extends XRSystem {
  requestSession(mode: XRSessionMode, options?: XRSessionInit & {
    optionalFeatures?: string[];
  }): Promise<XRSession>;
  [NAVIGATOR_XR_MARKER]?: boolean;
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
export function ensureGlobalPatches(): void {
  if (globalPatchesInstalled) {
    return;
  }
  globalPatchesInstalled = true;

  const xr = (typeof navigator !== 'undefined' ? navigator.xr : null) as
    XRWithRequestSession |
    null;
  if (xr != null && xr[NAVIGATOR_XR_MARKER] !== true &&
    typeof xr.requestSession === 'function') {
    const original = xr.requestSession.bind(xr);
    xr.requestSession = function (mode, options) {
      if (mode === 'immersive-ar') {
        const opts = options ?? {};
        const optional = Array.isArray(opts.optionalFeatures) ?
          opts.optionalFeatures.slice() :
          [];
        if (optional.indexOf('camera-access') === -1) {
          optional.push('camera-access');
        }
        return original(mode, { ...opts, optionalFeatures: optional });
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
export function ensureFrameHook(host: HTMLElement): void {
  if (frameHookInstalled) {
    return;
  }
  const arRenderer = getARRenderer(host);
  cachedARRenderer = arRenderer;

  if (arRenderer.onWebXRFrame[FRAME_HOOK_MARKER] === true) {
    frameHookInstalled = true;
    return;
  }

  const original = arRenderer.onWebXRFrame.bind(arRenderer);
  const wrapped: typeof arRenderer.onWebXRFrame = function (
    time: number, frame: XRFrame) {
    original(time, frame);
    dispatchFrame(arRenderer);
  };
  wrapped[FRAME_HOOK_MARKER] = true;
  arRenderer.onWebXRFrame = wrapped;
  frameHookInstalled = true;
}

function dispatchFrame(arRenderer: UpstreamARRenderer): void {
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

  const xr = arRenderer.threeRenderer.xr as unknown as {
    getReferenceSpace(): XRReferenceSpace | null;
    getCamera(): ArrayCamera | Camera;
  };
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
  const cameras = (xrCamera as ArrayCamera).cameras;
  const viewCamera =
    cameras != null && cameras.length > 0 ? cameras[0] : (xrCamera as Camera);

  for (const sub of subscribers) {
    let hostScene: Scene | null = null;
    try {
      hostScene = getModelScene(sub.host);
    } catch {
      continue;
    }
    if (hostScene === scene) {
      try {
        sub.callback(view, scene, viewCamera);
      } catch (e) {
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
export function subscribe(
  host: HTMLElement,
  callback: (view: XRView, scene: Scene, viewCamera: Camera) => void): () =>
    void {
  const entry: FrameSubscriber = { host, callback };
  subscribers.add(entry);
  return () => {
    subscribers.delete(entry);
  };
}

/**
 * For tests. Returns the singleton ARRenderer last seen by the bridge, or
 * null if no plugin has connected yet.
 */
export function _getCachedARRenderer(): unknown {
  return cachedARRenderer;
}

/**
 * For tests. Returns the live subscriber count.
 */
export function _getSubscriberCount(): number {
  return subscribers.size;
}
