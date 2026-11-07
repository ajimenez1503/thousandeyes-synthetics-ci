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

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const directory = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'te-action-smoke-'));
  const readyFile = path.join(directory, 'ready.json');
  const log = fs.openSync(path.join(directory, 'mock.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/mock-api.js')], {
    env: { ...process.env, MOCK_READY_FILE: readyFile },
    cwd: workspace, stdio: ['ignore', log, log], detached: true, windowsHide: true
  });
  fs.closeSync(log);
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  let ready;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw new Error('Could not launch the local mock API');
    try { ready = JSON.parse(await fsp.readFile(readyFile, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill();
    throw new Error('The local mock API did not become ready');
  }
  const smoke = path.join(workspace, '.smoke');
  await fsp.mkdir(smoke, { recursive: true });
  const agents = [{ agentId: '6' }, { agentId: '7' }];
  const http = (name, target, executionRule = 'blocking') => ({
    name, type: 'http-server', executionRule,
    config: { url: `https://${target}/health`, agents, networkMeasurements: false },
    thresholds: { expectedResponseCodes: [200], maxResponseTime: 1000, maxTotalTime: 2000 }
  });
  const suites = {
    healthy: [http('healthy-http', 'healthy.invalid'), {
      name: 'healthy-network', type: 'agent-to-server',
      config: { server: 'healthy.invalid', port: 443, protocol: 'tcp', agents },
      thresholds: { maxLoss: 0, maxLatency: 100, maxJitter: 10 }
    }],
    blocking: [http('blocking-failure', 'failure.invalid')],
    'non-blocking': [http('optional-failure', 'failure.invalid', 'non-blocking')],
    incomplete: [http('missing-agent-measurements', 'incomplete.invalid')],
    'api-error': [http('native-api-error', 'api-error.invalid')]
  };
  for (const [name, tests] of Object.entries(suites)) {
    await fsp.writeFile(path.join(smoke, `${name}.json`), JSON.stringify({
      version: 1, accountGroupId: '123456', timeout: name === 'incomplete' ? '30s' : '90s', pollInterval: '100ms', tests
    }, null, 2));
  }
  if (process.env.GITHUB_OUTPUT) {
    await fsp.appendFile(process.env.GITHUB_OUTPUT, `api-base-url=${ready.baseURL}\nmock-pid=${ready.pid}\nsmoke-directory=${smoke}\n`);
  }
  console.log(JSON.stringify({ apiBaseURL: ready.baseURL, pid: ready.pid, smokeDirectory: smoke, mockDirectory: directory }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
