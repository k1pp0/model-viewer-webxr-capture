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
export const CAMERA_QUAD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.999, 1.0);
  }
`;

export const CAMERA_QUAD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D cameraTex;
  varying vec2 vUv;
  void main() {
    vec4 color = texture2D(cameraTex, vUv);
    color.rgb = pow(color.rgb, vec3(2.2));
    gl_FragColor = color;
  }
`;
