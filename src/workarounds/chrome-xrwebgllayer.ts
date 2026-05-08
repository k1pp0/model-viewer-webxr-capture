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

import {
  LinearFilter,
  RGBAFormat,
  Texture,
  UnsignedByteType,
  WebGLRenderer,
} from 'three';

type RendererProps = {
  get(t: Texture): Record<string, unknown> | undefined
};

const UPDATE_RENDER_STATE_MARKER = '__captureUpdateRenderStateWrapped';

export function applyProjectionLayerWorkaround(): void {
  const win = window as unknown as {
    XRWebGLBinding?: { prototype: { createProjectionLayer?: unknown } };
  };
  try {
    if (win.XRWebGLBinding != null &&
      win.XRWebGLBinding.prototype.createProjectionLayer != null) {
      delete win.XRWebGLBinding.prototype.createProjectionLayer;
    }
  } catch (e) {
    console.warn(
      '[model-viewer-webxr-capture] Could not delete projection-layer ' +
      'prototype; AR capture may crash on Chrome 147+.',
      e);
  }
}

export function ensureXRCameraTexture(
  current: Texture | null,
  xrCamera: { width?: number; height?: number },
  canvasWidth: number,
  canvasHeight: number,
): Texture {
  if (current != null) {
    return current;
  }
  const tex = new Texture();
  (tex as unknown as { image: object }).image = {
    width: xrCamera.width ?? canvasWidth,
    height: xrCamera.height ?? canvasHeight,
  };
  tex.flipY = false;
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export function bindXRCameraTexture(
  renderer: WebGLRenderer,
  tex: Texture,
  glTexture: WebGLTexture,
): void {
  const props = (renderer.properties as RendererProps).get(tex)!;
  props.__webglTexture = glTexture;
  props.__webglInit = true;
}

export function releaseXRCameraTexture(
  renderer: WebGLRenderer,
  tex: Texture,
): void {
  const props = (renderer.properties as RendererProps).get(tex);
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
export function applyUpdateRenderStateWorkaround(): void {
  type PatchedProto = {
    updateRenderState: ((options?: XRRenderStateInit) => void) &
      { [UPDATE_RENDER_STATE_MARKER]?: boolean };
  };
  const proto = XRSession.prototype as unknown as PatchedProto;
  if (proto.updateRenderState[UPDATE_RENDER_STATE_MARKER] === true) {
    return;
  }
  const original = proto.updateRenderState;
  const baseLayerBySession = new WeakMap<XRSession, XRWebGLLayer>();
  const wrapped: typeof proto.updateRenderState = function (
    this: XRSession, options?: XRRenderStateInit) {
    if (options?.baseLayer != null) {
      baseLayerBySession.set(this, options.baseLayer as XRWebGLLayer);
    }
    const last = baseLayerBySession.get(this);
    original.call(
      this, last != null ? { baseLayer: last, ...options } : options);
  };
  wrapped[UPDATE_RENDER_STATE_MARKER] = true;
  proto.updateRenderState = wrapped;
}
