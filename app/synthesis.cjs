const { GIFEncoder } = require('gifenc');

const TAU = Math.PI * 2;
const SIZE = 224;
const motions = ['still', 'pulse', 'bounce', 'twirl', 'wobble', 'blink', 'float', 'rise', 'orbit', 'pop'];
const waves = ['sine', 'triangle', 'square', 'saw', 'noise'];
const radial = (count, inner = 1, outer = 1) =>
  Array.from({ length: count }, (_, i) => {
    const t = (TAU * i) / count - Math.PI / 2;
    const r = i % 2 ? inner : outer;
    return [Math.cos(t) * r, Math.sin(t) * r];
  });
const curve = (count, fn) => Array.from({ length: count }, (_, i) => fn((i * TAU) / count));
const shapes = {
  circle: radial(60),
  ring: radial(60),
  diamond: radial(4),
  triangle: radial(3),
  bar: [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ],
  star: radial(10, 0.46),
  burst: radial(28, 0.74),
  sparkle: [
    [0, -1],
    [0.13, -0.35],
    [0.28, -0.16],
    [1, 0],
    [0.32, 0.12],
    [0.14, 0.3],
    [0, 1],
    [-0.13, 0.32],
    [-0.32, 0.14],
    [-1, 0],
    [-0.3, -0.14],
    [-0.14, -0.32],
  ],
  heart: curve(96, (t) => [
    Math.sin(t) ** 3,
    -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 2) / 15.5,
  ]),
  bolt: [
    [0.15, -1],
    [-0.86, 0.17],
    [-0.13, 0.15],
    [-0.36, 1],
    [0.9, -0.3],
    [0.16, -0.25],
  ],
  check: [
    [-0.99, 0.01],
    [-0.68, -0.29],
    [-0.22, 0.17],
    [0.68, -0.83],
    [0.99, -0.53],
    [-0.21, 0.82],
  ],
  play: [
    [-0.67, -1],
    [0.95, -0.1],
    [1, 0],
    [0.92, 0.11],
    [-0.67, 1],
    [-0.79, 0.95],
    [-0.79, -0.94],
  ],
  bubble: [
    [-0.66, -0.82],
    [0.65, -0.82],
    [0.84, -0.76],
    [0.98, -0.57],
    [1, 0.35],
    [0.91, 0.57],
    [0.71, 0.7],
    [0.1, 0.7],
    [-0.52, 1],
    [-0.47, 0.69],
    [-0.73, 0.68],
    [-0.94, 0.53],
    [-1, 0.35],
    [-1, -0.48],
    [-0.91, -0.68],
  ],
  crown: [
    [-1, -0.57],
    [-0.49, -0.14],
    [0, -0.93],
    [0.49, -0.14],
    [1, -0.57],
    [0.77, 0.72],
    [0.67, 0.85],
    [-0.67, 0.85],
    [-0.77, 0.72],
  ],
  flame: [
    [-0.82, 0.4],
    [-0.86, 0.02],
    [-0.67, -0.38],
    [-0.63, -0.08],
    [-0.34, -0.32],
    [-0.15, -0.65],
    [-0.16, -1],
    [0.17, -0.79],
    [0.41, -0.47],
    [0.48, -0.18],
    [0.66, -0.46],
    [0.84, -0.05],
    [0.86, 0.33],
    [0.72, 0.64],
    [0.45, 0.87],
    [0.13, 0.98],
    [-0.23, 0.96],
    [-0.58, 0.78],
  ],
  bell: [
    [-0.95, 0.56],
    [-0.68, 0.21],
    [-0.61, -0.28],
    [-0.52, -0.56],
    [-0.32, -0.75],
    [-0.13, -0.81],
    [-0.12, -0.95],
    [0.12, -0.95],
    [0.15, -0.81],
    [0.36, -0.73],
    [0.54, -0.54],
    [0.63, -0.24],
    [0.69, 0.22],
    [0.95, 0.56],
    [0.95, 0.67],
    [-0.95, 0.67],
  ],
  thumb: [
    [-0.92, -0.04],
    [-0.53, -0.04],
    [-0.51, 0.91],
    [-0.91, 0.91],
    [-0.96, 0.83],
    [-0.96, 0.08],
    [-0.92, -0.04],
    [-0.42, 0.02],
    [-0.12, -0.32],
    [0.02, -0.62],
    [0.06, -0.94],
    [0.19, -1],
    [0.32, -0.91],
    [0.38, -0.68],
    [0.31, -0.26],
    [0.76, -0.26],
    [0.94, -0.15],
    [0.95, 0.02],
    [0.79, 0.72],
    [0.65, 0.91],
    [-0.14, 0.91],
    [-0.42, 0.79],
    [-0.42, 0.02],
  ],
};
const shapeNames = [...Object.keys(shapes), 'polygon'];

function number(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error('Invalid ' + name + ' (' + min + '–' + max + ')');
  }
  return value;
}
function member(value, list, name) {
  if (!list.includes(value)) throw new Error('Invalid ' + name);
  return value;
}

function pose(layer, progress) {
  const t = (progress + layer.phase) * TAU;
  const wave = Math.sin(t);
  let { x, y, rotation } = layer;
  let scale = 1;
  switch (layer.motion) {
    case 'pulse':
      scale = 0.92 + 0.12 * Math.cos(t);
      break;
    case 'bounce':
      y -= (0.085 * (1 - Math.cos(t))) / 2;
      break;
    case 'twirl':
      rotation += 360 * (progress + layer.phase);
      break;
    case 'wobble':
      rotation += 13 * wave;
      break;
    case 'blink':
      scale = 0.62 + 0.38 * Math.cos(t);
      break;
    case 'float':
      y += 0.032 * wave;
      rotation += 5 * Math.cos(t);
      break;
    case 'rise':
      y -= 0.16 * wave;
      scale = 0.88 + 0.1 * Math.cos(t);
      break;
    case 'orbit':
      x += 0.06 * Math.cos(t);
      y += 0.06 * wave;
      break;
    case 'pop':
      scale = 0.86 + 0.18 * Math.cos(t) + 0.05 * Math.sin(2 * t);
      break;
  }
  const angle = (rotation * Math.PI) / 180;
  return {
    x: x * SIZE,
    y: y * SIZE,
    w: (layer.width * scale * SIZE) / 2,
    h: (layer.height * scale * SIZE) / 2,
    c: Math.cos(angle),
    s: Math.sin(angle),
  };
}

// Even-odd scan conversion preserves the inside of rings and other compound polygons.
function paint(pixels, contours, p, ink) {
  const paths = contours.map((contour) =>
    contour.map(([x, y]) => [p.x + x * p.w * p.c - y * p.h * p.s, p.y + x * p.w * p.s + y * p.h * p.c]),
  );
  const ys = paths.flat().map((point) => point[1]);
  const low = Math.max(0, Math.ceil(Math.min(...ys) - 0.5));
  const high = Math.min(SIZE, Math.ceil(Math.max(...ys) - 0.5));
  for (let row = low; row < high; row++) {
    const line = row + 0.5;
    const cuts = [];
    for (const path of paths) {
      let prev = path.at(-1);
      for (const next of path) {
        if (prev[1] > line !== next[1] > line) {
          cuts.push(prev[0] + ((line - prev[1]) * (next[0] - prev[0])) / (next[1] - prev[1]));
        }
        prev = next;
      }
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i += 2) {
      const from = Math.max(0, Math.ceil(cuts[i - 1] - 0.5));
      const to = Math.min(SIZE, Math.ceil(cuts[i] - 0.5));
      if (to > from) pixels.fill(ink, row * SIZE + from, row * SIZE + to);
    }
  }
}

function stickerGif({ seconds, layers }) {
  number(seconds, 0.25, 5, 'loop duration');
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > 24)
    throw new Error('Use 1–24 graphic layers');
  const palette = [[0, 0, 0]];
  const colors = new Map();
  const drawing = layers.map((layer) => {
    member(layer.shape, shapeNames, 'shape');
    member(layer.motion, motions, 'motion');
    for (const key of ['x', 'y', 'phase']) number(layer[key], 0, 1, key);
    for (const key of ['width', 'height']) number(layer[key], 0.01, 2, key);
    number(layer.rotation, -1080, 1080, 'rotation');
    if (!/^#[0-9a-f]{6}$/i.test(layer.color)) throw new Error('Invalid sticker color');
    const color = layer.color.toLowerCase();
    if (!colors.has(color)) {
      colors.set(color, palette.length);
      palette.push(
        color
          .slice(1)
          .match(/../g)
          .map((v) => parseInt(v, 16)),
      );
    }
    let outline = shapes[layer.shape];
    if (layer.shape === 'polygon') {
      if (!Array.isArray(layer.points) || layer.points.length < 3 || layer.points.length > 64)
        throw new Error('Use 3–64 outline vertices');
      outline = layer.points.map((point) => [
        number(point.x, -1, 1, 'vertex x'),
        number(point.y, -1, 1, 'vertex y'),
      ]);
    }
    const contours = [outline];
    if (layer.shape === 'ring') contours.push(radial(60, 0.73, 0.73));
    return { layer, contours, ink: colors.get(color) };
  });
  const frames = Math.max(4, Math.round(seconds * 16));
  const gif = GIFEncoder();
  for (let frame = 0; frame < frames; frame++) {
    const pixels = new Uint8Array(SIZE * SIZE);
    for (const { layer, contours, ink } of drawing)
      paint(pixels, contours, pose(layer, frame / frames), ink);
    const delay =
      10 *
      (Math.round(((frame + 1) * seconds * 100) / frames) - Math.round((frame * seconds * 100) / frames));
    gif.writeFrame(pixels, SIZE, SIZE, {
      palette: frame === 0 ? palette : undefined,
      transparent: true,
      transparentIndex: 0,
      repeat: 0,
      dispose: 2,
      delay,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

function soundWav(voices) {
  if (!Array.isArray(voices) || voices.length < 1 || voices.length > 24)
    throw new Error('Use 1–24 sound voices');
  const rate = 44100;
  let seconds = 0;
  for (const v of voices) {
    member(v.wave, waves, 'wave');
    number(v.start, 0, 10, 'voice start');
    number(v.duration, 0.01, 10, 'voice duration');
    for (const field of ['fromHz', 'toHz']) number(v[field], 20, 18000, 'frequency');
    number(v.volume, 0, 1, 'voice level');
    number(v.attack, 0, 10, 'attack');
    number(v.release, 0, 10, 'release');
    seconds = Math.max(seconds, v.start + v.duration);
  }
  const mix = new Float32Array(Math.ceil(rate * seconds));
  let seed = 71845;
  for (const v of voices) {
    let phase = 0,
      filtered = 0;
    const offset = Math.round(v.start * rate);
    const length = Math.min(Math.round(v.duration * rate), mix.length - offset);
    const frequencyStep = (v.toHz / v.fromHz) ** (1 / length);
    let freq = v.fromHz;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      phase = (phase + freq / rate) % 1;
      let sample;
      switch (v.wave) {
        case 'triangle':
          sample = 1 - 4 * Math.abs(phase - 0.5);
          break;
        case 'square':
          sample = Math.tanh(5 * Math.sin(TAU * phase));
          break;
        case 'saw':
          sample = phase * 2 - 1;
          break;
        case 'noise':
          seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
          filtered += (1 - Math.exp((-TAU * freq) / rate)) * (seed / 2147483648 - 1 - filtered);
          sample = filtered;
          break;
        default:
          sample = Math.sin(TAU * phase);
      }
      const envelope = Math.min(
        1,
        t / Math.max(0.002, v.attack),
        (v.duration - t) / Math.max(0.003, v.release),
      );
      mix[offset + i] += sample * Math.max(0, envelope) * v.volume;
      freq *= frequencyStep;
    }
  }
  let peak = 1;
  for (const value of mix) peak = Math.max(peak, Math.abs(value));
  const wav = Buffer.alloc(44 + 2 * mix.length);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(mix.length * 2, 40);
  for (let i = 0; i < mix.length; i++) wav.writeInt16LE(Math.round((mix[i] / peak) * 30300), 44 + 2 * i);
  return wav;
}

module.exports = { stickerGif, soundWav, motions, waves, shapeNames, number, member };
