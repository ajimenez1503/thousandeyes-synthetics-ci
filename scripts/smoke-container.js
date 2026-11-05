'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-container-smoke-'));
  const image = `te-synthetics:smoke-${process.pid}`;
  const container = `te-synthetics-smoke-${process.pid}`;
  const docker = args => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  let mock;
  try {
    const suite = JSON.parse(await fs.readFile(path.join(root, 'examples/synthetics/thousandeyes-ci.json'), 'utf8'));
    for (const test of suite.tests) test.executionRule = 'skipped';
    await fs.chmod(directory, 0o755);
    await fs.writeFile(path.join(directory, 'suite.json'), JSON.stringify(suite), { mode: 0o644 });
    execFileSync('docker', ['build', '--tag', image, '.'], { cwd: root, stdio: 'inherit', timeout: 300000 });
    const restrictions = network => ['--rm', '--name', container, '--network', network, '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
    const report = JSON.parse(docker(['run', ...restrictions('none'), '--env', 'TE_TOKEN=container-smoke-fake-token', '--volume', `${directory}:/config:ro`, image, 'run-tests', '--config', '/config/suite.json', '--timeout', '5s', '--json']));
    assert.equal(report.version, 1);
    assert.match(report.runId, /^[a-f0-9]{24}$/);
    assert.deepEqual(report.tests.map(test => [test.name, test.type, test.target, test.status, test.executionRule, test.agents]), [
      ['canary-http', 'http-server', 'https://canary.example.com/health', 'skipped', 'skipped', []],
      ['canary-network', 'agent-to-server', 'canary.example.com:443', 'skipped', 'skipped', []]
    ]);
    assert.ok(!JSON.stringify(report).includes('container-smoke-fake-token'));
    docker(['run', ...restrictions('none'), '--entrypoint', '/usr/local/bin/thousandeyes', image, '--help']);
    console.log('Container smoke passed: portable runner report and bundled API CLI start without networking or filesystem writes.');
    if (process.argv.includes('--api')) {
      if (process.platform !== 'linux') throw new Error('The host-network container API smoke requires Linux.');
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('INPUT_') && !['TE_TOKEN', 'TE_BASE_URL', 'TE_API_CLI_PATH'].includes(name)));
      const start = spawnSync(process.execPath, ['test/start-mock.js'], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...env, GITHUB_WORKSPACE: root, RUNNER_TEMP: directory, GITHUB_OUTPUT: '' }
      });
      if (start.status !== 0) throw new Error('The owned container mock API did not start.');
      mock = JSON.parse(start.stdout.trim());
      for (const [name, exit, statuses] of [
        ['healthy', 0, ['passed', 'passed']], ['blocking', 1, ['failed']],
        ['non-blocking', 0, ['failed']], ['api-error', 1, ['error']]
      ]) {
        let stdout;
        let actual = 0;
        try {
          stdout = docker(['run', ...restrictions('host'), '--env', 'TE_TOKEN=action-ci-fake-token',
            '--env', `TE_BASE_URL=${mock.apiBaseURL}`, '--volume', `${path.join(root, '.smoke')}:/config:ro`,
            image, 'run-tests', '--config', `/config/${name}.json`, '--json']);
        } catch (error) {
          actual = error.status;
          stdout = error.stdout;
        }
        assert.equal(actual, exit, `${name} container process exit`);
        const measured = JSON.parse(stdout);
        assert.equal(measured.version, 1);
        assert.deepEqual(measured.tests.map(test => test.status), statuses, name);
        assert.ok(measured.tests.every(test => test.agents.length === 2));
        assert.ok(!JSON.stringify(measured).includes('private-api-error-body'));
        assert.ok(!JSON.stringify(measured).includes('action-ci-fake-token'));
        if (name === 'healthy') {
          assert.equal(measured.tests[0].agents[0].metrics.responseCode, 200);
          assert.equal(measured.tests[1].agents[0].metrics.loss, 0);
        }
        if (name === 'blocking') assert.equal(measured.tests[0].agents[0].metrics.responseCode, 503);
        if (name === 'non-blocking') assert.equal(measured.tests[0].executionRule, 'non-blocking');
        if (name === 'api-error') assert.match(measured.tests[0].message, /HTTP 401/);
      }
      console.log('Linux container API smoke passed: HTTP/network measurements, blocking/non-blocking gates, and redacted native HTTP errors.');
    }
  } finally {
    if (mock && Number.isInteger(mock.pid) && mock.pid > 0) {
      try { process.kill(mock.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await fs.rm(path.join(root, '.smoke'), { recursive: true, force: true });
    }
    for (const args of [['rm', '--force', container], ['image', 'rm', image]]) {
      try { docker(args); } catch {}
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(() => { console.error('The restrictive container smoke check failed.'); process.exitCode = 1; });
