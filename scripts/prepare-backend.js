'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'build/backend-source');
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}).trim();

async function prepareBackend() {
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'backend.json'), 'utf8'));
  const override = process.env.TE_API_CLI_SOURCE;
  if (metadata.repository !== 'thousandeyes/thousandeyes-cli') {
    throw new Error('The API backend must use the official ThousandEyes CLI repository.');
  }
  if (!override && !/^[a-f0-9]{40}$/.test(metadata.sourceCommit || '')) {
    throw new Error('backend.json requires the exact official CLI source commit before a remote build; use TE_API_CLI_SOURCE only for local development.');
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  let commit;
  if (override) {
    const source = path.resolve(override);
    commit = git(['rev-parse', 'HEAD'], source);
    // Copy only source-control-visible files, including candidate additions.
    // Ignored credentials, caches, and .git never enter the Docker context.
    const names = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], source).split('\0').filter(Boolean);
    for (const name of new Set(names)) {
      if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('Invalid API backend source path.');
      const from = path.join(source, name);
      const info = await fs.lstat(from);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('API backend source must contain regular files.');
      const to = path.join(destination, name);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  } else {
    git(['init', '--quiet'], destination);
    git(['fetch', '--quiet', '--depth=1', `https://github.com/${metadata.repository}.git`, metadata.sourceCommit], destination);
    git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], destination);
    commit = git(['rev-parse', 'HEAD'], destination);
    if (commit !== metadata.sourceCommit) throw new Error('API backend source commit did not match its pin.');
    await fs.rm(path.join(destination, '.git'), { recursive: true, force: true });
  }
  await fs.writeFile(path.join(root, 'build/backend-source.json'), JSON.stringify({ ...metadata, preparedCommit: commit, localSourceOverride: Boolean(override) }, null, 2) + '\n');
  return destination;
}

if (require.main === module) prepareBackend().catch(() => {
  console.error('Could not prepare the pinned API backend source. Verify backend.json or the explicit TE_API_CLI_SOURCE development override.');
  process.exitCode = 1;
});

module.exports = { prepareBackend };
