/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

// Background quad rendered behind the 3D scene during capture. The quad is
// drawn with renderOrder = -999 and depthTest/depthWrite disabled, so the
// model always composites on top of it.
//
// The fragment decodes the sRGB-encoded camera texture to linear because the
// capture render target is tagged SRGBColorSpace — three.js re-encodes
// linear → sRGB on write, so the camera quad must feed it linear values.
// Without this decode the camera image stays sRGB-correct but the 3D model
// output is darkened.
export const CAMERA_QUAD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export const CAMERA_QUAD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D cameraTex;
  varying vec2 vUv;

  vec3 sRGBToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  void main() {
    vec4 color = texture2D(cameraTex, vUv);
    gl_FragColor = vec4(sRGBToLinear(color.rgb), color.a);
  }
`;
