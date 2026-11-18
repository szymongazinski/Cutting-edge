const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { downloadPublic } = require('./asset-download.cjs');

const repo = 'szymongazinski/Cutting-edge';
const name = 'Cutting-edge-Setup-x64.exe';
const sums = 'SHA256SUMS.txt';
const api = 'https://api.github.com/repos/' + repo + '/releases/latest';
const releaseHost = (host) =>
  [
    'api.github.com',
    'github.com',
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com',
    'github-releases.githubusercontent.com',
  ].includes(host);

function parts(version) {
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version))
    throw new Error('Invalid release version');
  return version.split('.').map(Number);
}
function newerVersion(candidate, current) {
  const next = parts(candidate),
    previous = parts(current);
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  return false;
}
function releaseInfo(data) {
  if (data.draft || data.prerelease || !/^v\d/.test(data.tag_name))
    throw new Error('Invalid stable release');
  const version = data.tag_name.slice(1);
  parts(version);
  const base = 'https://github.com/' + repo + '/releases/download/' + data.tag_name + '/';
  const asset = (filename) => {
    const found = data.assets.filter((item) => item.name === filename && item.state === 'uploaded');
    if (found.length !== 1 || found[0].browser_download_url !== base + filename)
      throw new Error('Missing or invalid release asset: ' + filename);
    return found[0];
  };
  const installer = asset(name);
  const checksums = asset(sums);
  return {
    version,
    url: installer.browser_download_url,
    sums: checksums.browser_download_url,
    digest: installer.digest,
  };
}
function expectedChecksum(text) {
  const matches = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => /^([a-f\d]{64})\s+\*?(.+?)\s*$/i.exec(line))
    .filter((match) => match && match[2] === name);
  if (matches.length !== 1) throw new Error('Missing or ambiguous installer SHA-256');
  return matches[0][1].toLowerCase();
}
async function latest() {
  const result = await downloadPublic(api, {
    maxBytes: 2 * 1024 * 1024,
    allowedHosts: releaseHost,
    accept: 'application/vnd.github+json',
  });
  return releaseInfo(JSON.parse(result.buffer));
}
async function checkUpdate(currentVersion) {
  try {
    const release = await latest();
    return {
      available: newerVersion(release.version, currentVersion),
      version: release.version,
      url: release.url,
    };
  } catch (error) {
    if (error.statusCode === 404) return { available: false, version: currentVersion, url: '' };
    throw error;
  }
}
let running;
async function downloadAndStart(currentVersion) {
  const release = await latest();
  if (!newerVersion(release.version, currentVersion))
    throw new Error('Already up to date / wersja jest aktualna');
  const checks = await downloadPublic(release.sums, { maxBytes: 128 * 1024, allowedHosts: releaseHost });
  const expected = expectedChecksum(checks.buffer.toString('utf8'));
  if (release.digest && release.digest.toLowerCase() !== 'sha256:' + expected)
    throw new Error('Conflicting release SHA-256');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'Cutting-edge-update-'));
  const installer = path.join(temp, name);
  try {
    const downloaded = await downloadPublic(release.url, {
      output: installer,
      maxBytes: 2 * 1024 ** 3,
      timeoutMs: 20 * 60 * 1000,
      allowedHosts: releaseHost,
    });
    if (downloaded.sha256 !== expected)
      throw new Error('Installer SHA-256 mismatch / nieprawidłowa suma kontrolna');
    await new Promise((resolve, reject) => {
      const child = spawn(
        installer,
        ['/SP-', '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RELAUNCH=1'],
        { detached: true, stdio: 'ignore' },
      );
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    return { version: release.version, started: true };
  } catch (error) {
    await fs.rm(temp, { force: true, recursive: true });
    throw error;
  }
}
function installUpdate(currentVersion) {
  if (!running)
    running = downloadAndStart(currentVersion).finally(() => {
      running = undefined;
    });
  return running;
}
module.exports = { checkUpdate, installUpdate, releaseInfo, expectedChecksum, newerVersion };
