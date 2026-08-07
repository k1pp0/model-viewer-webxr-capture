/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

// Background quad rendered behind the 3D scene during capture. The quad is
// drawn with renderOrder = -999 and depthTest/depthWrite disabled, so the
// model always composites on top of it.
//
// The camera texture is already sRGB-encoded and the capture target stores
// sRGB values as-is (no hardware encode), so the fragment passes texels
// through untouched.
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

  void main() {
    gl_FragColor = texture2D(cameraTex, vUv);
  }
`;
