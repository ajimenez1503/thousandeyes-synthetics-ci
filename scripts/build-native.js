// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareBackend } = require('./prepare-backend');

async function main() {
  const root = path.resolve(__dirname, '..');
  const source = await prepareBackend();
  const output = path.join(root, 'build/bin');
  await fs.mkdir(output, { recursive: true });
  const platform = process.env.GOOS || (process.platform === 'win32' ? 'windows' : process.platform);
  const extension = platform === 'windows' ? '.exe' : '';
  const env = { ...process.env, CGO_ENABLED: '0', GOPROXY: process.env.GOPROXY || 'https://proxy.golang.org,direct' };
  delete env.GOROOT;
  for (const [binary, cwd, mainPackage] of [['te-synthetics', root, './cmd/te-synthetics'], ['thousandeyes', source, '.']]) {
    const flags = binary === 'thousandeyes' ? ['-buildvcs=false'] : [];
    execFileSync('go', ['build', '-trimpath', ...flags, '-o', path.join(output, binary + extension), mainPackage], { cwd, env, stdio: 'inherit' });
  }
  console.log('Built the portable runner and its pinned API CLI backend in build/bin.');
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `runner-path=${path.join(output, 'te-synthetics' + extension)}\napi-cli-path=${path.join(output, 'thousandeyes' + extension)}\n`);
  }
}

main().catch(() => { console.error('Could not build the native synthetic CI distribution.'); process.exitCode = 1; });
