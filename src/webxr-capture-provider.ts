/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

import type { Camera, Scene, WebGLRenderer } from 'three';

import { WebXRCapture, WebXRCaptureOptions } from './three-components/WebXRCapture.js';

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
export class WebXRCaptureProvider {
  private capture: WebXRCapture | null = null;
  private _supported = false;

  /**
   * True once an AR session has started with `camera-access` enabled. False
   * before session start, after session end, or if the device declines the
   * feature.
   */
  get supported(): boolean {
    return this._supported;
  }

  onSessionStart(threeRenderer: WebGLRenderer, session: XRSession): void {
    const sessionAny =
      session as unknown as { enabledFeatures?: ReadonlyArray<string> };
    this._supported = sessionAny.enabledFeatures != null &&
      sessionAny.enabledFeatures.indexOf('camera-access') !== -1;

    if (this._supported) {
      this.capture = new WebXRCapture(threeRenderer, session);
    }
  }

  onFrame(view: XRView, scene: Scene, viewCamera: Camera): void {
    if (this.capture == null) {
      return;
    }
    this.capture.processFrame(view, scene, viewCamera);
  }

  onSessionEnd(): void {
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
  requestCapture(options?: WebXRCaptureOptions): Promise<Blob | null> {
    if (this.capture == null) {
      return Promise.resolve(null);
    }
    return this.capture.requestCapture(options);
  }
}
