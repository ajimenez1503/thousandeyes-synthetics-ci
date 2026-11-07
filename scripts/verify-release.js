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

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installRunner, releaseAsset } = require('../src/install');

async function main() {
  const directory = path.resolve(process.argv[2] || 'build/release');
  const version = process.argv[3];
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'te-release-check-'));
  try {
    for (const platform of ['linux', 'darwin', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        const asset = releaseAsset(version, platform, arch);
        const installed = await installRunner({
          version, platform, arch, tempDirectory: temporary,
          download: async (url, destination) => {
            await fs.copyFile(path.join(directory, path.basename(new URL(url).pathname)), destination);
            return destination;
          }
        });
        assert.equal(path.basename(installed.runnerPath), asset.binaryName);
        assert.equal(path.basename(installed.apiCLIPath), asset.backendName);
        if (platform === process.platform && arch === process.arch) {
          for (const executable of [installed.runnerPath, installed.apiCLIPath]) {
            execFileSync(executable, ['--help'], { stdio: 'pipe', timeout: 15000 });
          }
        }
      }
    }
    console.log('Verified six checksummed release archives, both bundled executables, and native startup.');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(() => { console.error('The native release archive verification failed.'); process.exitCode = 1; });
