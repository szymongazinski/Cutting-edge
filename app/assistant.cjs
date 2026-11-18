const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { number, member, stickerGif, soundWav } = require('./synthesis.cjs');
const { downloadPublic, findCommons, mediaExtension, MEDIA_LIMIT } = require('./asset-download.cjs');
const { queryCodex } = require('./codex-client.cjs');

const categories = ['global', 'audiofx', 'visualfx', 'sticker'];
const mediaTypes = /\.(gif|png|jpe?g|webp|bmp|wav|mp3|flac|ogg|m4a|aac|mp4|mkv|mov|webm|avi|m4v)$/i;
const clipFields = [
  'id',
  'name',
  'kind',
  'assetId',
  'start',
  'in',
  'duration',
  'track',
  'volume',
  'muted',
  'text',
];
const styleFields = ['font', 'size', 'color', 'stroke', 'strokeWidth', 'background', 'bold', 'italic'];
function copyScalars(source, fields, limit = 250) {
  const out = {};
  for (const field of fields) {
    const value = source?.[field];
    if (typeof value === 'string') out[field] = value.slice(0, limit);
    else if (typeof value === 'boolean' || Number.isFinite(value)) out[field] = value;
  }
  return out;
}
async function catalog(libraryDir) {
  const records = [];
  async function read(category, directory, group) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (records.length >= 650) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && group === undefined && !entry.name.startsWith('.')) {
        await read(category, file, entry.name);
      } else if (entry.isFile() && mediaTypes.test(entry.name)) {
        const stem = path.parse(entry.name).name;
        const id =
          'library-' +
          createHash('sha256').update(path.relative(libraryDir, file)).digest('hex').slice(0, 16);
        records.push({
          id,
          path: file,
          category,
          name: stem,
          ...(group ? { group, variant: stem } : {}),
        });
      }
    }
  }
  if (libraryDir)
    for (const category of categories) await read(category, path.join(libraryDir, category));
  return records;
}
function prepareContext({ project, selection = [], message, history = [], language, library = [] }) {
  const clips = Array.isArray(project?.clips) ? project.clips : [];
  const valid = new Set(clips.map((c) => c.id));
  let remaining = 380;
  function clipData(clip, depth = 0) {
    remaining--;
    const out = copyScalars(clip, clipFields, 900);
    for (const field of ['box', 'crop'])
      if (clip[field]) out[field] = copyScalars(clip[field], ['x', 'y', 'w', 'h']);
    if (clip.style) out.style = copyScalars(clip.style, styleFields);
    if (Array.isArray(clip.cues)) out.cueCount = clip.cues.length;
    if (depth < 4 && Array.isArray(clip.children)) {
      out.children = [];
      for (const child of clip.children) {
        if (!remaining) break;
        out.children.push(clipData(child, depth + 1));
      }
    }
    return out;
  }
  const chosen = Array.isArray(selection) ? selection.filter((id) => valid.has(id)).slice(0, 80) : [];
  const ordered = [
    ...clips.filter((c) => chosen.includes(c.id)),
    ...clips.filter((c) => !chosen.includes(c.id)),
  ];
  const timeline = [];
  for (const clip of ordered) {
    if (!remaining) break;
    timeline.push(clipData(clip));
  }
  const assetInfo = (item) =>
    copyScalars(item, [
      'id',
      'name',
      'kind',
      'category',
      'group',
      'variant',
      'duration',
      'width',
      'height',
      'hasAudio',
    ]);
  return {
    language: language === 'en' ? 'en' : 'pl',
    project: {
      ...copyScalars(project, ['name', 'width', 'height', 'fps', 'format', 'quality']),
      clips: timeline,
      assets: Object.values(project?.assets || {})
        .slice(0, 680)
        .map(assetInfo),
    },
    selection: chosen,
    library: library.slice(0, 650).map(assetInfo),
    history: (Array.isArray(history) ? history : [])
      .slice(-12)
      .filter((item) => ['user', 'assistant'].includes(item?.role))
      .map((item) => ({
        role: item.role,
        content: String(item.content ?? item.text ?? '').slice(0, 1600),
      })),
    message: requiredText(message, 5000, 'message'),
  };
}

function requiredText(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error('Invalid ' + label);
  return value.trim();
}
function safeName(value, fallback) {
  const result = String(value || fallback)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 72)
    .replace(/[. ]+$/g, '');
  if (!result) return fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(result) ? '_' + result : result;
}
function placement(action, libraryOnly = false) {
  const start = number(action.start, 0, 604800, 'start');
  const track = number(action.track, libraryOnly ? -1 : 0, 63, 'track');
  if (!Number.isInteger(track)) throw new Error('Track must be an integer');
  return { start, track };
}
function rect(value, isCrop) {
  if (!value || typeof value !== 'object') throw new Error('Invalid rectangle');
  const out = {};
  for (const field of ['x', 'y'])
    out[field] = number(value[field], isCrop ? 0 : -4, isCrop ? 1 : 4, field);
  for (const field of ['w', 'h']) out[field] = number(value[field], 0.0001, isCrop ? 1 : 8, field);
  if (isCrop && (out.x + out.w > 1.000001 || out.y + out.h > 1.000001))
    throw new Error('Crop exceeds source image');
  return out;
}
function textStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid style');
  const style = {};
  for (const [key, v] of Object.entries(value)) {
    if (v == null) continue;
    if (!styleFields.includes(key)) throw new Error('Invalid text style field');
    if (key === 'font') style.font = requiredText(v, 90, 'font');
    else if (key === 'size' || key === 'strokeWidth')
      style[key] = number(v, key === 'size' ? 1 : 0, key === 'size' ? 1024 : 96, key);
    else if (key === 'bold' || key === 'italic') style[key] = member(v, [true, false], key);
    else if (
      (key === 'background' && v === 'transparent') ||
      (typeof v === 'string' && /^#[a-f0-9]{6}$/i.test(v))
    )
      style[key] = v;
    else throw new Error('Invalid text color');
  }
  return style;
}
function patchFor(clip, raw, project) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid clip patch');
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    switch (key) {
      case 'name':
      case 'text':
        patch[key] = requiredText(value, key === 'text' ? 6000 : 160, key);
        break;
      case 'start':
      case 'in':
      case 'duration':
        patch[key] = number(value, key === 'duration' ? 0.001 : 0, 604800, key);
        break;
      case 'track':
        patch.track = placement({ start: 0, track: value }).track;
        break;
      case 'box':
      case 'crop':
        patch[key] = rect(value, key === 'crop');
        break;
      case 'volume':
        patch.volume = number(value, 0, 8, 'volume');
        break;
      case 'muted':
        patch.muted = member(value, [true, false], 'muted');
        break;
      case 'style':
        patch.style = { ...copyScalars(clip.style, styleFields), ...textStyle(value) };
        break;
      default:
        throw new Error('Unsupported clip property');
    }
  }
  if (!Object.keys(patch).length) throw new Error('Empty clip update');
  if (
    (patch.text !== undefined && clip.kind !== 'text') ||
    (patch.style && !['text', 'caption'].includes(clip.kind))
  )
    throw new Error('Clip does not support text editing');
  if ((patch.in !== undefined || patch.duration !== undefined) && clip.kind === 'media') {
    const asset = project.assets?.[clip.assetId];
    const loopable =
      asset?.kind === 'image' ||
      (asset?.kind === 'video' && ['sticker', 'visualfx'].includes(asset.category));
    if (
      !loopable &&
      asset?.duration > 0 &&
      (patch.in ?? clip.in ?? 0) + (patch.duration ?? clip.duration) > asset.duration + 0.001
    )
      throw new Error('Trim exceeds source duration');
  }
  return patch;
}
function insert(asset, start, track) {
  const action = {
    type: 'insertAsset',
    path: asset.path,
    category: asset.category || 'media',
    start,
    track,
  };
  for (const field of ['group', 'variant']) if (asset[field]) action[field] = asset[field];
  return action;
}

async function saveMedia(libraryDir, category, group, variant, ext, bytes, created) {
  if (!libraryDir || !path.isAbsolute(libraryDir)) throw new Error('Missing library directory');
  member(category, categories, 'category');
  const family = category === 'sticker' ? safeName(group, 'Custom') : undefined;
  const directory = path.join(libraryDir, category, ...(family ? [family] : []));
  await fs.mkdir(directory, { recursive: true });
  const realLibrary = await fs.realpath(libraryDir);
  const relative = path.relative(realLibrary, await fs.realpath(directory));
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
    throw new Error('Invalid library directory');
  const name = safeName(variant, 'Asset');
  const temp = path.join(directory, '.' + randomUUID() + '.tmp');
  await fs.writeFile(temp, bytes, { flag: 'wx' });
  try {
    for (let i = 1; i <= 1000; i++) {
      const stem = i === 1 ? name : name + ' (' + i + ')';
      const target = path.join(directory, stem + '.' + ext);
      try {
        // Atomic exclusive publication. Network/FAT volumes can lack hard links.
        try {
          await fs.link(temp, target);
        } catch (error) {
          if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(error.code))
            throw error;
          await fs.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
        }
        created.push(target);
        return { path: target, category, ...(family ? { group: family, variant: stem } : {}) };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Too many filename collisions');
  } finally {
    await fs.rm(temp, { force: true });
  }
}
function userLinks(message, history) {
  const turns = (Array.isArray(history) ? history : [])
    .slice(-12)
    .filter((item) => item?.role === 'user');
  const text = [
    ...turns.map((item) => String(item.content ?? item.text ?? '').slice(0, 1600)),
    String(message || '').slice(0, 5000),
  ].join('\n');
  const links = new Set();
  for (const match of text.matchAll(/https:\/\/[^\s<>"\u200b]+/gi)) {
    // Accept surrounding Markdown/punctuation, and keep exact query strings.
    const raw = match[0];
    for (const candidate of [raw, raw.replace(/[\])},.;:!?]+$/g, '')]) {
      try {
        links.add(new URL(candidate).href);
      } catch {
        /* Not a valid URL in the user's message. */
      }
    }
  }
  return links;
}
async function validatedRemote(action, links) {
  const search = action.type === 'findAsset';
  const found = search
    ? await findCommons(requiredText(action.query, 160, 'search terms'), action.category)
    : { url: requiredText(action.url, 3500, 'URL') };
  const url = new URL(found.url);
  if (!search && !links.has(url.href))
    throw new Error(
      'Direct downloads require a user-provided HTTPS link / wklej bezpośredni odnośnik HTTPS',
    );
  const result = await downloadPublic(url, {
    maxBytes: MEDIA_LIMIT,
    timeoutMs: 90000,
    allowedHosts: search ? (host) => host === 'upload.wikimedia.org' : undefined,
  });
  const ext = mediaExtension(result.buffer);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'Cutting-edge-import-'));
  try {
    const local = path.join(temp, 'media.' + ext);
    await fs.writeFile(local, result.buffer);
    const info = await require('./engine.cjs').probeAsset(local);
    if (
      info.duration > 900 ||
      info.width > 8192 ||
      info.height > 8192 ||
      info.width * info.height > 33554432
    )
      throw new Error('Media dimensions or duration exceed the import limit');
    if (
      (action.category === 'audiofx' && info.kind !== 'audio') ||
      (['sticker', 'visualfx'].includes(action.category) && info.kind === 'audio')
    )
      throw new Error('Media type does not match the selected library');
    return { ext, bytes: result.buffer, source: found.source || { page: url.origin + url.pathname } };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function materialize(commands, { project, libraryDir, library = [], message, history }) {
  if (!Array.isArray(commands) || commands.length > 40)
    throw new Error('Invalid number of assistant commands');
  const clips = new Map((project?.clips || []).map((c) => [c.id, { ...c }]));
  const assets = new Map(
    [...Object.values(project?.assets || {}), ...library].map((asset) => [asset.id, asset]),
  );
  const find = (id) => {
    if (!clips.has(id)) throw new Error('Unknown timeline clip');
    return clips.get(id);
  };
  const created = [],
    actions = [];
  const links = userLinks(message, history);
  let newAssets = 0;
  try {
    for (const action of commands) {
      switch (action?.type) {
        case 'update': {
          const clip = find(action.id),
            patch = patchFor(clip, action.patch, project);
          Object.assign(clip, patch);
          actions.push({ type: 'update', id: action.id, patch });
          break;
        }
        case 'remove':
          find(action.id);
          clips.delete(action.id);
          actions.push({ type: 'remove', id: action.id });
          break;
        case 'split': {
          const clip = find(action.id),
            time = number(action.time, 0, 604800, 'split time');
          if (time <= clip.start || time >= clip.start + clip.duration)
            throw new Error('Split must fall inside the clip');
          actions.push({ type: 'split', id: clip.id, time });
          break;
        }
        case 'compound': {
          if (
            !Array.isArray(action.ids) ||
            action.ids.length < 2 ||
            action.ids.length > 120 ||
            new Set(action.ids).size !== action.ids.length
          )
            throw new Error('Invalid group selection');
          for (const id of action.ids) {
            find(id);
            clips.delete(id);
          }
          actions.push({ type: 'compound', ids: [...action.ids] });
          break;
        }
        case 'addText': {
          const item = {
            type: 'addText',
            text: requiredText(action.text, 6000, 'text'),
            ...placement(action),
            duration: number(action.duration, 0.001, 604800, 'duration'),
          };
          if (action.box) item.box = rect(action.box, false);
          if (action.style) item.style = textStyle(action.style);
          actions.push(item);
          break;
        }
        case 'useAsset': {
          const asset = assets.get(action.assetId),
            { start, track } = placement(action);
          if (!asset?.path) throw new Error('Unknown media asset');
          actions.push(insert(asset, start, track));
          break;
        }
        case 'generateSticker':
        case 'generateSound':
        case 'downloadAsset':
        case 'findAsset': {
          if (++newAssets > 6) throw new Error('Maximum of six media creations per request');
          const { start, track } = placement(action, true);
          let category, ext, bytes, source;
          if (action.type === 'generateSticker') {
            category = member(action.category, ['sticker', 'visualfx'], 'graphic category');
            ext = 'gif';
            bytes = stickerGif(action);
          } else if (action.type === 'generateSound') {
            category = 'audiofx';
            ext = 'wav';
            bytes = soundWav(action.voices);
          } else {
            category = member(action.category, categories, 'category');
            ({ ext, bytes, source } = await validatedRemote(action, links));
          }
          const asset = await saveMedia(
            libraryDir,
            category,
            action.group,
            action.variant || action.name,
            ext,
            bytes,
            created,
          );
          if (source) {
            const attribution = asset.path + '.source.json';
            await fs.writeFile(attribution, JSON.stringify(source, null, 2) + '\n', { flag: 'wx' });
            created.push(attribution);
          }
          if (track >= 0) actions.push(insert(asset, start, track));
          break;
        }
        default:
          throw new Error('Unsupported assistant command');
      }
    }
    return actions;
  } catch (error) {
    await Promise.allSettled(created.map((file) => fs.rm(file, { force: true })));
    throw error;
  }
}
async function askAssistant(args) {
  const pl = args.language !== 'en';
  args.onEvent?.(pl ? 'Odczytuję projekt…' : 'Reading the project…');
  const library = await catalog(args.libraryDir);
  const context = prepareContext({ ...args, library });
  args.onEvent?.(pl ? 'ChatGPT analizuje polecenie…' : 'ChatGPT is reading your request…');
  const result = await queryCodex(context);
  const reply = requiredText(result.reply, 12000, 'assistant reply');
  if (result.actions?.length)
    args.onEvent?.(pl ? 'Przygotowuję zmiany i materiały…' : 'Preparing edits and media…');
  const actions = await materialize(result.actions, { ...args, library });
  return { reply, actions };
}
module.exports = { askAssistant, materialize, prepareContext };
