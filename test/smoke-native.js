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
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function outputs(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index].indexOf('<<');
    if (marker !== -1) {
      const key = lines[index].slice(0, marker);
      const end = lines[index].slice(marker + 2);
      const parts = [];
      while (++index < lines.length && lines[index] !== end) parts.push(lines[index]);
      values[key] = parts.join('\n');
    } else {
      const equal = lines[index].indexOf('=');
      if (equal !== -1) values[lines[index].slice(0, equal)] = lines[index].slice(equal + 1);
    }
  }
  return values;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'te-native-smoke-'));
  const extension = process.platform === 'win32' ? '.exe' : '';
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('INPUT_') && !['TE_TOKEN', 'TE_BASE_URL', 'TE_API_CLI_PATH'].includes(name)));
  Object.assign(env, { GITHUB_WORKSPACE: root, RUNNER_TEMP: temporary });
  let mock;
  try {
    const start = spawnSync(process.execPath, ['test/start-mock.js'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    if (start.status !== 0) throw new Error('The owned local mock API did not start.');
    mock = JSON.parse(start.stdout.trim());
    const checks = {};
    for (const [name, expected] of [['healthy', 0], ['blocking', 1], ['non-blocking', 0], ['incomplete', 1], ['api-error', 1]]) {
      const output = path.join(temporary, name + '.outputs');
      await fs.writeFile(output, '');
      await fs.writeFile(path.join(temporary, name + '.summary'), '');
      const result = spawnSync(process.execPath, ['dist/index.js'], {
        cwd: root, encoding: 'utf8', timeout: 120000,
        env: {
          ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(temporary, name + '.summary'),
          'INPUT_API-TOKEN': 'action-ci-fake-token', 'INPUT_CONFIG-PATH': `.smoke/${name}.json`,
          'INPUT_RUNNER-PATH': path.join(root, 'build/bin/te-synthetics' + extension),
          'INPUT_API-CLI-PATH': path.join(root, 'build/bin/thousandeyes' + extension),
          'INPUT_API-BASE-URL': mock.apiBaseURL
        }
      });
      const report = outputs(await fs.readFile(output, 'utf8'));
      if (result.status !== expected) {
        const detail = report['json-report'] ? await fs.readFile(report['json-report'], 'utf8').catch(() => '') : '';
        const annotation = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith('::error::')).join('\n');
        throw new Error(`${name} expected exit ${expected}, got ${result.status}. ${annotation}\nSanitized report: ${detail}`);
      }
      const key = name.toUpperCase().replaceAll('-', '_');
      checks[key + '_REPORT'] = report['json-report'];
      checks[key + '_OUTCOME'] = result.status === 0 ? 'success' : 'failure';
    }
    const verify = spawnSync(process.execPath, ['test/assert-smoke.js'], { cwd: root, env: { ...env, ...checks }, encoding: 'utf8' });
    if (verify.status !== 0) throw new Error(verify.stderr || 'The native report assertions failed.');
    console.log(verify.stdout.trim());
  } finally {
    if (mock && Number.isInteger(mock.pid) && mock.pid > 0) {
      try { process.kill(mock.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.rm(path.join(root, '.smoke'), { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
