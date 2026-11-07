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
const path = require('node:path');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const capture = {
  args,
  script: path.basename(process.argv[1]),
  token: process.env.TE_TOKEN,
  apiBaseURL: process.env.TE_BASE_URL,
  cwd: process.cwd()
};
fs.writeFileSync(process.env.FIXTURE_CAPTURE_PATH, JSON.stringify(capture));

const agent = (status) => ({ agentId: '6', status });
const check = (name, status, executionRule = 'blocking') => ({
  name, type: 'http-server', executionRule, status, agents: [agent(status)]
});
let tests = [check('http-check', 'passed'), {
  ...check('network-check', 'passed'), type: 'agent-to-server'
}];
if (process.env.FIXTURE_CASE === 'non-blocking') {
  tests = [check('healthy', 'passed'), check('optional', 'failed', 'non-blocking')];
}
if (process.env.FIXTURE_CASE === 'all-statuses') {
  tests = [check('healthy', 'passed'), check('blocking failure', 'failed'),
    check('optional failure', 'failed', 'non-blocking'), check('ignored', 'skipped'),
    check('late', 'timed-out'), check('broken', 'error')];
}
if (process.env.FIXTURE_CASE === 'status-colors') {
  tests = ['passed', 'failed', 'skipped', 'timed-out', 'error'].map((status, index) => ({
    ...check(`status-${status}`, status), testId: String(4001 + index), target: 'https://demo.example.com/health',
    agents: [agent(status), ...(status === 'timed-out' ? [
      { agentId: '7', status: 'pending' }, { agentId: '8', status: 'unknown' }
    ] : [])]
  }));
}
if (process.env.FIXTURE_CASE === 'unsafe-name') {
  tests = [check('<script>alert("x")</script> | ::error:: forged', 'passed')];
}
if (process.env.FIXTURE_CASE === 'details') {
  tests = [{
    ...check('detailed-http', 'passed'), testId: '1001', target: 'https://demo.example.com/health',
    agents: [{
      agentId: '6', agentName: 'London Cloud', roundId: '1700000000', status: 'passed',
      metrics: { responseCode: 401, responseTime: 156, totalTime: 160 },
      url: 'https://app.thousandeyes.com/view/tests?__a=123456&testId=1001&roundId=1700000000&agentId=6&token=drop-query#drop-fragment'
    }, {
      agentId: '7', agentName: 'Frankfurt & Cloud', roundId: '1700000000', status: 'passed',
      metrics: { responseCode: 401, responseTime: 0, totalTime: 0 },
      url: 'https://app.thousandeyes.eu/view/tests?testId=1001&agentId=7'
    }]
  }, {
    ...check('detailed-network', 'passed'), type: 'agent-to-server', testId: '1002', target: 'demo.example.com:443',
    agents: [{
      agentId: '6', agentName: 'London Cloud', roundId: '1700000000', status: 'passed',
      metrics: { loss: 0, avgLatency: 14.073301, jitter: 0.09514871 },
      url: 'https://app.thousandeyes.gov/view/tests?testId=1002&agentId=6'
    }]
  }];
}
if (process.env.FIXTURE_CASE === 'multi-agent') {
  tests = [check('healthy-agents', 'passed'), check('blocking-agents', 'failed'),
    check('optional-agents', 'failed', 'non-blocking')].map((test) => ({
    ...test, agents: ['6', '7', '8'].map((agentId) => ({ agentId, status: test.status }))
  }));
}
if (process.env.FIXTURE_CASE === 'multi-agent-non-blocking') {
  tests = [check('healthy-agents', 'passed'), check('optional-agents', 'failed', 'non-blocking')].map((test) => ({
    ...test, agents: ['6', '7', '8'].map((agentId) => ({ agentId, status: test.status }))
  }));
}
if (process.env.FIXTURE_CASE === 'partial-agents') {
  tests = [{
    ...check('partial-agent-timeout', 'timed-out'), testId: '1003',
    message: 'execution deadline exceeded before all required measurements arrived',
    agents: [{
      agentId: '6', roundId: '1700000000', status: 'passed',
      metrics: { responseCode: 200, responseTime: 15, totalTime: 20 }
    }, {
      agentId: '7', status: 'timed-out', message: 'waiting for assigned agent measurements'
    }]
  }];
}
if (process.env.FIXTURE_CASE === 'unsafe-details') {
  tests = [{
    ...check('<img src=x onerror="alert(1)"> ' + process.env.TE_TOKEN, 'failed'), testId: '1004',
    target: 'https://target-user:target-password@demo.example.com/path/' + process.env.TE_TOKEN + '?api_key=target-query-secret#target-fragment-secret',
    message: '<script>test-message</script> ' + process.env.TE_TOKEN,
    agents: [{
      agentId: '6', agentName: '<em>named-agent</em> ' + process.env.TE_TOKEN, roundId: '1700000000', status: 'failed',
      message: '<script>agent-message</script> ' + process.env.TE_TOKEN,
      metrics: { responseCode: 503, responseTime: 20, unknown: 'DO_NOT_RENDER_UNKNOWN_METRIC' },
      url: 'https://external.invalid/private-link-marker?token=' + process.env.TE_TOKEN
    }]
  }];
}
if (process.env.FIXTURE_CASE === 'unsafe-links') {
  const urls = [
    'http://app.thousandeyes.com/view/tests?testId=1001',
    'https://app.thousandeyes.com:443/view/tests?testId=1001',
    'https://user:secret@app.thousandeyes.com/view/tests?testId=1001',
    'https://app.thousandeyes.com.evil.invalid/view/tests?testId=1001',
    'https://external.invalid/view/tests?testId=1001',
    'https://app.thousandeyes.com/%76iew/tests?testId=1001',
    'https://app.thousandeyes.com/other/../view/tests?testId=1001',
    '//app.thousandeyes.com/view/tests?testId=1001',
    'javascript:alert("unsafe-link-marker")'
  ];
  tests = [{
    ...check('unsafe-result-links', 'passed'),
    agents: urls.map((url, index) => ({ agentId: String(index + 1), status: 'passed', url }))
  }];
}
if (process.env.FIXTURE_CASE === 'malformed-details') {
  tests = [{
    ...check('malformed-agent-details', 'passed'), testId: { hidden: process.env.TE_TOKEN }, target: { hidden: process.env.TE_TOKEN }, message: { hidden: process.env.TE_TOKEN },
    agents: [{
      agentId: '6', agentName: { hidden: process.env.TE_TOKEN }, status: 'passed',
      metrics: { responseCode: '401', responseTime: null, totalTime: 'NaN', unknown: 'DO_NOT_RENDER_UNKNOWN_METRIC' },
      message: { hidden: process.env.TE_TOKEN }, url: { hidden: process.env.TE_TOKEN }
    }, null, {
      agentId: { hidden: process.env.TE_TOKEN }, agentName: ['DO_NOT_STRINGIFY_AGENT_NAME'], roundId: [], status: {}, metrics: 'not-a-metric-map'
    }]
  }, { ...check('malformed-agent-list', 'passed'), target: ['DO_NOT_STRINGIFY_TARGET'], agents: { hidden: process.env.TE_TOKEN } }, {
    ...check('partial-network-metrics', 'passed'), type: 'agent-to-server',
    agents: [{ agentId: '6', status: 'passed', metrics: { loss: 0, avgLatency: 'NaN' } }]
  }];
}
if (process.env.FIXTURE_CASE === 'bounded-details') {
  tests = Array.from({ length: 25 }, (_, index) => ({
    ...check(`bounded-check-${index} ` + 'n'.repeat(1000) + '_NAME_END', 'passed'),
    testId: String(2000 + index), target: 'https://demo.example.com/' + 't'.repeat(3000) + '_TARGET_END',
    agents: Array.from({ length: 25 }, (_, agentIndex) => ({
      agentId: String(agentIndex + 1), agentName: 'Bounded agent ' + 'a'.repeat(500) + '_AGENT_NAME_END', roundId: '1700000000', status: 'passed',
      message: `Agent-row-${index}-${agentIndex} ` + '<&'.repeat(500) + '_MESSAGE_END',
      metrics: { responseCode: 200, responseTime: 10, totalTime: 20 }
    }))
  }));
}
if (process.env.FIXTURE_CASE === 'failure-priority') {
  tests = Array.from({ length: 25 }, (_, index) => check(`priority-passed-${index}`, 'passed'));
  tests.push({
    ...check('late-blocking-problem', 'failed'), testId: '3001',
    message: 'A blocking test appeared after the passed tests',
    agents: [...Array.from({ length: 25 }, (_, index) => ({
      agentId: String(index + 1), status: 'passed', message: `priority-passed-agent-${index}`
    })), {
      agentId: '99', status: 'failed', message: 'Critical-agent-measurement-failure',
      metrics: { responseCode: 503 }
    }]
  });
}
if (['byte-budget-details', 'byte-budget-global-failures'].includes(process.env.FIXTURE_CASE)) {
  const eachFailed = process.env.FIXTURE_CASE === 'byte-budget-global-failures';
  tests = Array.from({ length: 5 }, (_, index) => ({
    ...check(`byte-budget-check-${index}`, eachFailed || index === 4 ? 'failed' : 'passed'),
    testId: String(5001 + index), target: 'https://demo.example.com/' + '&'.repeat(1900) + `/test-${index}`,
    agents: Array.from({ length: 20 }, (_, row) => {
      const failed = (eachFailed || index === 4) && row === 19;
      return {
        agentId: String(row + 1), agentName: `Byte-agent-${index}-${row}`, roundId: '1700000000',
        status: failed ? 'failed' : 'passed',
        message: failed ? `Byte-budget-failure${eachFailed ? `-${index}` : ''}: HTTP 503; expected 200` : `Budget-pass-${index}-${row}`,
        metrics: { responseCode: failed ? 503 : 200, responseTime: 10, totalTime: 20 }
      };
    })
  }));
}
if (['global-failure-priority', 'global-failure-overflow'].includes(process.env.FIXTURE_CASE)) {
  const allFailed = process.env.FIXTURE_CASE === 'global-failure-overflow';
  tests = Array.from({ length: 6 }, (_, index) => ({
    ...check(`global-failed-check-${index}`, 'failed'),
    agents: Array.from({ length: 20 }, (_, row) => ({
      agentId: String(row + 1), status: row === 0 || allFailed ? 'failed' : 'passed',
      message: row === 0 ? `Global-failure-${index}` : `Global-agent-${index}-${row}`,
      metrics: { responseCode: row === 0 || allFailed ? 503 : 200 }
    }))
  }));
}
if (process.env.FIXTURE_CASE === 'markdown-details') {
  const token = process.env.TE_TOKEN;
  tests = [{
    ...check('markdown-detail-check', 'failed'),
    agents: [{
      agentId: '6', status: 'failed',
      agentName: 'Agent ' + token.slice(0, 17) + '\x00\n' + token.slice(17),
      message: '\n\n[Unexpected link](https://external.invalid/path)\n\n![Remote image](https://external.invalid/image.png)\n\n',
      metrics: { responseCode: 503 },
      url: 'https://app.thousandeyes.com/view/tests?__a=123&testId=1005&agentId=6'
    }]
  }];
}
if (process.env.FIXTURE_CASE === 'tiny-measurements') {
  tests = [{
    ...check('tiny-http', 'passed'),
    agents: [{
      agentId: '6', status: 'passed',
      metrics: { responseCode: 200, responseTime: 0.0001234, totalTime: 0.0045 }
    }]
  }, {
    ...check('tiny-network', 'passed'), type: 'agent-to-server',
    agents: [{
      agentId: '6', status: 'passed',
      metrics: { loss: 0.0001234, avgLatency: 0.0000001234, jitter: 0.0000000001234 }
    }]
  }];
}
const report = {
  version: 1,
  runId: '0123456789abcdef01234567',
  startedAt: '2026-10-29T10:00:00Z',
  finishedAt: '2026-10-29T10:00:01Z',
  tests
};
if (process.env.FIXTURE_CASE === 'malformed-details') {
  report.startedAt = { invalid: true };
  report.finishedAt = 'not-a-time';
}
if (process.env.FIXTURE_BAD_REPORT === 'version') report.version = 2;
if (process.env.FIXTURE_BAD_REPORT === 'status') report.tests[0].status = 'unknown';
const jsonPath = value('--json-report');
const junitPath = value('--junit-report');
if (!process.env.FIXTURE_NO_REPORT) {
  fs.writeFileSync(jsonPath, process.env.FIXTURE_MALFORMED_REPORT ? '{broken' : JSON.stringify(report));
}
if (!process.env.FIXTURE_MISSING_JUNIT) {
  const invalidXML = {
    empty: '',
    malformed: '<testsuite><broken>',
    root: '<not-junit/>',
    'duplicate-suite': '<testsuite/><testsuite/>',
    'duplicate-suites': '<testsuites/><testsuites/>'
  };
  const xml = Object.hasOwn(invalidXML, process.env.FIXTURE_BAD_JUNIT)
    ? invalidXML[process.env.FIXTURE_BAD_JUNIT]
    : '<testsuite name="fixture" tests="1"><testcase name="fixture"/></testsuite>';
  fs.writeFileSync(junitPath, xml);
}
// Raw child streams must never become workflow commands or leak credentials.
console.log('::error::RAW_CHILD_STDOUT ' + process.env.TE_TOKEN);
console.error('RAW_CHILD_STDERR ' + process.env.TE_TOKEN);
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || '0');
