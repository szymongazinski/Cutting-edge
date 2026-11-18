const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isFile, run } = require('./media-process.cjs');
const {
  timeline,
  projectDuration,
  number,
  between,
  batches,
  processingRanges,
} = require('./media-timeline.cjs');
const { captionsFile } = require('./media-captions.cjs');

let binaryCache;
async function getBinaries() {
  if (binaryCache) return binaryCache;
  const ext = process.platform === 'win32' ? '.exe' : '';
  const dirs = [
    process.resourcesPath && path.join(process.resourcesPath, 'tools'),
    process.env.CUTTING_EDGE_TOOLS,
    path.join(__dirname, '..', 'tools'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'ListenActive', 'tools', 'ffmpeg-7.1.1'),
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  for (const dir of dirs.filter(Boolean)) {
    const ffmpeg = path.resolve(dir, 'ffmpeg' + ext),
      ffprobe = path.resolve(dir, 'ffprobe' + ext);
    if ((await isFile(ffmpeg)) && (await isFile(ffprobe))) return (binaryCache = { ffmpeg, ffprobe });
  }
  throw new Error(
    'FFmpeg i FFprobe są niedostępne. Przygotuj narzędzia poleceniem node scripts/prepare-media.cjs.',
  );
}

const fileProtocols = ['-protocol_whitelist', 'file,pipe'];
async function probeAsset(file) {
  const { ffprobe } = await getBinaries();
  const { stdout } = await run(ffprobe, [
    '-v',
    'error',
    ...fileProtocols,
    '-of',
    'json',
    '-show_entries',
    'format=format_name,duration:format_tags=major_brand:stream=codec_name,codec_type,nb_frames,width,height,duration,pix_fmt:stream_tags=alpha_mode:stream_disposition=attached_pic:stream_side_data=rotation',
    '-i',
    path.resolve(file),
  ]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new Error('Plik nie zawiera obsługiwanego obrazu ani dźwięku.');
  const formatName = info.format?.format_name || '';
  const avifStill = info.format?.tags?.major_brand === 'avif' && !(Number(video?.nb_frames) > 1);
  const still =
    video &&
    !audio &&
    (avifStill ||
      formatName.includes('image2') ||
      formatName.endsWith('_pipe') ||
      (['apng', 'gif', 'webp'].includes(video.codec_name) && Number(video.nb_frames) === 1));
  const rotation = video?.side_data_list?.map((s) => Number(s.rotation)).find(Number.isFinite) || 0;
  const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const duration = Math.max(
    0,
    number(info.format?.duration),
    number(video?.duration),
    number(audio?.duration),
  );
  const hasAlpha =
    video?.tags?.alpha_mode === '1' ||
    /^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya|pal8)/.test(video?.pix_fmt || '');
  return {
    kind: video ? (still ? 'image' : 'video') : 'audio',
    duration: still ? 5 : duration,
    width: number(sideways ? video?.height : video?.width),
    height: number(sideways ? video?.width : video?.height),
    hasAudio: !!audio,
    hasAlpha,
    videoCodec: video?.codec_name || '',
    audioCodec: audio?.codec_name || '',
  };
}

async function overlayMetadata(project) {
  const assets = { ...project.assets },
    seen = new Map();
  // Earlier projects may have only kind/dimensions. FFmpeg's native VP8/VP9
  // decoders discard WebM's additional alpha plane; libvpx retains it.
  const visible = new Set(
    timeline(project)
      .filter((leaf) => leaf.picture && leaf.asset)
      .map((leaf) => leaf.clip.assetId),
  );
  for (const id of visible) {
    const asset = assets[id];
    if (asset.kind !== 'video' || typeof asset.hasAlpha === 'boolean') continue;
    if (!['vp8', 'vp9'].includes(asset.videoCodec) && !/\.(webm|mkv)$/i.test(asset.path || '')) continue;
    if (!seen.has(asset.path)) seen.set(asset.path, await probeAsset(asset.path));
    const { hasAlpha, videoCodec } = seen.get(asset.path);
    assets[id] = { ...asset, hasAlpha, videoCodec };
  }
  return { ...project, assets };
}

const dec = (n) => Number(n.toFixed(8)).toString();
const scaleBound = (n) => dec(between(n, 0, 1));
function sourceCrop(crop) {
  const left = scaleBound(crop.x),
    top = scaleBound(crop.y);
  const right = scaleBound(crop.x + crop.w),
    bottom = scaleBound(crop.y + crop.h);
  if (left === '0' && top === '0' && right === '1' && bottom === '1') return [];
  return [
    "crop=w='max(1,round(iw*" +
      right +
      ')-round(iw*' +
      left +
      "))':h='max(1,round(ih*" +
      bottom +
      ')-round(ih*' +
      top +
      "))':x='round(iw*" +
      left +
      ")':y='round(ih*" +
      top +
      ")':exact=1",
  ];
}
function pixelBox(box, width, height) {
  const x = Math.round(box.x * width),
    y = Math.round(box.y * height);
  return {
    x,
    y,
    w: Math.round((box.x + box.w) * width) - x,
    h: Math.round((box.y + box.h) * height) - y,
  };
}

async function graphFor(project, directory, { audioOnly = false, from, until }, leaves, baseFile) {
  const duration = until - from;
  if (!(duration > 0)) throw new Error('Oś czasu jest pusta.');
  const width = Math.round(number(project.width, 1920)),
    height = Math.round(number(project.height, 1080));
  const fps = number(project.fps, 30);
  if (
    !audioOnly &&
    (!(width >= 1 && width <= 16384 && height >= 1 && height <= 16384) || fps <= 0 || fps > 240)
  ) {
    throw new Error('Nieprawidłowa rozdzielczość lub liczba klatek na sekundę.');
  }
  const durationArg = dec(duration),
    video = 'video',
    audio = 'audio';
  const graph = [],
    inputs = [],
    audioInputs = ['[silence]'];
  let background = 'base',
    index = 0,
    layer = 0;
  graph.push('anullsrc=r=48000:cl=stereo:d=' + durationArg + '[silence]');
  if (baseFile) {
    inputs.push('-threads', '2', '-i', baseFile);
    audioInputs.push('[0:a:0]');
    if (!audioOnly) graph.push('[0:v:0]format=rgb24[base]');
    index++;
  } else if (!audioOnly) {
    graph.push(
      'color=c=black:s=' +
        width +
        'x' +
        height +
        ':r=' +
        dec(fps) +
        ':d=' +
        durationArg +
        ',format=rgb24[base]',
    );
  }
  for (const leaf of leaves) {
    const { asset, clip, picture } = leaf;
    const input = index,
      label = layer++;
    const span = dec(leaf.duration),
      start = dec(leaf.start);
    if (asset) {
      if (!asset.path) throw new Error('Brak ścieżki pliku: ' + (asset.name || asset.id));
      if (leaf.loop) inputs.push('-stream_loop', '-1');
      const sourceStart =
        leaf.loop && asset.duration > 0 ? leaf.sourceTime % asset.duration : leaf.sourceTime;
      if (asset.kind !== 'image') {
        if (sourceStart > 0) inputs.push('-ss', dec(sourceStart));
        inputs.push('-t', span);
      }
      if (asset.hasAlpha && ['vp8', 'vp9'].includes(asset.videoCodec)) {
        inputs.push('-c:v', asset.videoCodec === 'vp9' ? 'libvpx-vp9' : 'libvpx');
      }
      // Limit each decoder as many media streams can be open in one graph.
      inputs.push('-threads', '2', ...fileProtocols, '-i', path.resolve(asset.path));
      index++;
    }
    if (leaf.audio) {
      // Input seeking already makes timestamps relative to the common clip
      // origin. Keep any real offset between its first sound and first picture.
      const filters = [
        'aresample=48000:first_pts=0',
        'atrim=duration=' + span,
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
      ];
      if (leaf.volume !== 1) filters.push('volume=' + dec(leaf.volume));
      if (leaf.start > 0) filters.push('adelay=' + Math.round(48000 * leaf.start) + 'S:all=1');
      graph.push('[' + input + ':a:0]' + filters.join(',') + '[a' + label + ']');
      audioInputs.push('[a' + label + ']');
    }
    if (!picture) continue;
    const rect = pixelBox(picture.box, width, height);
    if (rect.w < 1 || rect.h < 1) continue;
    const filters = [];
    let source;
    if (asset) {
      source = '[' + input + ':V:0]';
      if (asset.kind === 'image') {
        filters.push(
          'trim=end_frame=1',
          'loop=loop=-1:size=1:start=0',
          'settb=AVTB',
          'setpts=N/(' + dec(fps) + '*TB)',
          'trim=duration=' + span,
        );
      } else {
        filters.push('fps=fps=' + dec(fps), 'trim=duration=' + span);
      }
    } else {
      if (clip.kind !== 'text' && clip.kind !== 'caption') continue;
      const w = between(Math.round(picture.localBox.w * width), 1, 16384);
      const h = between(Math.round(picture.localBox.h * height), 1, 16384);
      const file = 'caption-' + label + '.ass';
      await fs.writeFile(path.join(directory, file), captionsFile(leaf, w, h, height), 'utf8');
      source = 'color=c=black@0:s=' + w + 'x' + h + ':r=' + dec(fps) + ':d=' + span + ',format=rgba,';
      filters.push('ass=filename=' + file + ':alpha=1');
    }
    filters.push(
      ...sourceCrop(picture.crop),
      'scale=' + rect.w + ':' + rect.h + ':flags=bicubic',
      'setsar=1',
      'format=rgba',
      'settb=AVTB',
      'setpts=PTS+' + start + '/TB',
    );
    graph.push(source + filters.join(',') + '[v' + label + ']');
    const next = 'stack' + label;
    // libass draws premultiplied RGBA on its empty surface. PNG/GIF and other
    // decoded source formats supply ordinary straight alpha.
    const alpha = asset ? 'straight' : 'premultiplied';
    graph.push(
      '[' +
        background +
        '][v' +
        label +
        ']overlay=x=' +
        rect.x +
        ':y=' +
        rect.y +
        ':format=rgb:alpha=' +
        alpha +
        ":eof_action=pass:repeatlast=0:enable='gte(t," +
        start +
        ')*lt(t,' +
        dec(leaf.start + leaf.duration) +
        ")'[" +
        next +
        ']',
    );
    background = next;
  }
  if (!audioOnly) graph.push('[' + background + ']setsar=1[' + video + ']');
  graph.push(
    audioInputs.join('') +
      (audioInputs.length > 1
        ? 'amix=inputs=' + audioInputs.length + ':duration=first:normalize=0,'
        : '') +
      'atrim=duration=' +
      durationArg +
      '[' +
      audio +
      ']',
  );
  await fs.writeFile(path.join(directory, 'graph.ffgraph'), graph.join(';\n'), 'utf8');
  return { inputs, duration, width, height, fps, video, audio };
}

const qualityLevels = {
  draft: { h264: 28, preset: 'veryfast', vp9: 39, speed: 6, bitrate: '96k' },
  balanced: { h264: 20, preset: 'fast', vp9: 32, speed: 4, bitrate: '160k' },
  high: { h264: 16, preset: 'medium', vp9: 24, speed: 2, bitrate: '256k' },
};
function videoEncoder(format, quality, width, height) {
  const q = qualityLevels[quality] || qualityLevels.balanced;
  const args = ['-pix_fmt', width % 2 || height % 2 ? 'yuv444p' : 'yuv420p'];
  if (format === 'webm')
    args.push(
      '-c:v',
      'libvpx-vp9',
      '-crf',
      String(q.vp9),
      '-b:v',
      '0',
      '-deadline',
      'good',
      '-cpu-used',
      String(q.speed),
      '-row-mt',
      '1',
    );
  else args.push('-c:v', 'libx264', '-crf', String(q.h264), '-preset', q.preset);
  return args;
}
function muxEncoder(format, quality) {
  const q = qualityLevels[quality] || qualityLevels.balanced;
  const args = ['-c:a', format === 'webm' ? 'libopus' : 'aac', '-b:a', q.bitrate];
  if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart');
  return args;
}
async function ffRun(args, directory, duration, { onProgress, onStderr, logLevel = 'error' } = {}) {
  const { ffmpeg } = await getBinaries();
  await run(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-nostats', '-loglevel', logLevel, '-y', '-progress', 'pipe:1', ...args],
    {
      cwd: directory,
      onStderr,
      onStdout: (line) => {
        if (onProgress && line.startsWith('out_time_us=')) {
          const seconds = Number(line.slice(12)) / 1e6;
          if (Number.isFinite(seconds)) onProgress(between(seconds / duration, 0, 0.999));
        }
      },
    },
  );
}
function ffGraph(graph, directory, args, options) {
  return ffRun(
    [...graph.inputs, '-filter_complex_threads', '3', '-/filter_complex', 'graph.ffgraph', ...args],
    directory,
    graph.duration,
    options,
  );
}
async function boundedGraph(project, directory, window) {
  const groups = batches(timeline(project, window));
  let baseFile;
  for (let i = 0; i < groups.length; i++) {
    const graph = await graphFor(project, directory, window, groups[i], baseFile);
    if (i === groups.length - 1) return graph;
    const file = 'layers-' + (i % 2) + (window.audioOnly ? '.wav' : '.mkv');
    const streams = window.audioOnly
      ? ['-rf64', 'auto']
      : ['-map', '[video]', '-c:v', 'ffv1', '-pix_fmt', 'bgr0'];
    await ffGraph(graph, directory, [
      ...streams,
      '-map',
      '[audio]',
      '-c:a',
      'pcm_f32le',
      '-t',
      dec(graph.duration),
      file,
    ]);
    if (baseFile) await fs.unlink(path.join(directory, baseFile));
    baseFile = file;
  }
}
async function concatList(directory, parts) {
  // All basenames are internal ASCII names. Explicit durations keep NTSC and
  // other fractional frame rates from accumulating container rounding errors.
  const entries = parts.flatMap(({ file, duration }) => ['file ' + file, 'duration ' + dec(duration)]);
  await fs.writeFile(
    path.join(directory, 'parts.ffconcat'),
    ['ffconcat version 1.0', ...entries, ''].join('\n'),
  );
  return ['-f', 'concat', '-safe', '1', '-i', 'parts.ffconcat'];
}
async function audioGraph(project, directory, onPrepare = () => {}) {
  const ranges = processingRanges(project, true),
    duration = projectDuration(project);
  const parts = [];
  for (const [i, range] of ranges.entries()) {
    const graph = await boundedGraph(project, directory, { ...range, audioOnly: true });
    if (ranges.length === 1) return graph;
    const file = 'audio-' + i + '.wav';
    await ffGraph(graph, directory, ['-map', '[audio]', '-c:a', 'pcm_f32le', '-rf64', 'auto', file], {
      onProgress: (n) => onPrepare((range.from + graph.duration * n) / duration),
    });
    parts.push({ file, duration: graph.duration });
  }
  const inputs = await concatList(directory, parts);
  await fs.writeFile(path.join(directory, 'graph.ffgraph'), '[0:a:0]anull[audio]');
  return { inputs, duration };
}
async function temporary(root, work) {
  const dir = await fs.mkdtemp(path.join(root, '.cutting-edge-'));
  try {
    return await work(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
function progressReporter(callback) {
  let previous = -1;
  return (value) => {
    if (value > previous) {
      previous = value;
      callback?.(value);
    }
  };
}

async function protectSources(project, destination) {
  const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const sources = Object.values(project.assets || {})
    .map((a) => a.path)
    .filter(Boolean);
  const error = () =>
    new Error('Wybierz plik wynikowy inny niż plik źródłowy. / Choose a different output file.');
  if (sources.some((source) => key(source) === key(destination))) throw error();
  const realDestination = await fs.realpath(destination).catch(() => null);
  if (!realDestination) return;
  for (const source of sources) {
    const realSource = await fs.realpath(source).catch(() => null);
    if (realSource && key(realSource) === key(realDestination)) throw error();
  }
}

async function renderProject(project, destination, { onProgress } = {}) {
  const format = String(project.format || path.extname(destination).slice(1) || 'mp4').toLowerCase();
  if (!['mp4', 'mkv', 'mov', 'webm'].includes(format))
    throw new Error('Nieobsługiwany format: ' + format);
  const final = path.resolve(destination);
  const progress = progressReporter(onProgress);
  progress(0);
  await protectSources(project, final);
  project = await overlayMetadata(project);
  await fs.mkdir(path.dirname(final), { recursive: true });
  await temporary(path.dirname(final), async (directory) => {
    const file = path.join(directory, 'render.' + format);
    const ranges = processingRanges(project, false),
      duration = projectDuration(project),
      parts = [];
    for (const [i, range] of ranges.entries()) {
      const graph = await boundedGraph(project, directory, { ...range, audioOnly: false });
      const single = ranges.length === 1;
      const part = single ? file : 'video-' + i + '.mkv';
      const audio = single ? muxEncoder(format, project.quality) : ['-c:a', 'pcm_f32le'];
      await ffGraph(
        graph,
        directory,
        [
          '-map',
          '[video]',
          '-map',
          '[audio]',
          ...videoEncoder(format, project.quality, graph.width, graph.height),
          ...audio,
          '-t',
          dec(graph.duration),
          part,
        ],
        {
          onProgress: (n) =>
            progress(((single ? 1 : 0.95) * (range.from + graph.duration * n)) / duration),
        },
      );
      parts.push({ file: part, duration: graph.duration });
    }
    if (parts.length > 1) {
      const inputs = await concatList(directory, parts);
      await ffRun(
        [
          ...inputs,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-c:v',
          'copy',
          ...muxEncoder(format, project.quality),
          '-t',
          dec(duration),
          file,
        ],
        directory,
        duration,
        { onProgress: (n) => progress(0.95 + 0.05 * n) },
      );
    }
    await fs.rename(file, final);
  });
  progress(1);
  return final;
}

async function detectSilence(project, { db = -38, minDuration = 0.45 } = {}) {
  const duration = projectDuration(project);
  if (duration <= 0) return [];
  return temporary(os.tmpdir(), async (directory) => {
    const graph = await audioGraph(project, directory);
    const limit = between(number(db, -38), -120, 0);
    const minimum = Math.max(0.001, number(minDuration, 0.45));
    const ranges = [];
    let opened = null;
    // Attach the analyser to the graph output itself (a mapped complex stream
    // cannot also use -af). Each stderr line is consumed while FFmpeg runs.
    await fs.appendFile(
      path.join(directory, 'graph.ffgraph'),
      ';\n[audio]silencedetect=noise=' + dec(limit) + 'dB:d=' + dec(minimum) + '[measured]',
    );
    await ffGraph(graph, directory, ['-map', '[measured]', '-f', 'null', '-'], {
      logLevel: 'info',
      onStderr: (line) => {
        const match = /silence_(start|end):\s*(-?[\d.e+-]+)/i.exec(line);
        if (!match) return;
        const t = between(Number(match[2]), 0, duration);
        if (match[1] === 'start') opened = t;
        else if (opened !== null) {
          if (t > opened) ranges.push({ start: opened, end: t });
          opened = null;
        }
      },
    });
    if (opened !== null && duration > opened) ranges.push({ start: opened, end: duration });
    return ranges;
  });
}

async function transcribe(
  project,
  { language = 'auto', model = 'large-v3', uiLanguage = 'pl', onProgress, onStatus } = {},
) {
  if (projectDuration(project) <= 0) return [];
  const { recognize } = require('./media-speech.cjs');
  const progress = progressReporter(onProgress);
  const status = (pl, en) => onStatus?.(uiLanguage === 'en' ? en : pl);
  progress(0);
  status('Przygotowywanie ścieżki dźwiękowej…', 'Preparing the audio mix…');
  const cues = await temporary(os.tmpdir(), async (directory) => {
    const graph = await audioGraph(project, directory, (n) => progress(n * 0.04));
    const wav = path.join(directory, 'mix.wav');
    await ffGraph(
      graph,
      directory,
      ['-map', '[audio]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-rf64', 'auto', wav],
      { onProgress: (n) => progress(0.04 + n * 0.06) },
    );
    progress(0.1);
    return recognize(directory, wav, graph.duration, {
      model,
      language,
      status,
      onProgress: (n) => progress(0.1 + n * 0.899),
    });
  });
  progress(1);
  return cues;
}

module.exports = { getBinaries, probeAsset, renderProject, detectSilence, transcribe };
