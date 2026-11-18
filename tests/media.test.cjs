const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const enginePath = path.join(__dirname, '../app/engine.cjs');
const box = (x = 0, y = 0, w = 1, h = 1) => ({ x, y, w, h });
const media = (assetId, options = {}) => ({
  kind: 'media',
  assetId,
  start: 0,
  in: 0,
  duration: 1,
  track: 0,
  box: box(),
  crop: box(),
  volume: 1,
  muted: false,
  ...options,
});
const project = (clips, options = {}) => ({
  schema: 1,
  width: 96,
  height: 64,
  fps: 10,
  format: 'mp4',
  quality: 'high',
  assets,
  clips,
  ...options,
});
let engine, bins, dir, assets;

async function ff(args, options = {}) {
  return execute(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: 5_000_000,
    ...options,
  });
}
async function frame(file, time) {
  return (
    await ff([
      '-ss',
      String(time),
      '-i',
      file,
      '-frames:v',
      '1',
      '-an',
      '-c:v',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ])
  ).stdout;
}
function pixel(data, x, y) {
  const offset = (y * 96 + x) * 3;
  return [...data.subarray(offset, offset + 3)];
}
function isColor(rgb, expected) {
  return rgb.length === 3 && rgb.every((n, i) => Math.abs(n - expected[i]) < 35);
}
const black = [0, 0, 0],
  red = [255, 0, 0],
  blue = [0, 0, 255],
  green = [0, 255, 0];

before(async () => {
  assert.ok(require('node:fs').existsSync(enginePath), 'the media engine must exist');
  engine = require(enginePath);
  bins = await engine.getBinaries();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "Cutting edge Żółć's media "));
  const fixture = (name) => path.join(dir, name);
  await ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x48:d=2:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=550:duration=2:sample_rate=48000',
    '-vf',
    'drawbox=x=32:y=0:w=32:h=48:color=blue:t=fill',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'pcm_s16le',
    fixture('dwa kolory.mkv'),
  ]);
  await ff(['-f', 'lavfi', '-i', 'color=c=lime:s=24x24', '-frames:v', '1', fixture('zieleń.png')]);
  await ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=32x32:d=0.2:r=10',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=32x32:d=0.2:r=10',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0',
    '-loop',
    '0',
    fixture('pętla.gif'),
  ]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000', fixture('ton.wav')]);
  assets = {};
  for (const [id, name] of [
    ['video', 'dwa kolory.mkv'],
    ['still', 'zieleń.png'],
    ['gif', 'pętla.gif'],
    ['tone', 'ton.wav'],
  ]) {
    const file = fixture(name);
    assets[id] = { id, path: file, category: 'media', ...(await engine.probeAsset(file)) };
  }
});
after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('probe distinguishes a still, an animated GIF, audio and video with audio', () => {
  assert.deepEqual([assets.still.kind, assets.still.duration, assets.still.width], ['image', 5, 24]);
  assert.deepEqual([assets.gif.kind, assets.gif.duration, assets.gif.hasAudio], ['video', 0.4, false]);
  assert.deepEqual([assets.video.kind, assets.video.height, assets.video.hasAudio], ['video', 48, true]);
  assert.deepEqual([assets.tone.kind, assets.tone.duration, assets.tone.width], ['audio', 1, 0]);
});

test('a still AVIF remains an extendable image', async () => {
  const file = path.join(dir, 'zdjęcie.avif');
  await ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=16x16',
    '-frames:v',
    '1',
    '-c:v',
    'libaom-av1',
    '-cpu-used',
    '8',
    file,
  ]);
  const asset = await engine.probeAsset(file);
  assert.deepEqual([asset.kind, asset.duration, asset.width], ['image', 5, 16]);
});

test('nested trims, group crop, alpha outside child layers and equal-track stacking survive export', async () => {
  const file = path.join(dir, 'warstwy.mp4');
  const clips = [
    media('still', { duration: 1.3 }),
    {
      kind: 'compound',
      start: 0.4,
      in: 0.3,
      duration: 0.6,
      track: 1,
      box: box(0.25, 0.25, 0.5, 0.5),
      crop: box(0.5, 0, 0.5, 1),
      children: [
        {
          kind: 'compound',
          start: 0.2,
          in: 0,
          duration: 1,
          box: box(),
          children: [media('video', { start: 0.1, box: box(0, 0, 1, 0.75) })],
        },
      ],
    },
    media('still', { track: 1, start: 0.5, duration: 0.2, box: box(0.4, 0.4, 0.15, 0.15) }),
  ];
  const progress = [];
  await engine.renderProject(project(clips), file, { onProgress: (p) => progress.push(p) });
  const active = await frame(file, 0.6);
  assert.ok(isColor(pixel(active, 29, 24), blue), 'cropped right side of child must be blue');
  assert.ok(isColor(pixel(active, 43, 28), green), 'later equal-track layer must be in front');
  assert.ok(isColor(pixel(active, 32, 45), green), 'empty area of compound must be transparent');
  assert.ok(
    isColor(pixel(await frame(file, 1.1), 29, 24), green),
    'underlying layer returns after compound ends',
  );
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (!i || p >= progress[i - 1])));
});

test('only moving sticker/effect assets repeat, preserving source phase across trims', async () => {
  const file = path.join(dir, 'pętle.mkv');
  const scene = project(
    [
      media('gif', { in: 0.1, duration: 0.9, box: box(0, 0, 0.5, 1) }),
      media('sticker', { in: 0.1, duration: 0.9, box: box(0.5, 0, 0.5, 1) }),
    ],
    { format: 'mkv', assets: { ...assets, sticker: { ...assets.gif, category: 'sticker' } } },
  );
  await engine.renderProject(scene, file);
  const first = await frame(file, 0.1),
    second = await frame(file, 0.4),
    third = await frame(file, 0.6);
  assert.ok(isColor(pixel(first, 18, 20), blue));
  assert.ok(isColor(pixel(second, 18, 20), black));
  assert.ok(isColor(pixel(second, 75, 20), red));
  assert.ok(isColor(pixel(third, 75, 20), blue));
});

test('transparent WebM overlays retain alpha on both new and older project assets', async () => {
  const effect = path.join(dir, 'nakładka.webm');
  await ff([
    '-f',
    'lavfi',
    '-i',
    "nullsrc=s=32x32:r=10:d=0.5,format=rgba,geq=r=255:g=0:b=0:a='if(lt(X,16),0,255)'",
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-deadline',
    'realtime',
    '-cpu-used',
    '6',
    '-auto-alt-ref',
    '0',
    effect,
  ]);
  const meta = await engine.probeAsset(effect);
  for (const legacy of [false, true]) {
    const result = path.join(dir, 'alpha-' + legacy + '.mp4');
    const asset = { ...meta, path: effect, category: 'visualfx' };
    if (legacy) {
      delete asset.videoCodec;
      delete asset.hasAlpha;
    }
    await engine.renderProject(
      project([media('still', { duration: 0.5 }), media('overlay', { track: 1, duration: 0.5 })], {
        assets: { ...assets, overlay: asset },
      }),
      result,
    );
    const at = await frame(result, 0.2);
    assert.ok(isColor(pixel(at, 20, 32), green), 'transparent half of WebM must reveal background');
    assert.ok(isColor(pixel(at, 70, 32), red), 'opaque half of WebM must remain red');
  }
});

test('caption text and its colored box obey cue time, trim and bounds', async () => {
  const file = path.join(dir, 'napisy.mov');
  await engine.renderProject(
    project(
      [
        {
          kind: 'caption',
          start: 0.1,
          in: 0.5,
          duration: 1,
          box: box(0.125, 0.25, 0.75, 0.5),
          cues: [{ start: 0.7, end: 1.1, text: 'Żółć\n42' }],
          style: {
            font: 'Arial',
            size: 13,
            color: '#ffffff',
            stroke: '#000000',
            strokeWidth: 1,
            background: '#ff0000',
            bold: true,
          },
        },
      ],
      { format: 'mov' },
    ),
    file,
  );
  assert.ok(isColor(pixel(await frame(file, 0.1), 17, 21), black));
  const at = await frame(file, 0.4);
  assert.ok(isColor(pixel(at, 17, 21), red));
  assert.ok(isColor(pixel(at, 9, 21), black));
  for (const [from, to] of [
    [17, 32],
    [32, 47],
  ]) {
    let white = 0;
    for (let y = from; y < to; y++)
      for (let x = 17; x < 79; x++) if (pixel(at, x, y).every((n) => n > 160)) white++;
    assert.ok(white > 3, 'both explicit lines must contain white glyphs');
  }
  assert.ok(isColor(pixel(await frame(file, 0.8), 17, 21), black));
});

test('antialiased white text on white stays white at its transparent edges', async () => {
  const whiteFile = path.join(dir, 'biała.png'),
    result = path.join(dir, 'jasne.mp4');
  await ff(['-f', 'lavfi', '-i', 'color=c=white:s=24x24', '-frames:v', '1', whiteFile]);
  const scene = project(
    [
      media('white'),
      {
        kind: 'text',
        start: 0,
        duration: 1,
        track: 1,
        text: 'Ag',
        box: box(),
        style: { font: 'Arial', size: 29, color: '#ffffff', strokeWidth: 0, background: 'transparent' },
      },
    ],
    { assets: { white: { ...assets.still, path: whiteFile } } },
  );
  await engine.renderProject(scene, result);
  const at = await frame(result, 0.3);
  assert.ok(Math.min(...at) > 245, 'minimum channel value on white: ' + Math.min(...at));
});

test('silence analysis uses trimmed nested audio with mute, offset and project end', async () => {
  const scene = project([
    { kind: 'text', text: '', duration: 1.2, start: 0 },
    {
      kind: 'compound',
      start: 0.25,
      in: 0.3,
      duration: 0.8,
      volume: 0.7,
      children: [media('tone', { start: 0.45, duration: 0.3 })],
    },
    media('tone', { start: 0.85, duration: 0.2, muted: true }),
  ]);
  const ranges = await engine.detectSilence(scene, { db: -44, minDuration: 0.15 });
  assert.equal(ranges.length, 2);
  for (const [i, pair] of [
    [0, [0, 0.4]],
    [1, [0.7, 1.2]],
  ]) {
    assert.ok(Math.abs(ranges[i].start - pair[0]) < 0.015);
    assert.ok(Math.abs(ranges[i].end - pair[1]) < 0.015);
  }
});

test('source-in preserves an original audio delay relative to the camera image', async () => {
  const file = path.join(dir, 'opóźniony dźwięk.mkv');
  await ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x48:d=1:r=10',
    '-itsoffset',
    '0.3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=441:duration=0.4:sample_rate=48000',
    '-c:v',
    'ffv1',
    '-c:a',
    'pcm_s16le',
    file,
  ]);
  const scene = project([media('offset', { in: 0.1, start: 0.2, duration: 0.8 })], {
    assets: { offset: { path: file, category: 'media', ...(await engine.probeAsset(file)) } },
  });
  const ranges = await engine.detectSilence(scene, { db: -46, minDuration: 0.1 });
  assert.equal(ranges.length, 2);
  assert.ok(
    Math.abs(ranges[0].end - 0.4) < 0.015,
    'audio should begin at .4 s, received ' + ranges[0].end,
  );
  assert.ok(
    Math.abs(ranges[1].start - 0.8) < 0.015,
    'audio should finish at .8 s, received ' + ranges[1].start,
  );
});

test('source-in preserves an original video delay relative to sound', async () => {
  const file = path.join(dir, 'opóźniony obraz.mkv'),
    result = path.join(dir, 'synchronizacja.mkv');
  await ff([
    '-itsoffset',
    '0.3',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x48:d=0.6:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=441:duration=1:sample_rate=48000',
    '-fps_mode',
    'passthrough',
    '-c:v',
    'ffv1',
    '-c:a',
    'pcm_s16le',
    file,
  ]);
  await engine.renderProject(
    project([media('offset', { in: 0.1, start: 0.2, duration: 0.8 })], {
      format: 'mkv',
      assets: { offset: { path: file, category: 'media', ...(await engine.probeAsset(file)) } },
    }),
    result,
  );
  assert.ok(
    isColor(pixel(await frame(result, 0.3), 20, 20), black),
    'video should still be absent at .3 s',
  );
  assert.ok(
    isColor(pixel(await frame(result, 0.4), 20, 20), red),
    'first red frame should appear at .4 s',
  );
});

test('parallel audio tracks add at their nested linear gains', async () => {
  const result = path.join(dir, 'mix.mkv');
  await engine.renderProject(
    project(
      [
        media('tone', { duration: 0.75, volume: 0.4 }),
        {
          kind: 'compound',
          start: 0.25,
          in: 0.25,
          duration: 0.5,
          volume: 0.5,
          children: [media('tone', { duration: 1, volume: 0.8 })],
        },
      ],
      { format: 'mkv' },
    ),
    result,
  );
  const { stdout } = await ff(['-i', result, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
  function rms(time) {
    const offset = Math.round(time * 48000) * 2;
    let sum = 0;
    for (let i = 0; i < 4800; i++) sum += stdout.readInt16LE(offset + i * 2) ** 2;
    return Math.sqrt(sum / 4800);
  }
  const ratio = rms(0.4) / rms(0.1);
  assert.ok(ratio > 1.85 && ratio < 2.15, 'overlap/single-track RMS ratio: ' + ratio);
});

test('a long sequence of one-frame cuts preserves every picture beyond the Windows command-line limit', async () => {
  const greenFile = path.join(dir, 'zieleń-' + 's'.repeat(154) + '.png');
  const redFile = path.join(dir, 'czerwień-' + 'c'.repeat(152) + '.png');
  await fs.copyFile(assets.still.path, greenFile);
  await ff(['-f', 'lavfi', '-i', 'color=c=red:s=24x24', '-frames:v', '1', redFile]);
  const count = 153,
    fps = 25;
  const clips = Array.from({ length: count }, (_, i) =>
    media(i % 2 ? 'r' : 'g', { start: i / fps, duration: 1 / fps }),
  );
  const scene = project(clips, {
    fps,
    format: 'mp4',
    assets: { g: { ...assets.still, path: greenFile }, r: { ...assets.still, path: redFile } },
  });
  const destination = path.join(dir, 'cięcia.mp4');
  await engine.renderProject(scene, destination);
  const { stdout } = await ff([
    '-i',
    destination,
    '-an',
    '-vf',
    'scale=1:1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  assert.equal(stdout.length, count * 3);
  for (let i = 0; i < count; i++) {
    assert.ok(
      isColor([...stdout.subarray(i * 3, i * 3 + 3)], i % 2 ? red : green),
      'color of frame ' + i,
    );
  }
});

test('large overlapping stacks keep lower layers visible through bounded rendering passes', async () => {
  const clips = Array.from({ length: 66 }, () =>
    media('still', { duration: 0.2, box: box(0.75, 0, 0.25, 0.25) }),
  );
  clips[0] = media('still', { duration: 0.2 });
  clips[35] = media('video', {
    duration: 0.2,
    box: box(0, 0, 0.4, 1),
    crop: box(0.5, 0, 0.5, 1),
    muted: true,
  });
  clips[65] = media('video', {
    duration: 0.2,
    box: box(0.55, 0.25, 0.25, 0.5),
    crop: box(0, 0, 0.5, 1),
    muted: true,
  });
  const result = path.join(dir, 'warstwy-66.mkv');
  await engine.renderProject(project(clips, { format: 'mkv' }), result);
  const at = await frame(result, 0.1);
  assert.ok(isColor(pixel(at, 12, 30), blue));
  assert.ok(isColor(pixel(at, 46, 30), green));
  assert.ok(isColor(pixel(at, 67, 30), red));
});

test('dense audio edits preserve speech and continuous silence across processing windows', async () => {
  const source = path.join(dir, 'dźwięk-' + 'a'.repeat(153) + '.wav');
  await fs.copyFile(assets.tone.path, source);
  const clips = Array.from({ length: 160 }, (_, i) =>
    media('sound', {
      start: i / 25,
      in: 0,
      duration: 1 / 25,
      volume: i >= 50 && i < 111 ? 0 : 1,
    }),
  );
  // Quiet, unmuted companions still occupy inputs and span each side of the silent gap.
  clips.push(
    ...Array.from({ length: 160 }, (_, i) =>
      media('sound', { start: i / 25, duration: 1 / 25, volume: 0.000001 }),
    ),
  );
  const scene = project(clips, { fps: 25, assets: { sound: { ...assets.tone, path: source } } });
  const ranges = await engine.detectSilence(scene, { db: -50, minDuration: 1.9 });
  assert.equal(ranges.length, 1);
  assert.ok(
    Math.abs(ranges[0].start - 2) < 0.004 && Math.abs(ranges[0].end - 4.44) < 0.004,
    JSON.stringify(ranges),
  );
});

test('all four encoders produce playable streams, selected FPS and portrait dimensions', async () => {
  for (const [format, video, audio] of [
    ['mp4', 'h264', 'aac'],
    ['mov', 'h264', 'aac'],
    ['mkv', 'h264', 'aac'],
    ['webm', 'vp9', 'opus'],
  ]) {
    const destination = path.join(dir, 'format.' + format);
    await engine.renderProject(
      project([media('still', { duration: 0.4 }), media('tone', { duration: 0.4 })], {
        format,
        width: 64,
        height: 96,
        fps: 25,
        quality: 'draft',
      }),
      destination,
    );
    const { stdout } = await execute(
      bins.ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination],
      { windowsHide: true },
    );
    const info = JSON.parse(stdout),
      v = info.streams.find((s) => s.codec_type === 'video'),
      a = info.streams.find((s) => s.codec_type === 'audio');
    assert.deepEqual(
      [v.codec_name, a.codec_name, v.width, v.height, v.r_frame_rate],
      [video, audio, 64, 96, '25/1'],
    );
    assert.ok(Math.abs(Number(info.format.duration) - 0.4) < 0.06);
  }
});

test('encoder failures preserve an existing file at the selected destination', async () => {
  const file = path.join(dir, 'existing.mp4');
  await fs.writeFile(file, 'old');
  await assert.rejects(
    engine.renderProject(
      project([media('video')], {
        assets: { video: { ...assets.video, path: path.join(dir, 'missing.mkv') } },
      }),
      file,
    ),
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
});

test('export cannot replace one of the project source files', async () => {
  const file = path.join(dir, 'chronione źródło.mkv');
  await fs.copyFile(assets.video.path, file);
  const scene = project([media('input')], {
    format: 'mkv',
    assets: { input: { ...assets.video, path: file } },
  });
  const original = await fs.readFile(file);
  await assert.rejects(engine.renderProject(scene, file));
  assert.deepEqual(await fs.readFile(file), original);
});

test('an unused missing legacy library item does not block rendering', async () => {
  const file = path.join(dir, 'bez nieużywanych.mp4');
  const scene = project([media('still', { duration: 0.2 })], {
    assets: { ...assets, lost: { kind: 'video', path: path.join(dir, 'stary.webm'), duration: 2 } },
  });
  await engine.renderProject(scene, file);
  assert.ok(isColor(pixel(await frame(file, 0.1), 25, 30), green));
});

test(
  'ListenActive recognizes a locally synthesized sentence with timed English words',
  {
    skip: process.env.CUTTING_EDGE_TEST_WHISPER !== '1',
    timeout: 600000,
  },
  async () => {
    const source = path.join(dir, 'speech.wav');
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Male, [System.Speech.Synthesis.VoiceAge]::Adult, 0, [cultureinfo]'en-US'); $s.SetOutputToWaveFile($env:CUTTING_EDGE_SAMPLE_WAV); $s.Speak('Good morning. This is a short audio recording for the video editor.'); $s.Dispose()",
      ],
      { windowsHide: true, env: { ...process.env, CUTTING_EDGE_SAMPLE_WAV: source } },
    );
    const entry = { id: 'speech', path: source, category: 'media', ...(await engine.probeAsset(source)) };
    const cues = await engine.transcribe(
      project([media('speech', { duration: entry.duration })], { assets: { speech: entry } }),
      { language: 'en', model: 'large-v3' },
    );
    assert.match(cues.map((c) => c.text).join(' '), /morning|recording|video editor/i);
    assert.ok(cues.every((c) => c.start >= 0 && c.end > c.start && c.end <= entry.duration + 0.01));
  },
);

test(
  'first speech job provisions the pinned portable runtime in a clean Windows profile',
  {
    skip: process.env.CUTTING_EDGE_TEST_SETUP !== '1' || process.platform !== 'win32',
    timeout: 1200000,
  },
  async () => {
    const profile = await fs.mkdtemp(path.join(dir, 'clean-profile-'));
    const data = path.join(profile, 'ListenActive'),
      linkedModels = path.join(data, 'models');
    const localModels = path.join(process.env.LOCALAPPDATA, 'ListenActive', 'models');
    await fs.mkdir(data, { recursive: true });
    // Reuse model weights for this download test, while hiding both the existing
    // runtime directory and the desktop shortcut resolver from the child.
    const haveModelCache = await fs.stat(localModels).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (haveModelCache) await fs.symlink(localModels, linkedModels, 'junction');
    const env = { ...process.env, LOCALAPPDATA: profile, CUTTING_EDGE_LISTENACTIVE: '' };
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = path.join(process.env.SystemRoot, 'System32');
    const code = [
      'const { transcribe } = require(process.argv[1]);',
      "const project = {assets:{t:{kind:'audio',path:process.argv[2],duration:1}},clips:[{kind:'media',assetId:'t',duration:1}]};",
      "transcribe(project,{language:'en',model:process.argv[3],uiLanguage:'en',onStatus:console.log}).then(cues=>console.log(JSON.stringify(cues))).catch(error=>{console.error(error);process.exitCode=1});",
    ].join('\n');
    try {
      const { stdout } = await execute(
        process.execPath,
        ['-e', code, enginePath, assets.tone.path, haveModelCache ? 'large-v3' : 'tiny'],
        { windowsHide: true, env, timeout: 1150000 },
      );
      assert.match(stdout, /Downloading ListenActive/);
      assert.match(stdout, /\[\]/);
      const exe = path.join(
        profile,
        'Cutting edge',
        'runtime',
        'ListenActive-v0.1.1',
        'ListenActive.exe',
      );
      assert.ok((await fs.stat(exe)).size > 1000000);
    } finally {
      if (haveModelCache) await fs.unlink(linkedModels);
    }
  },
);
