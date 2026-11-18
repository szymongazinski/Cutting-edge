const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function isFile(file) {
  if (!file) return false;
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

function run(file, args, { cwd, env, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    function read(stream, callback, limit) {
      let tail = '',
        partial = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        tail = (tail + chunk).slice(-limit);
        if (!callback) return;
        const lines = (partial + chunk).split(/\r\n|\r|\n/);
        partial = lines.pop().slice(-limit);
        for (const line of lines) if (line) callback(line);
      });
      stream.on('end', () => {
        if (partial && callback) callback(partial);
      });
      return () => tail;
    }
    const stdout = read(child.stdout, onStdout, 1024 * 1024);
    const stderr = read(child.stderr, onStderr, 32 * 1024);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout: stdout(), stderr: stderr() });
      const detail = (stderr().trim() || stdout().trim()).split(/\r?\n/).slice(-14).join('\n');
      reject(
        new Error(path.basename(file) + ' (' + (signal || code) + ')' + (detail ? '\n' + detail : '')),
      );
    });
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, digest, target, onProgress = () => {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Cutting-edge-media-tools' } });
  if (!response.ok || !response.body) throw new Error('Download ' + response.status + ' — ' + url);
  const total = Number(response.headers.get('content-length'));
  const hash = createHash('sha256');
  let bytes = 0,
    previousPercent = -1;
  const meter = new Transform({
    transform(chunk, encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      const percent = total > 0 ? Math.min(100, Math.floor((100 * bytes) / total)) : 0;
      if (percent !== previousPercent) onProgress(percent / 100);
      previousPercent = percent;
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target, { flags: 'wx' }));
  if (hash.digest('hex') !== digest) throw new Error('SHA-256 mismatch — ' + url);
}

async function unpack(zip, destination) {
  if (process.platform !== 'win32') {
    await run('unzip', ['-q', zip, '-d', destination]);
    return;
  }
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (await isFile(tar)) {
    await run(tar, ['-xf', zip, '-C', destination]);
    return;
  }
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:CUTTING_ARCHIVE,$env:CUTTING_UNPACK)",
    ],
    { env: { ...process.env, CUTTING_ARCHIVE: zip, CUTTING_UNPACK: destination } },
  );
}

module.exports = { isFile, run, sha256, download, unpack };
