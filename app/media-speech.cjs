const fs = require('node:fs/promises');
const path = require('node:path');
const { isFile, run, sha256, download, unpack } = require('./media-process.cjs');
const { between } = require('./media-timeline.cjs');

const release = 'v0.1.1';
const archiveUrl =
  'https://github.com/szymongazinski/ListenActive/releases/download/' +
  release +
  '/ListenActive-Windows-x64.zip';
const archiveSha = 'a614a4c173175622d951ea3709d24590d3ab4672353d4d0c2ba473184b8d34f7';
const exeName = 'ListenActive.exe';
const models = new Map([
  ['tiny', 'Systran--faster-whisper-tiny'],
  ['base', 'Systran--faster-whisper-base'],
  ['small', 'Systran--faster-whisper-small'],
  ['medium', 'Systran--faster-whisper-medium'],
  ['large-v3', 'Systran--faster-whisper-large-v3'],
  ['large-v3-turbo', 'mobiuslabsgmbh--faster-whisper-large-v3-turbo'],
]);
let installed, installation;

async function shortcutExecutable() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$wsh = New-Object -ComObject WScript.Shell',
    "$folders = 'DesktopDirectory','CommonDesktopDirectory','Programs','CommonPrograms'",
    'foreach ($folder in $folders) {',
    '  $root = [Environment]::GetFolderPath($folder)',
    '  if (!$root) { continue }',
    "  $links = @((Join-Path $root 'ListenActive.lnk'), (Join-Path $root 'ListenActive\\ListenActive.lnk'))",
    '  foreach ($link in $links) {',
    '    if (Test-Path -LiteralPath $link -PathType Leaf) {',
    '      $target = $wsh.CreateShortcut($link).TargetPath',
    "      if ([IO.Path]::GetFileName($target) -ieq 'ListenActive.exe' -and (Test-Path -LiteralPath $target -PathType Leaf)) {",
    '        [Console]::WriteLine($target); exit 0',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const target = stdout.trim();
    if (await isFile(target)) return target;
  } catch {
    /* Portable installations can also be discovered in the locations below. */
  }
}

async function fetchRuntime(folder, onProgress) {
  const parent = path.dirname(folder);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, '.listenactive-'));
  try {
    const zip = path.join(staging, 'release.zip'),
      contents = path.join(staging, 'contents');
    await fs.mkdir(contents);
    await download(archiveUrl, archiveSha, zip, onProgress);
    await unpack(zip, contents);
    const unpacked = (await isFile(path.join(contents, exeName)))
      ? contents
      : path.join(contents, 'ListenActive');
    if (!(await isFile(path.join(unpacked, exeName))))
      throw new Error('Archiwum ListenActive nie zawiera programu.');
    // Staging is a sibling of the final directory. Two app instances may finish
    // together; only a complete runtime ever becomes visible to other readers.
    try {
      await fs.rename(unpacked, folder);
    } catch (error) {
      if (!(await isFile(path.join(folder, exeName)))) throw error;
    }
    return path.join(folder, exeName);
  } finally {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

async function executable(onProgress, status) {
  const override = process.env.CUTTING_EDGE_LISTENACTIVE;
  if (override) {
    if (await isFile(override)) return path.resolve(override);
    throw new Error('Ścieżka CUTTING_EDGE_LISTENACTIVE nie wskazuje pliku ListenActive.exe.');
  }
  if (installed && (await isFile(installed))) return installed;
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('Rozpoznawanie mowy wymaga ListenActive dla Windows x64.');
  }
  const data = process.env.LOCALAPPDATA;
  const folder = path.join(data, 'Cutting edge', 'runtime', 'ListenActive-' + release);
  const dirs = [
    folder,
    process.resourcesPath && path.join(process.resourcesPath, 'ListenActive'),
    path.join(path.dirname(process.execPath), 'ListenActive'),
    path.resolve(path.dirname(process.execPath), '..', 'ListenActive'),
    path.join(data, 'Programs', 'ListenActive'),
    path.join(data, 'ListenActive'),
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  for (const dir of dirs.filter(Boolean)) {
    const exe = path.resolve(dir, exeName);
    if (await isFile(exe)) return (installed = exe);
  }
  const shortcut = await shortcutExecutable();
  if (shortcut) return (installed = shortcut);
  status(
    'Pobieranie ListenActive (1,4 GB, pierwsze użycie)…',
    'Downloading ListenActive (1.4 GB, first use)…',
  );
  if (!installation)
    installation = fetchRuntime(folder, onProgress).finally(() => {
      installation = null;
    });
  return (installed = await installation);
}

async function modelSnapshot(model) {
  if (!process.env.LOCALAPPDATA) return null;
  const root = path.join(
    process.env.LOCALAPPDATA,
    'ListenActive',
    'models',
    'models--' + models.get(model),
  );
  try {
    const commit = (await fs.readFile(path.join(root, 'refs', 'main'), 'utf8')).trim();
    if (!/^[a-f0-9]{40}$/i.test(commit)) return null;
    const snapshot = path.join(root, 'snapshots', commit);
    for (const file of ['model.bin', 'config.json', 'tokenizer.json']) {
      if (!(await isFile(path.join(snapshot, file)))) return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function recognize(directory, wav, duration, { model, language, onProgress, status }) {
  if (!models.has(model)) throw new Error('Nieobsługiwany model mowy: ' + model);
  if (language !== 'auto' && !/^[a-z]{2,3}$/.test(language)) throw new Error('Nieprawidłowy kod języka.');
  const exe = await executable((n) => onProgress(n * 0.32), status);
  onProgress(0.33);
  const snapshot = await modelSnapshot(model);
  const file = path.join(directory, 'recognize.json'),
    output = path.join(directory, 'cues.json');
  const config = {
    audio: wav,
    output,
    duration,
    language,
    model: snapshot || model,
    sourceSha256: await sha256(wav),
  };
  if (snapshot) status('Lokalne rozpoznawanie mowy · ' + model, 'Recognizing speech locally · ' + model);
  else
    status(
      'Pobieranie modelu przy pierwszym użyciu · ' + model,
      'Downloading model on first use · ' + model,
    );
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1' };
  if (snapshot) env.HF_HUB_OFFLINE = '1';
  const report = (line) => {
    if (!line.startsWith('LISTENACTIVE:')) return;
    const match = /(\d+(?:\.\d+)?)%/.exec(line);
    if (match) onProgress(0.33 + 0.67 * between(Number(match[1]) / 100, 0, 1));
  };
  async function attempt(device) {
    await fs.writeFile(file, JSON.stringify({ ...config, device }), 'utf8');
    await run(exe, ['--recognize', file], { cwd: directory, env, onStdout: report });
    const result = JSON.parse(await fs.readFile(output, 'utf8'));
    if (!Array.isArray(result.segments)) throw new Error('Brak segmentów w odpowiedzi ListenActive.');
    let previous = 0;
    const cues = [];
    for (const cue of result.segments) {
      const start = Math.max(previous, Number(cue.start), 0),
        end = Math.min(duration, Number(cue.end));
      const text = String(cue.text || '').trim();
      if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        cues.push({ start, end, text });
        previous = end;
      }
    }
    return cues;
  }
  try {
    return await attempt('auto');
  } catch (first) {
    status('Ponawianie rozpoznawania na CPU · ' + model, 'Retrying recognition on CPU · ' + model);
    try {
      return await attempt('cpu');
    } catch (second) {
      throw new Error('ListenActive — ' + second.message, { cause: first });
    }
  }
}

module.exports = { recognize };
