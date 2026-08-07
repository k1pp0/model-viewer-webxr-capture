/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

import { Camera, Mesh, PlaneGeometry, Scene, ShaderMaterial, SRGBColorSpace, WebGLRenderer, WebGLRenderTarget } from 'three';

import { CAMERA_QUAD_FRAGMENT_SHADER, CAMERA_QUAD_VERTEX_SHADER } from './WebXRCaptureShaders.js';

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

// XRCamera is part of the Raw Camera Access API but absent from @types/webxr.
// TODO: remove once @types/webxr@>0.5.24 adds XRCamera.
export interface XRCamera {
  readonly width: number;
  readonly height: number;
}

// XRView.camera is part of the Raw Camera Access API but absent
// from @types/webxr.
// TODO: remove once @types/webxr@>0.5.24 adds XRView.camera.
export interface XRViewWithCamera extends XRView {
  readonly camera?: XRCamera;
}

/**
 * Implements WebXR AR screenshot capture by composing the raw camera image
 * with the rendered 3D scene into a single Blob.
 *
 *  - Reads the raw camera frame from three.js via
 *    `renderer.xr.getCameraTexture(view.camera)`; the WebXRManager owns the
 *    `XRWebGLBinding` and refreshes the texture once per XR frame when the
 *    session has `camera-access` enabled.
 *  - Adds the background quad as a scene member with renderOrder=-999
 *    and toggles renderer.xr.enabled = false during the offscreen render.
 */
export class WebXRCapture {
  private bgQuad: Mesh | null = null;
  private renderTarget: WebGLRenderTarget | null = null;
  private pendingCapture: PendingCapture | null = null;

  constructor(private readonly threeRenderer: WebGLRenderer) {
    this.bgQuad = this.createBackgroundQuad();
  }

  /**
   * Schedule a capture for the next XRFrame. Rejects if a capture is already
   * pending.
   */
  requestCapture(options: WebXRCaptureOptions = {}): Promise<Blob | null> {
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
    if (this.renderTarget != null) {
      this.renderTarget.dispose();
      this.renderTarget = null;
    }

    if (this.bgQuad != null) {
      this.bgQuad.geometry.dispose();
      (this.bgQuad.material as ShaderMaterial).dispose();
      this.bgQuad = null;
    }

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

    const rawCamera = (view as XRViewWithCamera).camera;
    if (rawCamera == null) {
      console.warn(
        '[WebXRCapture] view.camera unavailable; session may not have ' +
        'camera-access enabled.');
      pending.resolve(null);
      return;
    }

    // getCameraTexture() expects WebXRCamera (PerspectiveCamera) but the actual
    // key is XRCamera.
    // TODO: remove once @types/three@>0.182.0 correctly types
    // getCameraTexture().
    type GetCameraTextureParam =
      Parameters<typeof renderer.xr.getCameraTexture>[0];
    const cameraTexture = renderer.xr.getCameraTexture(
      rawCamera as unknown as GetCameraTextureParam);
    if (cameraTexture == null) {
      console.warn('[WebXRCapture] No camera texture available for capture.');
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

    const bgQuad = this.bgQuad!;
    (bgQuad.material as ShaderMaterial).uniforms.cameraTex.value =
      cameraTexture;

    modelScene.add(bgQuad);
    const prevTarget = renderer.getRenderTarget();
    const wasXrEnabled = renderer.xr.enabled;
    try {
      renderer.xr.enabled = false;
      renderer.setRenderTarget(renderTarget);
      // Force GL write masks on, mirroring upstream Shadow.render().
      renderer.state.buffers.color.setMask(true);
      renderer.state.buffers.depth.setMask(true);
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
    if (this.renderTarget != null) {
      this.renderTarget.setSize(width, height);
      return;
    }
    this.renderTarget = new WebGLRenderTarget(width, height, {
      colorSpace: SRGBColorSpace,
    });
    // Mimic the live XR framebuffer (three.js #23278): renderer.toneMapping
    // and shader-side sRGB encoding apply, while RGBA8 storage avoids a
    // second hardware encode and keeps blending in sRGB space — otherwise
    // the semi-transparent AR floor shadow captures at half strength.
    (this.renderTarget as WebGLRenderTarget & { isXRRenderTarget?: boolean })
      .isXRRenderTarget = true;
    this.renderTarget.texture.internalFormat = 'RGBA8';
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
