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

const MAX_DETAIL_TESTS = 20;
const MAX_AGENTS_PER_TEST = 20;
const MAX_AGENT_ROWS = 100;
const MAX_SUMMARY_BYTES = 512 * 1024;
const RESULT_HOSTS = new Set(['app.thousandeyes.com', 'app.thousandeyes.eu', 'app.thousandeyes.gov']);
const PROBLEM_STATUSES = new Set(['failed', 'timed-out', 'error']);
const AGENT_STATUSES = new Set(['passed', 'failed', 'skipped', 'timed-out', 'error', 'pending']);
const STATUS_SYMBOLS = { passed: '🟢', failed: '🔴', skipped: '⚪', 'timed-out': '🟠', error: '🔴', pending: '🟡' };
const AGENT_HEADERS = ['Test ID', 'Test', 'Target', 'Agent', 'Round', 'Status', 'Measurements', 'Details', 'Results'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textFormatter(token) {
  return (value, limit = 240, fallback = 'Not reported') => {
    let text = typeof value === 'string' && value ? value : fallback;
    // Blank lines end raw HTML blocks and let Markdown become active. Normalize
    // before redaction so removing controls cannot reconstruct the token.
    text = text.replace(/[\p{Cc}\u2028\u2029]/gu, '');
    if (token) text = text.split(token).join('[REDACTED]');
    const characters = [];
    for (const character of text) {
      if (characters.length === limit) {
        characters.push('...');
        break;
      }
      characters.push(character);
    }
    return characters.join('').replace(/[&<>"']/g, character => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
    ));
  };
}

function identifier(value, format) {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  return format(/^\d{1,32}$/.test(text) ? text : '');
}

function statusCell(value, format) {
  const status = AGENT_STATUSES.has(value) ? value : '';
  return `${STATUS_SYMBOLS[status] || '⚪'} ${format(status, 40)}`;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function number(value) {
  const rounded = value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return rounded === '0' && value > 0 ? value.toPrecision(3) : rounded;
}

function table(headers, rows) {
  return `<table><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead><tbody>` +
    rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') + '</tbody></table>\n';
}

function resultURL(value, token) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  // Check the raw authority/path too: URL normalizes explicit :443, encoded
  // segments, and dot segments that the CLI's link policy rejects.
  const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#]|$)/i.exec(value);
  if (!raw || !RESULT_HOSTS.has(raw[1].toLowerCase()) || raw[2] !== '/view/tests') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
        !RESULT_HOSTS.has(parsed.hostname) || parsed.pathname !== '/view/tests') return null;
    const approved = new URL(`https://${parsed.hostname}/view/tests`);
    for (const key of ['__a', 'testId', 'roundId', 'agentId']) {
      const parameter = parsed.searchParams.get(key);
      if (parameter && /^\d{1,32}$/.test(parameter)) approved.searchParams.set(key, parameter);
    }
    const href = approved.href;
    return token && href.includes(token) ? null : href;
  } catch {
    return null;
  }
}

function targetText(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const target = new URL(value);
      if (!target.hostname) return '';
      target.username = '';
      target.password = '';
      target.search = '';
      target.hash = '';
      return target.href;
    } catch {
      return '';
    }
  }
  // Network targets are display text, never links. Reject URL/userinfo syntax.
  return /^(?:[a-z\d](?:[a-z\d._-]*[a-z\d])?\.?|\[[a-f\d:.]+\]|[a-f\d:]+)(?::\d{1,5})?$/i.test(value) ? value : '';
}

function prioritized(items, limit) {
  const selected = [];
  if (limit === 0) return selected;
  for (const problem of [true, false]) {
    for (const item of items) {
      if (PROBLEM_STATUSES.has(item?.status) !== problem) continue;
      selected.push(item);
      if (selected.length === limit) return selected;
    }
  }
  return selected;
}

function agentDetails(tests) {
  const details = tests.map(test => {
    const agents = Array.isArray(test.agents) ? test.agents : [];
    return { test, agents, candidates: prioritized(agents, MAX_AGENTS_PER_TEST), selected: [] };
  });
  let remainingRows = MAX_AGENT_ROWS;
  // Reserve rows for problems across every selected test before showing passes.
  for (const problem of [true, false]) {
    for (const detail of details) {
      const selected = detail.candidates.filter(agent => PROBLEM_STATUSES.has(agent?.status) === problem)
        .slice(0, remainingRows);
      detail.selected.push(...selected);
      remainingRows -= selected.length;
    }
  }
  return { details, remainingRows };
}

function measurements(type, agent, format) {
  const metrics = record(agent.metrics) ? agent.metrics : {};
  const fields = type === 'http-server'
    ? [['responseCode', 'HTTP status', ''], ['responseTime', 'Response time', ' ms'], ['totalTime', 'Total time', ' ms']]
    : [['loss', 'Packet loss', '%'], ['avgLatency', 'Average RTT', ' ms'], ['jitter', 'Jitter', ' ms']];
  const lines = [];
  for (const [key, label, unit] of fields) {
    const value = metrics[key];
    const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
      (key !== 'responseCode' || (Number.isInteger(value) && value >= 100 && value <= 599)) &&
      (key !== 'loss' || value <= 100);
    lines.push(`${label}: ${valid ? `${format(number(value), 40)}${unit}` : 'Not reported'}`);
  }
  return lines.join('<br>');
}

function agentSection({ context, agents, rows }) {
  let section = context;
  if (rows.length) section += table(AGENT_HEADERS, rows.map(row => row.cells));
  else if (agents.length === 0) section += '<p>Agent results: Not reported.</p>\n';
  if (rows.length < agents.length) {
    section += `<p>Showing ${rows.length} of ${agents.length} agents. See the full JSON/JUnit reports for all results.</p>\n`;
  }
  return section;
}

function boundedSummary(overview, prefix, plans, suffix) {
  const summary = overview + prefix + plans.map(agentSection).join('') + suffix;
  if (Buffer.byteLength(summary, 'utf8') <= MAX_SUMMARY_BYTES) return summary;

  const notice = '<p>Some agent rows were omitted to stay within the summary size limit, prioritizing failures. See the full JSON/JUnit reports for all results.</p>\n';
  const admitted = plans.map(plan => ({ ...plan, rows: [] }));
  const sections = admitted.map(agentSection);
  let bytes = Buffer.byteLength(overview + prefix + sections.join('') + suffix + notice, 'utf8');
  if (bytes > MAX_SUMMARY_BYTES) {
    return overview + '<p>Agent details were omitted to stay within the summary size limit. See the full JSON/JUnit reports.</p>\n';
  }
  // Reserve every test's context and omission notices, then spend the remaining
  // UTF-8 bytes on problems across all tests before admitting passing rows.
  for (const problem of [true, false]) {
    for (let index = 0; index < plans.length; index++) {
      for (const row of plans[index].rows) {
        if (PROBLEM_STATUSES.has(row.status) !== problem) continue;
        admitted[index].rows.push(row);
        const section = agentSection(admitted[index]);
        const delta = Buffer.byteLength(section, 'utf8') - Buffer.byteLength(sections[index], 'utf8');
        if (bytes + delta <= MAX_SUMMARY_BYTES) {
          sections[index] = section;
          bytes += delta;
        } else {
          admitted[index].rows.pop();
        }
      }
    }
  }
  return overview + prefix + sections.join('') + suffix + notice;
}

function buildSummary(report, exitCode, counts, token) {
  const format = textFormatter(token);
  const started = timestamp(report.startedAt);
  const finished = timestamp(report.finishedAt);
  const duration = started !== null && finished !== null && finished >= started
    ? `${format(number((finished - started) / 1000), 40)} s` : 'Not reported';
  const overview = '<h2>ThousandEyes synthetic tests</h2>\n' +
    `<p>CLI exit code: ${format(String(exitCode), 10)}<br>Run: <code>${format(report.runId, 40)}</code></p>\n` +
    `<p>Duration: ${duration}<br>` +
    `Started: ${started === null ? 'Not reported' : format(new Date(started).toISOString(), 40)}<br>` +
    `Finished: ${finished === null ? 'Not reported' : format(new Date(finished).toISOString(), 40)}</p>\n` +
    `<p>Passed: ${counts.passed}; failed: ${counts.failed}; non-blocking failures: ${counts['non-blocking-failed']}; ` +
    `skipped: ${counts.skipped}; timed out: ${counts['timed-out']}; errors: ${counts.errors}.</p>\n` +
    table(['Test ID', 'Test', 'Type', 'Execution rule', 'Status'], report.tests.map(test => [
      `<code>${identifier(test.testId, format)}</code>`, format(test.name, 160), format(test.type, 40),
      format(test.executionRule, 40), statusCell(test.status, format)
    ]));

  const tests = prioritized(report.tests, MAX_DETAIL_TESTS);
  const { details: agentPlans, remainingRows } = agentDetails(tests);
  let prefix = '<h2>Agent measurements</h2>\n';
  if (tests.length < report.tests.length) {
    prefix += `<p>Showing ${tests.length} of ${report.tests.length} tests with agent details, prioritizing failures. See the full JSON/JUnit reports for all results.</p>\n`;
  }
  const plans = agentPlans.map(({ test, agents, selected }) => {
    let context = `<h3>${format(test.name, 160)}</h3>\n` +
      `<p>Test ID: <code>${identifier(test.testId, format)}</code>; type: ${format(test.type, 40)}; rule: ${format(test.executionRule, 40)}.<br>` +
      `Target: <code>${format(targetText(test.target), 2048)}</code></p>\n`;
    if (typeof test.message === 'string' && test.message) context += `<p>${format(test.message)}</p>\n`;
    const rows = selected.map(value => {
      const agent = record(value) ? value : {};
      const href = resultURL(agent.url, token);
      return {
        status: agent.status,
        cells: [
          `<code>${identifier(test.testId, format)}</code>`, format(test.name, 160),
          `<code>${format(targetText(test.target), 2048)}</code>`,
          `${format(agent.agentName, 160)}<br>ID: ${identifier(agent.agentId, format)}`, identifier(agent.roundId, format),
          statusCell(agent.status, format), measurements(test.type, agent, format),
          format(agent.message, 240, 'No additional details'),
          href ? `<a href="${format(href, 512)}">View in ThousandEyes</a>` : 'Not provided'
        ]
      };
    });
    return { context, agents, rows };
  });
  const suffix = remainingRows === 0 ? `<p>The summary is limited to ${MAX_AGENT_ROWS} agent rows overall.</p>\n` : '';
  return boundedSummary(overview, prefix, plans, suffix);
}

async function writeSummary(core, report, exitCode, counts, token = '') {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await core.summary.addRaw(buildSummary(report, exitCode, counts, token)).write();
}

module.exports = { writeSummary };
