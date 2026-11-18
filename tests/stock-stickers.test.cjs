const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { getBinaries } = require('../app/engine.cjs');

const run = promisify(execFile);
const root = path.join(__dirname, '../assets/library/sticker');
const originalFamilies = [
  'Clean Circle', 'Curved Arrow Bold', 'Curved Arrow Thin', 'Double Circle', 'Double Underline',
  'Single Underline', 'Sketched Circle', 'Straight Arrow Bold', 'Straight Arrow Thin',
];
const variants = ['Coral.gif', 'Gold.gif', 'Ink.gif', 'Mint.gif', 'Violet.gif', 'White.gif'];
// Four actual ink locations per original, in pen order: tail, mid-shaft, end of shaft, head wing.
const arrowLandmarks = {
  'Straight Arrow Thin': [[23, 66], [215, 66], [420, 66], [369, 24]],
  'Straight Arrow Bold': [[24, 74], [180, 74], [322, 74], [338, 30]],
  'Curved Arrow Thin': [[25, 179], [198, 41], [383, 128], [386, 86]],
  'Curved Arrow Bold': [[25, 57], [177, 194], [352, 103], [321, 92]],
};
const drawOns = Object.keys(arrowLandmarks).map((family) => 'Draw-On ' + family);
const families = [...originalFamilies, ...drawOns].sort();

test('all 54 stickers shipped in v1.0.2 keep their exact original bytes', async () => {
  const digest = createHash('sha256');
  for (const family of originalFamilies) {
    for (const variant of variants) {
      const file = family + '/' + variant;
      digest.update(file).update('\0').update(await fs.readFile(path.join(root, file)));
    }
  }
  assert.equal(digest.digest('hex'), 'd8dac524872a4e256da049f0fc28d8f48162dfabcff9e5b85f580bc0bf504f67');
});

test('the bundled library offers only annotation families, each with six distinct color variants', async () => {
  assert.deepEqual((await fs.readdir(root)).sort(), families);
  for (const family of families) {
    const folder = path.join(root, family);
    const names = (await fs.readdir(folder)).sort();
    assert.deepEqual(names, variants);
    const palettes = new Set();
    for (const name of names) {
      const bytes = await fs.readFile(path.join(folder, name));
      assert.equal(bytes.toString('ascii', 0, 6), 'GIF89a');
      assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0\x03\x01\x00\x00')), `${family}/${name} must loop`);
      const colors = 2 << (bytes[10] & 7);
      palettes.add(bytes.subarray(13, 13 + 3 * colors).toString('hex'));
    }
    assert.equal(palettes.size, names.length, `${family} variants have distinct palettes`);
  }
});

test('stock annotations move over transparent footage and retain their distinguishing strokes', async () => {
  const { ffmpeg } = await getBinaries();
  const size = 96;
  const area = size * size;
  const coverage = {};
  for (const family of originalFamilies) {
    const file = path.join(root, family, 'Coral.gif');
    const { stdout } = await run(ffmpeg, [
      '-v', 'error', '-i', file, '-vf', `scale=${size}:${size}:flags=neighbor,format=rgba,alphaextract`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { encoding: 'buffer', windowsHide: true, maxBuffer: 4_000_000 });
    const frames = new Set();
    const first = stdout.subarray(0, area);
    coverage[family] = first.reduce((count, alpha) => count + Number(alpha > 127), 0);
    assert.ok(coverage[family] > 50, `${family} has a visible first frame`);
    for (let i = 0; i < stdout.length; i += area) {
      const mask = stdout.subarray(i, i + area);
      frames.add(createHash('sha256').update(mask).digest('hex'));
      for (const corner of [0, size - 1, area - size, area - 1]) assert.equal(mask[corner], 0, family);
      if (family.includes('Circle')) assert.equal(mask[area / 2 + size / 2], 0, `${family} center`);
    }
    assert.ok(frames.size >= 10, `${family} should move visibly`);
    if (family.includes('Underline')) {
      let strokes = 0;
      for (let y = 1; y < size; y++) {
        const offset = y * size + size / 2;
        if (first[offset] && !first[offset - size]) strokes++;
      }
      assert.equal(strokes, family === 'Double Underline' ? 2 : 1, family);
    }
  }
  for (const form of ['Straight', 'Curved'])
    assert.ok(coverage[`${form} Arrow Bold`] > 2 * coverage[`${form} Arrow Thin`], `${form} line weights`);
});

async function rawFrames(file, filters, pixelFormat, ...selection) {
  const { ffmpeg } = await getBinaries();
  const { stdout } = await run(ffmpeg, [
    '-v', 'error', '-ignore_loop', '1', '-i', file, ...selection, '-vf', filters,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', pixelFormat, 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true, maxBuffer: 12_000_000 });
  return stdout;
}

test('every held draw-on arrow exactly matches the original stationary shape in its chosen color', async () => {
  for (const family of Object.keys(arrowLandmarks)) {
    for (const variant of variants) {
      const original = path.join(root, family, variant);
      const drawn = path.join(root, 'Draw-On ' + family, variant);
      const expected = await rawFrames(original, 'format=rgba', 'rgba', '-frames:v', '1');
      // Sample the displayed frame at 1.6 s, inside the long GIF delay of the hold.
      const held = await rawFrames(drawn, 'fps=25,select=eq(n\\,40),format=rgba', 'rgba', '-frames:v', '1');
      assert.ok(held.equals(expected), family + '/' + variant + ' fully drawn');
    }
  }
});

test('draw-on arrows write the tail, curved or straight shaft, and head in sequence before holding and looping', async () => {
  for (const [family, landmarks] of Object.entries(arrowLandmarks)) {
    const original = path.join(root, family, 'Coral.gif');
    const drawing = path.join(root, 'Draw-On ' + family, 'Coral.gif');
    const width = (await fs.readFile(original)).readUInt16LE(6);
    const complete = await rawFrames(original, 'format=rgba,alphaextract', 'gray', '-frames:v', '1');
    const animated = await rawFrames(drawing, 'fps=25,format=rgba,alphaextract', 'gray');
    const samples = Array.from({ length: animated.length / complete.length }, (_, i) =>
      animated.subarray(i * complete.length, (i + 1) * complete.length));
    const countInk = (mask) => mask.reduce((count, alpha) => count + Number(alpha !== 0), 0);
    const firstInk = countInk(samples[0]), finalInk = countInk(complete);
    assert.ok(firstInk > 0 && firstInk < finalInk * 0.05, family + ' starts at the pen tip');
    assert.ok(countInk(samples[4]) > firstInk * 1.5, family + ' begins drawing immediately');
    const arrivals = landmarks.map(([x, y]) => samples.findIndex((mask) => mask[y * width + x] > 0));
    assert.equal(arrivals[0], 0, family + ' tail');
    assert.ok(arrivals.every((arrival, i) => !i || arrival > arrivals[i - 1]), family + ' pen order');
    const hold = samples.findIndex((mask) => mask.equals(complete));
    assert.ok(hold > 12 && hold < samples.length - 10, family + ' drawing time');
    assert.ok(samples.slice(hold, hold + 9).every((mask) => mask.equals(complete)), family + ' holds still');
    assert.ok(samples.at(-1).equals(samples[0]), family + ' seamless pen reset');
    for (let frame = 0; frame <= hold; frame++) {
      const now = samples[frame], previous = samples[Math.max(0, frame - 1)];
      for (let i = 0; i < now.length; i++) {
        if ((now[i] && !complete[i]) || (previous[i] && !now[i]))
          assert.fail(family + ' shifted or erased earlier ink while drawing frame ' + frame);
      }
    }
  }
});
