/*
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modifications copyright 2026 k1pp0
 * SPDX-License-Identifier: Apache-2.0
 */

import { nodeResolve as resolve } from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';

const { NODE_ENV } = process.env;

const onwarn = (warning, warn) => {
  if (warning.code !== 'THIS_IS_UNDEFINED') {
    warn(warning);
  }
};

const basePlugins = [
  resolve(),
  replace({ 'Reflect.decorate': 'undefined', preventAssignment: true }),
];

const watchFiles = ['lib/**'];

const outputOptions = [
  {
    input: './lib/model-viewer-webxr-capture.js',
    output: {
      file: './dist/model-viewer-webxr-capture.js',
      sourcemap: true,
      format: 'esm',
      name: 'ModelViewerWebXRCapture',
      globals: { three: 'three' },
    },
    watch: { include: watchFiles },
    plugins: basePlugins,
    external: ['three', /^lit/],
    onwarn,
  },
];

if (NODE_ENV !== 'development') {
  outputOptions.push({
    input: './dist/model-viewer-webxr-capture.js',
    output: {
      file: './dist/model-viewer-webxr-capture.min.js',
      sourcemap: true,
      format: 'esm',
      name: 'ModelViewerWebXRCapture',
      globals: { three: 'three' },
    },
    watch: { include: watchFiles },
    plugins: [...basePlugins, terser()],
    external: ['three', /^lit/],
    onwarn,
  });

  // Self-contained bundle for static HTML drop-in deployment, where there
  // is no bundler and no import map. Three.js and Lit are included so the
  // file can be loaded alongside `model-viewer.min.js` without any extra setup.
  outputOptions.push({
    input: './lib/model-viewer-webxr-capture.js',
    output: {
      file: './dist/model-viewer-webxr-capture-bundled.min.js',
      sourcemap: true,
      format: 'esm',
      name: 'ModelViewerWebXRCapture',
    },
    watch: { include: watchFiles },
    plugins: [...basePlugins, terser()],
    onwarn,
  });

  outputOptions.push({
    input: './lib/model-viewer-webxr-capture.d.ts',
    output: {
      file: './dist/model-viewer-webxr-capture.d.ts',
      format: 'esm',
      name: 'ModelViewerWebXRCapture',
    },
    plugins: [dts()],
  });
}

export default outputOptions;
