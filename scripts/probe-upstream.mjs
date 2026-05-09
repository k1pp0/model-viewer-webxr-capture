#!/usr/bin/env node
/**
 * Headless probe: verifies that `@k1pp0/model-viewer-webxr-capture` wires
 * correctly against an UNMODIFIED upstream `@google/model-viewer` loaded
 * from a public CDN.
 *
 * What it checks (no real WebXR session required):
 *
 *  - Both custom elements are defined (`model-viewer`, `model-viewer-webxr-capture`).
 *  - No `pageerror` events fire during page load and plugin connect.
 *  - The plugin's Symbol reflection finds `$scene` and `$renderer` on the host.
 *  - `navigator.xr.requestSession` is wrapped exactly once (idempotent guard).
 *  - `arRenderer.onWebXRFrame` is wrapped (the per-frame dispatcher is in place).
 *
 * This is a wiring test, not an end-to-end test. Live capture verification
 * still requires a real Pixel / WebXR-capable device.
 *
 * Usage:
 *   node scripts/probe-upstream.mjs
 *
 * Optional env:
 *   MODEL_VIEWER_VERSION   pin the upstream version (default 4.2.0)
 *   PROBE_PORT             local HTTP port for the probe (default 9876)
 */

import {createServer} from 'http';
import {readFileSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

import {chromium} from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PROBE_PORT ?? 9876);
const UPSTREAM_VERSION = process.env.MODEL_VIEWER_VERSION ?? '4.2.0';

const PLUGIN_BUNDLED = readFileSync(join(
    ROOT,
    'dist/model-viewer-webxr-capture-bundled.min.js'));

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>upstream-probe</title>
  <script type="module"
    src="https://unpkg.com/@google/model-viewer@${UPSTREAM_VERSION}/dist/model-viewer.min.js"
    crossorigin="anonymous"></script>
  <script type="module" src="/plugin.js"></script>
</head>
<body>
  <model-viewer id="mv"
    src="https://modelviewer.dev/shared-assets/models/Astronaut.glb"
    ar
    style="width:300px;height:300px"></model-viewer>
  <script>
    customElements.whenDefined('model-viewer').then(async () => {
      await customElements.whenDefined('model-viewer-webxr-capture');
      const cap = document.createElement('model-viewer-webxr-capture');
      document.getElementById('mv').appendChild(cap);
      await cap.updateComplete;
      window.__probeReady = true;
    });
  </script>
</body>
</html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(HTML);
        return;
      }
      if (req.url === '/plugin.js') {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(PLUGIN_BUNDLED);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  let exitCode = 0;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    if (process.env.PROBE_DEBUG) {
      page.on('console', (msg) => console.log('[page]', msg.type(), msg.text()));
      page.on('requestfailed', (req) =>
        console.log('[req-failed]', req.url(), req.failure()?.errorText));
    }

    await page.goto(`http://localhost:${PORT}/`);
    try {
      await page.waitForFunction(
          () => (window).__probeReady === true, {timeout: 30000});
    } catch (err) {
      console.error('Timed out waiting for __probeReady. Errors so far:');
      console.error(errors.join('\n'));
      throw err;
    }

    const result = await page.evaluate(() => {
      function findSymbol(obj, description) {
        let target = obj;
        while (target != null) {
          const own = Object.getOwnPropertySymbols(target).find(
              (s) => s.description === description);
          if (own != null) return own;
          target = Object.getPrototypeOf(target);
        }
        return null;
      }
      const mv = document.querySelector('model-viewer');
      const cap = document.querySelector('model-viewer-webxr-capture');

      const sceneSym = findSymbol(mv, 'scene');
      const rendererSym = findSymbol(mv, 'renderer');
      const renderer = rendererSym != null ? mv[rendererSym] : null;
      const ar = renderer != null ? renderer.arRenderer : null;
      const xr = navigator.xr;

      return {
        mvDefined: customElements.get('model-viewer') != null,
        capDefined: customElements.get('model-viewer-webxr-capture') != null,
        sceneSymOk: sceneSym != null,
        rendererSymOk: rendererSym != null,
        threeRendererOk:
            renderer != null && typeof renderer.threeRenderer === 'object',
        arRendererOk: ar != null && typeof ar.onWebXRFrame === 'function',
        frameWrapperMarker:
            ar != null && ar.onWebXRFrame['__captureOnWebXRFrameWrapped'] ===
                true,
        xrAvailable: xr != null,
        requestSessionWrapped:
            xr != null && xr['__captureXRRequestSessionWrapped'] === true,
        canCapture: cap.canCaptureWebXRScreenshot,
      };
    });

    console.log('Probe result:', JSON.stringify(result, null, 2));
    if (errors.length > 0) {
      console.error('Page errors observed:\n' + errors.join('\n'));
      exitCode = 2;
    }

    const required = [
      'mvDefined',
      'capDefined',
      'sceneSymOk',
      'rendererSymOk',
      'threeRendererOk',
      'arRendererOk',
      'frameWrapperMarker',
    ];
    for (const key of required) {
      if (result[key] !== true) {
        console.error(`Probe failed: ${key} expected true, got ${result[key]}`);
        exitCode = 1;
      }
    }

    if (result.xrAvailable && result.requestSessionWrapped !== true) {
      console.error(
          'Probe failed: navigator.xr is present but requestSession was not wrapped');
      exitCode = 1;
    }

    if (exitCode === 0) {
      console.log('Probe OK: plugin wires cleanly to upstream model-viewer ' +
                  UPSTREAM_VERSION);
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
