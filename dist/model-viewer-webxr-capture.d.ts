import * as lit from 'lit';
import { LitElement, PropertyValues, TemplateResult } from 'lit';

interface WebXRCaptureOptions {
    mimeType?: string;
    qualityArgument?: number;
    /** Output width in pixels. Defaults to the WebGL canvas width. */
    width?: number;
    /** Output height in pixels. Defaults to the WebGL canvas height. */
    height?: number;
}

interface WebXRScreenshotDetails {
    blob: Blob | null;
    success: boolean;
}
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
declare class ModelViewerWebXRCapture extends LitElement {
    static styles: lit.CSSResult;
    /** ID of the host `<model-viewer>` element. */
    for?: string;
    actionText: string;
    filenamePrefix: string;
    shareTitle: string;
    private flashEl;
    private shutterEl;
    private previewEl;
    private previewImg;
    private host;
    private provider;
    private unsubscribeFrame;
    private sessionActive;
    private currentBlob;
    private currentUrl;
    private clearSrcTimer;
    /**
     * True when the active WebXR AR session has the `camera-access` feature
     * enabled. False before the session starts, after it ends, or when no
     * session is active.
     */
    get canCaptureWebXRScreenshot(): boolean;
    /**
     * Captures the current WebXR AR view (camera passthrough composed with the
     * rendered 3D scene) as a Blob. Resolves with `null` when capture is
     * unavailable. Also dispatches an `ar-screenshot` event with the result.
     */
    captureWebXRScreenshot(options?: WebXRCaptureOptions): Promise<Blob | null>;
    connectedCallback(): void;
    disconnectedCallback(): void;
    protected updated(changed: PropertyValues<this>): void;
    protected render(): TemplateResult;
    private resolveHost;
    private detachHost;
    private onFrameTick;
    private onARStatus;
    private updateShutterVisibility;
    private onBeforeXRSelect;
    private onShutterClick;
    private showPreview;
    private hidePreview;
    private onActionClick;
    private releaseCurrentBlob;
}
declare global {
    interface HTMLElementTagNameMap {
        'model-viewer-webxr-capture': ModelViewerWebXRCapture;
    }
}

export { ModelViewerWebXRCapture };
export type { WebXRScreenshotDetails };
