const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { installRunner } = require('./install');
const { XMLValidator, XMLParser } = require('fast-xml-parser');
const { writeSummary } = require('./summary');

const DEFAULT_API = 'https://api.thousandeyes.com';

class ActionError extends Error {}

function inputAlias(core, name, legacy) {
  const value = core.getInput(name);
  const previous = core.getInput(legacy);
  if (value && previous && value !== previous) {
    throw new ActionError(`${name} and its deprecated ${legacy} alias must not conflict.`);
  }
  return value || previous;
}

async function regularFile(filename, message) {
  try {
    const info = await fs.lstat(filename);
    if (info.isFile() && !info.isSymbolicLink()) return info;
  } catch {}
  throw new ActionError(message);
}

function apiBaseURL(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
        url.username || url.password || url.search || url.hash) throw new Error();
    return value;
  } catch {
    throw new ActionError('api-base-url must use HTTPS, or HTTP for a loopback test server, without credentials, query, or fragment.');
  }
}

function executeCLI(executable, args, options) {
  return new Promise((resolve, reject) => {
    // Reports are the integration contract. Raw child streams can contain
    // workflow-command text or configuration errors with sensitive values.
    const child = spawn(executable, args, { ...options, shell: false, stdio: 'ignore' });
    const forward = signal => { if (!child.killed) child.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    child.once('error', () => {
      cleanup();
      reject(new ActionError('Could not start the ThousandEyes CLI executable.'));
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
  });
}

async function readReport(filename) {
  const info = await regularFile(filename, 'The CLI did not produce a JSON report.');
  if (info.size > 8 * 1024 * 1024) throw new ActionError('The CLI JSON report exceeds the supported size.');
  let report;
  try { report = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { throw new ActionError('The CLI produced an invalid JSON report.'); }
  if (!report || report.version !== 1 || !/^[a-f0-9]{24}$/.test(report.runId) ||
      !Array.isArray(report.tests) || report.tests.length > 100) {
    throw new ActionError('The CLI produced an unsupported JSON report.');
  }
  const statuses = new Set(['passed', 'failed', 'skipped', 'timed-out', 'error']);
  const rules = new Set(['blocking', 'non-blocking', 'skipped']);
  for (const test of report.tests) {
    if (!test || typeof test.name !== 'string' || !statuses.has(test.status) ||
        !rules.has(test.executionRule) || !['http-server', 'agent-to-server'].includes(test.type)) {
      throw new ActionError('The CLI JSON report contains an unsupported test outcome.');
    }
  }
  return report;
}

async function validateJUnit(filename) {
  const info = await regularFile(filename, 'The CLI did not produce a JUnit report.');
  if (info.size === 0 || info.size > 8 * 1024 * 1024) throw new ActionError('The CLI produced an empty or oversized JUnit report.');
  try {
    const xml = await fs.readFile(filename, 'utf8');
    if (/<!DOCTYPE\b/.test(xml) || XMLValidator.validate(xml) !== true) throw new Error();
    const document = new XMLParser({ processEntities: false }).parse(xml);
    const roots = Object.keys(document).filter(key => !key.startsWith('?'));
    if (roots.length !== 1 || !['testsuite', 'testsuites'].includes(roots[0]) || Array.isArray(document[roots[0]])) throw new Error();
  } catch {
    throw new ActionError('The CLI produced an invalid JUnit XML report.');
  }
}

async function run(core) {
  const token = core.getInput('api-token');
  if (token) core.setSecret(token);
  if (!token) throw new ActionError('api-token is required; supply a GitHub secret.');
  const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const configPath = path.resolve(workspace, core.getInput('config-path') || 'thousandeyes-ci.json');
  await regularFile(configPath, 'config-path must reference an existing regular suite file.');
  const baseURL = apiBaseURL(core.getInput('api-base-url') || DEFAULT_API);
  const version = inputAlias(core, 'runner-version', 'cli-version');
  const overrides = ['account-group-id', 'timeout', 'poll-interval'].map(name => [name, core.getInput(name)]);
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'thousandeyes-synthetics-'));
  const jsonPath = path.join(root, 'results.json');
  const junitPath = path.join(root, 'results.xml');
  core.setOutput('json-report', jsonPath);
  core.setOutput('junit-report', junitPath);
  let executable = inputAlias(core, 'runner-path', 'cli-path');
  let apiCLIPath = core.getInput('api-cli-path');
  if (executable) {
    if (!path.isAbsolute(executable)) throw new ActionError('runner-path must be an absolute executable path.');
    await regularFile(executable, 'runner-path must reference an existing regular executable file.');
  } else {
    if (!version) throw new ActionError('This preview requires runner-path or an exact published runner-version; no runner release is selected by default.');
    try {
      const installed = await installRunner({ version, tempDirectory: root });
      executable = installed.runnerPath;
      apiCLIPath ||= installed.apiCLIPath;
    } catch { throw new ActionError('Could not install the pinned synthetic CI release; check runner-version and release availability.'); }
  }
  if (apiCLIPath) {
    if (!path.isAbsolute(apiCLIPath)) throw new ActionError('api-cli-path must be an absolute executable path.');
    await regularFile(apiCLIPath, 'api-cli-path must reference an existing regular executable file.');
  }
  const args = ['run-tests', '--config', configPath, '--json-report', jsonPath, '--junit-report', junitPath, '--json'];
  if (apiCLIPath) args.push('--api-cli-path', apiCLIPath);
  for (const [name, value] of overrides) if (value) args.push(`--${name}`, value);
  const exitCode = await executeCLI(executable, args, {
    cwd: workspace,
    env: { ...process.env, TE_TOKEN: token, TE_BASE_URL: baseURL }
  });
  core.setOutput('exit-code', exitCode);
  const report = await readReport(jsonPath);
  await validateJUnit(junitPath);
  core.setOutput('run-id', report.runId);
  const counts = { passed: 0, failed: 0, 'non-blocking-failed': 0, skipped: 0, 'timed-out': 0, errors: 0 };
  for (const test of report.tests) {
    counts[test.status === 'error' ? 'errors' : test.status]++;
    if (test.status === 'failed' && test.executionRule === 'non-blocking') counts['non-blocking-failed']++;
  }
  for (const [name, count] of Object.entries(counts)) core.setOutput(name, count);
  await writeSummary(core, report, exitCode, counts, token);
  if (exitCode !== 0) {
    core.setFailed('ThousandEyes synthetic checks failed; inspect the JSON and JUnit reports.');
    process.exitCode = exitCode;
  }
}

module.exports = { run, ActionError };
