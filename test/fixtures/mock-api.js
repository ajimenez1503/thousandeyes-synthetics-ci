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

const http = require('node:http');
const fs = require('node:fs');
const tests = new Map();
let nextId = 1000;
let baseURL;

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/hal+json' });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer action-ci-fake-token') {
    send(response, 401, { title: 'Fake CI token required' });
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.searchParams.get('aid') !== '123456') {
    send(response, 400, { title: 'Fake CI account group required' });
    return;
  }
  const creation = /^\/v7\/tests\/(http-server|agent-to-server)\/instant$/.exec(url.pathname);
  if (request.method === 'POST' && creation) {
    let text = '';
    try {
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 65536) throw new Error('Body limit');
      }
      const body = JSON.parse(text);
      const type = creation[1];
      if (type === 'agent-to-server' && (body.server !== 'healthy.invalid' || body.port !== 443)) {
        send(response, 400, { title: 'Network creation requires a hostname and separate port' });
        return;
      }
      if (!Array.isArray(body.agents) || body.agents.length === 0) throw new Error('Agents required');
      const target = body.url || body.server;
      if (typeof target !== 'string' || !target.includes('.invalid')) throw new Error('Only invalid fixture targets allowed');
      if (target.includes('api-error.invalid')) {
        send(response, 401, { detail: 'private-api-error-body action-ci-fake-token' });
        return;
      }
      const testId = String(++nextId);
      const layer = type === 'agent-to-server' ? 'network' : 'http-server';
      const record = { testId, type, layer, target, agents: body.agents };
      tests.set(testId, record);
      send(response, 201, {
        testId, type,
        agents: body.agents.map(({ agentId }) => ({ agentId, agentType: 'cloud', agentName: `Creation agent ${agentId}` })),
        _links: { testResults: [{ href: `${baseURL}/v7/test-results/${testId}/${layer}` }] }
      });
    } catch {
      send(response, 400, { title: 'Invalid fixture request' });
    }
    return;
  }
  const measurement = /^\/v7\/test-results\/(\d+)\/(http-server|network)$/.exec(url.pathname);
  if (request.method === 'GET' && measurement) {
    const record = tests.get(measurement[1]);
    if (!record || record.layer !== measurement[2]) {
      send(response, 404, { title: 'Unknown fixture test' });
      return;
    }
    // A partial HTTP row proves polling happened without satisfying the timing
    // thresholds or the second agent's completeness requirement.
    const results = record.target.includes('incomplete.invalid') ? [{
      agent: { agentId: '6', agentName: 'Result agent 6' }, roundId: 1700000000,
      responseCode: 200
    }] : record.agents.map(({ agentId }) => ({
      agent: { agentId, ...(agentId === '6' ? { agentName: 'Result agent 6' } : {}) }, roundId: 1700000000,
      ...(record.type === 'http-server'
        ? { responseCode: record.target.includes('failure.invalid') ? 503 : 200, responseTime: 10, totalTime: 20 }
        : { direction: 'to-target', loss: 0, avgLatency: 5, jitter: 1 })
    }));
    send(response, 200, { test: { testId: record.testId }, results, _links: {} });
    return;
  }
  send(response, 404, { title: 'Unknown fixture endpoint' });
});

server.listen(0, '127.0.0.1', () => {
  baseURL = `http://127.0.0.1:${server.address().port}`;
  const temporary = process.env.MOCK_READY_FILE + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ baseURL, pid: process.pid }));
  fs.renameSync(temporary, process.env.MOCK_READY_FILE);
  console.log(`Local mock API ready at ${baseURL}`);
});
server.on('error', () => { console.error('Local mock API could not start'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
