const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareContext, materialize } = require('../app/assistant.cjs');
const { publicAddress, mediaExtension } = require('../app/asset-download.cjs');
const { stickerGif } = require('../app/synthesis.cjs');

const project = {
  name: 'Film',
  width: 1920,
  height: 1080,
  fps: 30,
  assets: {
    A: {
      id: 'A',
      name: 'Camera',
      path: 'C:/private/camera.mp4',
      kind: 'video',
      category: 'media',
      duration: 9,
    },
  },
  clips: [
    { id: 'C', name: 'Camera', kind: 'media', assetId: 'A', in: 1, start: 0, duration: 5, track: 0 },
  ],
};

test('only timeline metadata, selection and bounded chat text go to the model', () => {
  const context = prepareContext({
    project,
    selection: ['C', 'unknown'],
    message: 'Trim',
    history: [{ role: 'user', content: 'Earlier', secret: 'MASK' }],
    language: 'en',
  });
  const text = JSON.stringify(context);
  assert.ok(text.includes('Camera') && text.includes('Earlier'));
  assert.deepEqual(context.selection, ['C']);
  assert.doesNotMatch(text, /private|MASK|camera\.mp4|unknown/);
});

test('accepts edits to known clips and paths from known assets only', async () => {
  const edits = [
    { type: 'update', id: 'C', patch: { track: 2, muted: true } },
    { type: 'split', id: 'C', time: 2.5 },
    { type: 'useAsset', assetId: 'A', start: 3, track: 1 },
  ];
  const actions = await materialize(edits, { project });
  assert.deepEqual(actions.slice(0, 2), edits.slice(0, 2));
  assert.deepEqual(actions[2], {
    type: 'insertAsset',
    path: project.assets.A.path,
    category: 'media',
    start: 3,
    track: 1,
  });
  await assert.rejects(materialize([{ type: 'remove', id: 'missing' }], { project }));
  await assert.rejects(materialize([{ type: 'insertAsset', path: '/arbitrary/file' }], { project }));
  await assert.rejects(materialize([{ type: 'split', id: 'C', time: 7 }], { project }));
  await assert.rejects(materialize([{ type: 'update', id: 'C', patch: { volume: 1e15 } }], { project }));
});

test('creates a looping transparent GIF and a matching PCM sound from original layer instructions', async (t) => {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutting-material-'));
  t.after(() => fs.rm(libraryDir, { recursive: true, force: true }));
  const element = {
    shape: 'heart',
    x: 0.5,
    y: 0.5,
    width: 0.65,
    height: 0.65,
    color: '#ff2364',
    rotation: 0,
    motion: 'pulse',
    phase: 0,
  };
  const sticker = {
    type: 'generateSticker',
    category: 'sticker',
    group: 'Hearts',
    variant: 'Róż',
    seconds: 1,
    layers: [element],
    start: 0,
    track: 1,
  };
  const sound = {
    type: 'generateSound',
    name: 'Click',
    voices: [
      {
        wave: 'sine',
        start: 0,
        duration: 0.2,
        fromHz: 880,
        toHz: 440,
        volume: 0.85,
        attack: 0.005,
        release: 0.15,
      },
    ],
    start: 0.4,
    track: 3,
  };
  const [graphic, audio] = await materialize([sticker, sound], { project, libraryDir });
  assert.equal(graphic.type, 'insertAsset');
  assert.equal(graphic.group, 'Hearts');
  assert.equal(path.relative(libraryDir, graphic.path), path.join('sticker', 'Hearts', 'Róż.gif'));
  const gif = await fs.readFile(graphic.path);
  assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
  assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')));
  assert.ok(gif.indexOf(Buffer.from([0x21, 0xf9, 4])) !== gif.lastIndexOf(Buffer.from([0x21, 0xf9, 4])));
  const wav = await fs.readFile(audio.path);
  assert.equal(audio.category, 'audiofx');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.ok(Math.abs(wav.readUInt32LE(40) / (2 * wav.readUInt32LE(24)) - 0.2) < 0.001);
  assert.ok([...wav.subarray(44, 3044)].some((v) => v !== 0));
  const [again] = await materialize([sticker], { project, libraryDir });
  assert.deepEqual(await fs.readFile(again.path), gif);
  await assert.rejects(materialize([sound, { type: 'remove', id: 'absent' }], { project, libraryDir }));
  assert.equal(
    (await fs.readdir(path.join(libraryDir, 'audiofx'))).filter((name) => name.endsWith('.wav')).length,
    1,
  );
});

test('recognizes media by content and blocks local and special network addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.1.1',
    '169.254.169.254',
    '100.64.12.8',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::5',
    'fe80::1',
    '2001:db8::1',
  ]) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.ok(publicAddress('8.8.8.8') && publicAddress('2606:4700:4700::1111'));
  assert.equal(mediaExtension(Buffer.from('GIF89a....')), 'gif');
  assert.throws(() => mediaExtension(Buffer.from('<html>not a GIF</html>')));
});

test('a model cannot send project metadata to an invented download destination', async () => {
  const command = {
    type: 'downloadAsset',
    category: 'global',
    group: '',
    variant: 'Picture',
    start: 0,
    track: 1,
    url: 'https://example.com/unrequested.png?film=private',
  };
  await assert.rejects(
    materialize([command], { project, message: 'Add a heart sticker', history: [] }),
    /user-provided HTTPS/i,
  );
});

test('custom sticker outlines follow the model-designed vertices', () => {
  const layer = {
    shape: 'polygon',
    x: 0.5,
    y: 0.5,
    width: 0.8,
    height: 0.7,
    color: '#ff9563',
    motion: 'wobble',
    rotation: 0,
    phase: 0,
  };
  const draw = (vertices) =>
    stickerGif({ seconds: 0.5, layers: [{ ...layer, points: vertices.map(([x, y]) => ({ x, y })) }] });
  const first = draw([
    [-0.9, -0.7],
    [0, -0.93],
    [0.65, -0.2],
    [0.9, 0.8],
    [0, 0.54],
    [-0.6, 0.67],
  ]);
  const second = draw([
    [-0.9, -0.7],
    [0, -0.93],
    [0.15, -0.2],
    [0.3, 0.8],
    [0, 0.54],
    [-0.6, 0.67],
  ]);
  assert.notDeepEqual(first, second);
  assert.throws(() =>
    draw([
      [0.2, 0.2],
      [0.8, 0.6],
    ]),
  );
});
