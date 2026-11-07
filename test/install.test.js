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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { installRunner, releaseAsset, checksumForAsset } = require('../src/install');

const VERSION = '1.2.3';
const ARCHIVE = Buffer.from('checksummed CLI archive');
const SHA256 = crypto.createHash('sha256').update(ARCHIVE).digest('hex');

async function harness(t, options = {}) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-action-installer-test-'));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  const platform = options.platform || 'linux';
  const arch = options.arch || 'x64';
  const version = options.version || VERSION;
  const asset = releaseAsset(version, platform, arch);
  const calls = { download: [], extract: [] };
  return {
    calls,
    options: {
      version,
      tempDirectory,
      platform,
      arch,
      download: async (url, destination) => {
        calls.download.push({ url, destination });
        const content = url.endsWith('checksums.txt')
          ? (options.manifest ?? `${SHA256}  ${asset.archiveName}\n`)
          : (options.archive ?? ARCHIVE);
        if (options.downloadError) throw new Error(options.downloadError);
        await fs.writeFile(destination, content);
        return destination;
      },
      extract: async (archive, destination, format) => {
        calls.extract.push({ archive, destination, format });
        if (options.extractError) throw new Error(options.extractError);
        await fs.mkdir(destination, { recursive: true });
        if (options.binary === 'missing') return destination;
        const binary = path.join(destination, asset.binaryName);
        if (options.binary === 'directory') await fs.mkdir(binary);
        else if (options.binary === 'symlink') {
          const other = path.join(destination, 'other');
          await fs.writeFile(other, 'other');
          await fs.symlink(other, binary);
        } else await fs.writeFile(binary, 'runner executable', { mode: 0o600 });
        if (options.backend !== 'missing') {
          const backend = path.join(destination, asset.backendName);
          if (options.backend === 'directory') await fs.mkdir(backend);
          else await fs.writeFile(backend, 'API CLI executable', { mode: 0o600 });
        }
        if (options.extra) await fs.writeFile(path.join(destination, options.extra), 'unexpected');
        return destination;
      },
    },
  };
}

for (const [platform, arch, osName, archiveArch, extension, binaryName] of [
  ['linux', 'x64', 'Linux', 'x86_64', 'tar.gz', 'te-synthetics'],
  ['linux', 'arm64', 'Linux', 'arm64', 'tar.gz', 'te-synthetics'],
  ['darwin', 'x64', 'Darwin', 'x86_64', 'tar.gz', 'te-synthetics'],
  ['darwin', 'arm64', 'Darwin', 'arm64', 'tar.gz', 'te-synthetics'],
  ['win32', 'x64', 'Windows', 'x86_64', 'zip', 'te-synthetics.exe'],
  ['win32', 'arm64', 'Windows', 'arm64', 'zip', 'te-synthetics.exe'],
]) {
  test(`installs the exact checksummed ${platform}/${arch} release asset`, async (t) => {
    const h = await harness(t, { platform, arch });
    const installed = await installRunner(h.options);
    const executable = installed.runnerPath;
    assert.equal(path.basename(installed.apiCLIPath), platform === 'win32' ? 'thousandeyes.exe' : 'thousandeyes');
    assert.equal(path.isAbsolute(executable), true);
    assert.equal(path.basename(executable), binaryName);
    const file = await fs.lstat(executable);
    assert.equal(file.isFile(), true);
    // Windows does not expose POSIX executable bits, even for emulated targets.
    if (platform !== 'win32' && process.platform !== 'win32') assert.notEqual(file.mode & 0o111, 0);
    assert.equal(h.calls.download.length, 2);
    assert.equal(h.calls.download[0].url,
      `https://github.com/antonjim-te/thousandeyes-synthetics-ci/releases/download/${VERSION}/te-synthetics_${VERSION}_checksums.txt`);
    assert.equal(h.calls.download[1].url,
      `https://github.com/antonjim-te/thousandeyes-synthetics-ci/releases/download/${VERSION}/te-synthetics_${VERSION}_${osName}_${archiveArch}.${extension}`);
    assert.equal(h.calls.extract[0].format, extension);
    assert.equal(h.calls.extract.length, 1);
  });
}

for (const version of ['', 'latest', 'v1.2.3', '1.2', '1.2.3+build', '../1.2.3', '1.2.3\n', '1.2.3;echo injected', '01.2.3', '1.2.3-01']) {
  test(`rejects an unpinned or malformed CLI version ${JSON.stringify(version)}`, async () => {
    let downloaded = false;
    await assert.rejects(installRunner({ version, tempDirectory: os.tmpdir(), download: async () => { downloaded = true; } }), /version/i);
    assert.equal(downloaded, false);
  });
}

test('rejects unsupported platform or architecture before download', async () => {
  for (const [platform, arch] of [['freebsd', 'x64'], ['linux', 'ia32']]) {
    await assert.rejects(installRunner({ version: VERSION, tempDirectory: os.tmpdir(), platform, arch }), /platform|architecture/i);
  }
});

test('does not extract an archive whose checksum differs', async (t) => {
  const h = await harness(t, { archive: 'tampered archive' });
  await assert.rejects(installRunner(h.options), /checksum/i);
  assert.equal(h.calls.extract.length, 0);
});

for (const manifest of [
  'not a checksum\n',
  `${'a'.repeat(64)}  another-archive.tar.gz\n`,
  `${SHA256}  te-synthetics_${VERSION}_Linux_x86_64.tar.gz\n${SHA256}  te-synthetics_${VERSION}_Linux_x86_64.tar.gz\n`,
  `${SHA256}  te-synthetics_${VERSION}_Linux_x86_64.tar.gz.extra\n`,
  `${SHA256}  te-synthetics_${VERSION}_Linux_x86_64.tar.gz\nmalformed other entry\n`,
]) {
  test('rejects malformed, missing, duplicate, or nonexact checksum entries before extraction', async (t) => {
    const h = await harness(t, { manifest });
    await assert.rejects(installRunner(h.options), /checksum/i);
    assert.equal(h.calls.extract.length, 0);
  });
}

test('accepts CRLF manifests and a binary marker without weakening exact filename matching', () => {
  const name = `te-synthetics_${VERSION}_Linux_x86_64.tar.gz`;
  assert.equal(checksumForAsset(`${SHA256.toUpperCase()} *${name}\r\n`, name), SHA256);
});

for (const binary of ['missing', 'directory', 'symlink']) {
  test(`rejects a ${binary} executable`, async (t) => {
    const h = await harness(t, { binary });
    await assert.rejects(installRunner(h.options), /regular.*executables|unexpected file/i);
  });
}

test('hides network and extraction error contents', async (t) => {
  const sensitive = 'Authorization Bearer fake-secret https://private.example.invalid/path';
  for (const failure of [{ downloadError: sensitive }, { extractError: sensitive }]) {
    const h = await harness(t, failure);
    await assert.rejects(installRunner(h.options), (error) => {
      assert.equal(error.message.includes('fake-secret'), false);
      assert.equal(error.message.includes('private.example.invalid'), false);
      return true;
    });
  }
});

test('does not change PATH while installing', async (t) => {
  const initialPath = process.env.PATH;
  const h = await harness(t);
  await installRunner(h.options);
  assert.equal(process.env.PATH, initialPath);
});

for (const backend of ['missing', 'directory']) {
  test(`rejects a ${backend} API CLI backend`, async (t) => {
    const h = await harness(t, { backend });
    await assert.rejects(installRunner(h.options), /regular.*executables|unexpected file/i);
  });
}

test('rejects unrelated archive contents', async (t) => {
  const h = await harness(t, { extra: 'unrelated-executable' });
  await assert.rejects(installRunner(h.options), /unexpected file/i);
});
