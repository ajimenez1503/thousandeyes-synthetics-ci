'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');

async function main() {
  const cases = [
    ['HEALTHY', 'success', ['passed', 'passed']],
    ['BLOCKING', 'failure', ['failed']],
    ['NON_BLOCKING', 'success', ['failed']],
    ['INCOMPLETE', 'failure', ['timed-out']],
    ['API_ERROR', 'failure', ['error']]
  ];
  const paths = [];
  const runs = [];
  for (const [name, outcome, statuses] of cases) {
    assert.equal(process.env[`${name}_OUTCOME`], outcome, `${name} step outcome`);
    const reportPath = process.env[`${name}_REPORT`];
    assert.ok(reportPath, `${name} report path output`);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.version, 1);
    assert.match(report.runId, /^[a-f0-9]{24}$/);
    assert.deepEqual(report.tests.map((test) => test.status), statuses, `${name} test statuses`);
    assert.ok(report.tests.every((test) => test.agents.length === 2), `${name} covers both assigned agents`);
    const expectedCases = new Map();
    for (const test of report.tests) {
      const target = test.type === 'agent-to-server' ? 'healthy.invalid:443' :
        `https://${name === 'API_ERROR' ? 'api-error' : name === 'INCOMPLETE' ? 'incomplete' : name === 'HEALTHY' ? 'healthy' : 'failure'}.invalid/health`;
      assert.equal(test.target, target, `${name} ${test.name} target`);
      assert.deepEqual(test.agents.map((agent) => agent.agentId), ['6', '7'], `${name} retains assigned agent IDs`);
      for (const agent of test.agents) {
        const agentName = name === 'API_ERROR' ? undefined : agent.agentId === '6' ? 'Result agent 6' : `Creation agent ${agent.agentId}`;
        assert.equal(agent.agentName, agentName, `${name} ${test.name} agent ${agent.agentId} name`);
        expectedCases.set(`${test.testId || ''}/${agent.agentId}`, { test, agent });
      }
    }
    if (name === 'NON_BLOCKING') assert.equal(report.tests[0].executionRule, 'non-blocking');
    if (name === 'INCOMPLETE') {
      const first = report.tests[0].agents.find(agent => agent.agentId === '6');
      assert.equal(first.agentName, 'Result agent 6', 'the incomplete suite polled actual result metadata before timing out');
      assert.equal(first.roundId, '1700000000');
      assert.equal(first.metrics.responseCode, 200);
      assert.equal(first.metrics.responseTime, undefined, 'missing timing remains unavailable');
      assert.equal(first.metrics.totalTime, undefined, 'missing total time remains unavailable');
      assert.ok(report.tests[0].agents.every(agent => agent.status === 'timed-out'));
    }
    if (name === 'API_ERROR') {
      assert.match(report.tests[0].message, /HTTP 401/);
      assert.ok(!JSON.stringify(report).includes('private-api-error-body'));
      assert.ok(!JSON.stringify(report).includes('action-ci-fake-token'));
    }
    const junitPath = process.env[`${name}_JUNIT`] || path.join(path.dirname(reportPath), 'results.xml');
    const xml = await fs.readFile(junitPath, 'utf8');
    assert.ok(xml.includes('<testsuite') && xml.includes('</testsuite>'), `${name} JUnit report`);
    if (name === 'HEALTHY') assert.ok(!/<(?:failure|error)\b/.test(xml));
    if (name === 'BLOCKING' || name === 'NON_BLOCKING') assert.ok(xml.includes('<failure'), `${name} assertion appears in JUnit`);
    if (name === 'INCOMPLETE' || name === 'API_ERROR') assert.ok(xml.includes('<error'), `${name} appears as JUnit error`);
    const document = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '',
      isArray: (tag) => tag === 'testcase' || tag === 'property'
    }).parse(xml);
    assert.equal(document.testsuite.testcase.length, expectedCases.size, `${name} JUnit agent cases`);
    for (const testCase of document.testsuite.testcase) {
      const properties = new Map(testCase.properties.property.map((property) => [property.name, property.value]));
      const expected = expectedCases.get(`${properties.get('testId')}/${properties.get('agentId')}`);
      assert.ok(expected, `${name} JUnit case retains test and agent identities`);
      assert.equal(properties.get('target'), expected.test.target, `${name} JUnit target`);
      assert.equal(properties.get('agentName'), expected.agent.agentName, `${name} JUnit agent name`);
      assert.equal(properties.get('executionRule'), expected.test.executionRule, `${name} JUnit execution rule`);
    }
    paths.push(reportPath);
    runs.push(report.runId);
  }
  assert.equal(new Set(paths).size, cases.length, 'Each invocation uses a distinct report path');
  assert.equal(new Set(runs).size, cases.length, 'Each invocation creates a distinct CLI run');
  console.log('Native API CLI mock smoke passed: outcomes, targets, agent names, JUnit metadata, and redacted HTTP errors.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
