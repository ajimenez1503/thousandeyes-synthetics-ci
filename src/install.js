'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPOSITORY = 'ajimenez1503/thousandeyes-synthetics-ci';
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PLATFORMS = { linux: 'Linux', darwin: 'Darwin', win32: 'Windows' };
const ARCHITECTURES = { x64: 'x86_64', arm64: 'arm64' };

class InstallError extends Error {}

function releaseAsset(version, platform = process.platform, arch = process.arch) {
  const match = typeof version === 'string' && version.length <= 128 && version.match(VERSION_PATTERN);
  if (!match || (match[4] && match[4].split('.').some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === '0'))) {
    throw new InstallError('Invalid CLI version; use an exact X.Y.Z release or prerelease');
  }
  if (!Object.hasOwn(PLATFORMS, platform) || !Object.hasOwn(ARCHITECTURES, arch)) {
    throw new InstallError('Unsupported runner platform or architecture for the CLI release');
  }
  const format = platform === 'win32' ? 'zip' : 'tar.gz';
  return {
    archiveName: `te-synthetics_${version}_${PLATFORMS[platform]}_${ARCHITECTURES[arch]}.${format}`,
    checksumsName: `te-synthetics_${version}_checksums.txt`,
    binaryName: platform === 'win32' ? 'te-synthetics.exe' : 'te-synthetics',
    backendName: platform === 'win32' ? 'thousandeyes.exe' : 'thousandeyes',
    format,
  };
}

function checksumForAsset(manifest, filename) {
  if (typeof manifest !== 'string' || Buffer.byteLength(manifest, 'utf8') > 65536) {
    throw new InstallError('CLI release checksum manifest is invalid');
  }
  const entries = new Map();
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-fA-F0-9]{64})[ \t]+\*?([^\s]+)$/);
    if (!match || entries.has(match[2])) {
      throw new InstallError('CLI release checksum manifest is invalid');
    }
    entries.set(match[2], match[1].toLowerCase());
  }
  if (!entries.has(filename)) {
    throw new InstallError('CLI release checksum manifest does not identify the exact archive');
  }
  return entries.get(filename);
}

async function downloadAsset(url, destination) {
  const toolCache = await import('@actions/tool-cache');
  return toolCache.downloadTool(url, destination);
}

async function extractAsset(archive, destination, format) {
  const toolCache = await import('@actions/tool-cache');
  return format === 'zip'
    ? toolCache.extractZip(archive, destination)
    : toolCache.extractTar(archive, destination);
}

async function installRunner({
  version,
  tempDirectory,
  platform = process.platform,
  arch = process.arch,
  download = downloadAsset,
  extract = extractAsset,
}) {
  const asset = releaseAsset(version, platform, arch);
  if (typeof tempDirectory !== 'string' || !tempDirectory.trim()) {
    throw new InstallError('A temporary directory is required to install the CLI');
  }
  let installationDirectory;
  try {
    const root = path.resolve(tempDirectory);
    await fs.mkdir(root, { recursive: true });
    installationDirectory = await fs.mkdtemp(path.join(root, 'te-synthetics-'));
    const baseURL = `https://github.com/${REPOSITORY}/releases/download/${version}`;
    const checksums = path.join(installationDirectory, asset.checksumsName);
    const archive = path.join(installationDirectory, asset.archiveName);
    try {
      await download(`${baseURL}/${asset.checksumsName}`, checksums);
    } catch {
      throw new InstallError('Unable to download the pinned CLI release checksum manifest');
    }
    const manifest = await fs.readFile(checksums);
    const expected = checksumForAsset(manifest.toString('utf8'), asset.archiveName);
    try {
      await download(`${baseURL}/${asset.archiveName}`, archive);
    } catch {
      throw new InstallError('Unable to download the pinned CLI release archive');
    }
    const archiveStat = await fs.lstat(archive);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
      throw new InstallError('CLI release archive must be a regular file');
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== expected) {
      throw new InstallError('CLI release archive checksum did not match');
    }
    const extracted = path.join(installationDirectory, 'extracted');
    try {
      await extract(archive, extracted, asset.format);
    } catch {
      throw new InstallError('Unable to extract the pinned CLI release archive');
    }
    const allowed = new Set([asset.binaryName, asset.backendName, 'LICENSE', 'NOTICE', 'README.md', 'backend.json']);
    for (const entry of await fs.readdir(extracted, { withFileTypes: true })) {
      if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new InstallError('Synthetic CI archive contains an unexpected file');
      }
    }
    const executable = async name => {
      const filename = path.join(extracted, name);
      let info;
      try { info = await fs.lstat(filename); } catch {}
      if (!info || !info.isFile() || info.isSymbolicLink()) {
        throw new InstallError('Synthetic CI archive must contain regular runner and API CLI executables');
      }
      if (platform !== 'win32') await fs.chmod(filename, 0o755);
      return filename;
    };
    return { runnerPath: await executable(asset.binaryName), apiCLIPath: await executable(asset.backendName) };
  } catch (error) {
    if (installationDirectory) await fs.rm(installationDirectory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof InstallError) throw error;
    throw new InstallError('Unable to install the pinned ThousandEyes CLI release');
  }
}

module.exports = { installRunner, releaseAsset, checksumForAsset };
