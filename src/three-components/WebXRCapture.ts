/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

import { Camera, LinearFilter, Mesh, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, SRGBColorSpace, Texture, UnsignedByteType, WebGLRenderer, WebGLRenderTarget } from 'three';

import { CAMERA_QUAD_FRAGMENT_SHADER, CAMERA_QUAD_VERTEX_SHADER } from './WebXRCaptureShaders.js';
import {
  bindXRCameraTexture,
  ensureXRCameraTexture,
  releaseXRCameraTexture,
} from '../workarounds/chrome-xrwebgllayer.js';

export interface WebXRCaptureOptions {
  mimeType?: string;
  qualityArgument?: number;
  /** Output width in pixels. Defaults to the WebGL canvas width. */
  width?: number;
  /** Output height in pixels. Defaults to the WebGL canvas height. */
  height?: number;
}

interface PendingCapture {
  resolve: (blob: Blob | null) => void;
  reject: (error: Error) => void;
  options: WebXRCaptureOptions;
}

interface XRWebGLBindingLike {
  getCameraImage(camera: unknown): WebGLTexture | null;
}

interface XRWebGLBindingCtor {
  new(session: XRSession,
    gl: WebGLRenderingContext | WebGL2RenderingContext): XRWebGLBindingLike;
}

declare const XRWebGLBinding: XRWebGLBindingCtor | undefined;

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
export class WebXRCapture {
  private xrGlBinding: XRWebGLBindingLike | null = null;
  private cameraTexture: Texture | null = null;
  private bgQuad: Mesh | null = null;
  private renderTarget: WebGLRenderTarget | null = null;
  private pendingCapture: PendingCapture | null = null;

  constructor(
    private readonly threeRenderer: WebGLRenderer, session: XRSession) {
    if (typeof XRWebGLBinding === 'undefined') {
      console.warn('[WebXRCapture] XRWebGLBinding is not available.');
      return;
    }
    try {
      const gl = threeRenderer.getContext();
      this.xrGlBinding = new XRWebGLBinding(session, gl);
    } catch (e) {
      console.warn('[WebXRCapture] Failed to create XRWebGLBinding:', e);
      return;
    }
    this.bgQuad = this.createBackgroundQuad();
  }

  /**
   * Schedule a capture for the next XRFrame. Rejects if a capture is already
   * pending.
   */
  requestCapture(options: WebXRCaptureOptions = {}): Promise<Blob | null> {
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
  processFrame(view: XRView, modelScene: Scene, viewCamera: Camera): void {
    const pending = this.pendingCapture;
    if (pending == null) {
      return;
    }
    this.pendingCapture = null;

    try {
      this.executeCapture(view, modelScene, viewCamera, pending);
    } catch (error) {
      console.error('[WebXRCapture] executeCapture threw:', error);
      pending.reject(error as Error);
    }
  }

  /** Release GPU resources. Safe to call after dispose(). */
  dispose(): void {
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
      (this.bgQuad.material as ShaderMaterial).dispose();
      this.bgQuad = null;
    }

    this.xrGlBinding = null;

    if (this.pendingCapture != null) {
      this.pendingCapture.resolve(null);
      this.pendingCapture = null;
    }
  }

  private createBackgroundQuad(): Mesh {
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

  private executeCapture(
    view: XRView, modelScene: Scene, viewCamera: Camera,
    pending: PendingCapture): void {
    const renderer = this.threeRenderer;

    const xrCamera = (view as unknown as { camera?: object }).camera;
    if (xrCamera == null || this.xrGlBinding == null) {
      console.warn(
        '[WebXRCapture] view.camera or XRWebGLBinding unavailable; ' +
        'session may not have camera-access enabled.');
      pending.resolve(null);
      return;
    }

    let glCameraTexture: WebGLTexture | null;
    try {
      glCameraTexture = this.xrGlBinding.getCameraImage(xrCamera);
    } catch (e) {
      console.error('[WebXRCapture] getCameraImage threw:', e);
      pending.resolve(null);
      return;
    }
    if (glCameraTexture == null) {
      pending.resolve(null);
      return;
    }

    const canvas = renderer.domElement;
    const rtWidth =
      Math.max(1, Math.floor(pending.options.width ?? canvas.width));
    const rtHeight =
      Math.max(1, Math.floor(pending.options.height ?? canvas.height));

    this.ensureRenderTarget(rtWidth, rtHeight);
    const renderTarget = this.renderTarget!;

    const xrCameraSize = xrCamera as unknown as {
      width?: number;
      height?: number;
    };
    this.cameraTexture = ensureXRCameraTexture(
      this.cameraTexture,
      xrCameraSize,
      canvas.width,
      canvas.height,
    );
    bindXRCameraTexture(renderer, this.cameraTexture, glCameraTexture);

    const bgQuad = this.bgQuad!;
    (bgQuad.material as ShaderMaterial).uniforms.cameraTex.value =
      this.cameraTexture;

    modelScene.add(bgQuad);
    const prevTarget = renderer.getRenderTarget();
    const wasXrEnabled = renderer.xr.enabled;
    try {
      renderer.xr.enabled = false;
      renderer.setRenderTarget(renderTarget);
      renderer.render(modelScene, viewCamera);
    } finally {
      renderer.xr.enabled = wasXrEnabled;
      renderer.setRenderTarget(prevTarget);
      modelScene.remove(bgQuad);
    }

    const pixels = new Uint8Array(rtWidth * rtHeight * 4);
    renderer.readRenderTargetPixels(
      renderTarget, 0, 0, rtWidth, rtHeight, pixels);

    this.pixelsToBlob(pixels, rtWidth, rtHeight, pending.options)
      .then((blob) => pending.resolve(blob), (err) => pending.reject(err));
  }

  private ensureRenderTarget(width: number, height: number): void {
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

  private async pixelsToBlob(
    pixels: Uint8Array, width: number, height: number,
    options: WebXRCaptureOptions): Promise<Blob | null> {
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
      imageData.data.set(
        pixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }
    ctx.putImageData(imageData, 0, 0);

    return new Promise((resolve) => {
      canvas.toBlob(
        resolve,
        options.mimeType ?? 'image/jpeg',
        options.qualityArgument ?? 0.92);
    });
  }
}
