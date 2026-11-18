// Rebuild the original stock library with the same renderer available to the assistant.
const fs = require('node:fs/promises');
const path = require('node:path');
const { stickerGif } = require('../app/synthesis.cjs');
const destination = path.join(__dirname, '..', 'assets', 'library', 'sticker');
const palettes = {
  Coral: ['#ff526b', '#ffacc0', '#9d254f'],
  Mint: ['#25d7ac', '#b5f9cd', '#147b76'],
  Violet: ['#9973ff', '#e3c5ff', '#57439f'],
  Gold: ['#ffc245', '#fff0a8', '#af6121'],
};
const ink = '#202035',
  paper = '#fff8e9';
const layer = (shape, x, y, width, height, color, motion = 'still', rotation = 0, phase = 0) => ({
  shape,
  x,
  y,
  width,
  height,
  color,
  motion,
  rotation,
  phase,
});
function outlined(shape, x, y, w, h, color, motion = 'still', angle = 0) {
  return [
    layer(shape, x + 0.014, y + 0.032, w * 1.12, h * 1.12, ink, motion, angle),
    layer(shape, x, y, w * 1.12, h * 1.12, paper, motion, angle),
    layer(shape, x, y, w * 1.035, h * 1.035, ink, motion, angle),
    layer(shape, x, y, w, h, color, motion, angle),
  ];
}
function glint(x, y, size, color = paper, phase = 0.18) {
  return [
    layer('sparkle', x, y, size * 1.17, size * 1.25, ink, 'blink', 5, phase),
    layer('sparkle', x, y, size, size * 1.08, color, 'blink', 5, phase),
  ];
}
const families = {
  'Heart Pop': ([primary, light]) => [
    ...outlined('heart', 0.47, 0.53, 0.65, 0.62, primary, 'pulse', -11),
    layer('circle', 0.32, 0.38, 0.115, 0.046, light, 'float', -34),
    ...glint(0.78, 0.25, 0.21),
    ...glint(0.78, 0.68, 0.1, light, 0.47),
  ],
  'Thumbs Up': ([primary, light, dark]) => [
    ...outlined('thumb', 0.47, 0.52, 0.64, 0.66, primary, 'bounce', -8),
    layer('bar', 0.249, 0.65, 0.08, 0.2, dark, 'bounce', -8),
    layer('circle', 0.246, 0.704, 0.04, 0.04, light, 'bounce'),
    ...glint(0.78, 0.28, 0.18, light),
    ...glint(0.8, 0.53, 0.09),
  ],
  'Hot Flame': ([primary, light, dark]) => [
    ...outlined('flame', 0.48, 0.48, 0.65, 0.79, primary, 'pulse'),
    layer('flame', 0.484, 0.615, 0.35, 0.42, dark, 'pulse', -7),
    layer('flame', 0.48, 0.654, 0.24, 0.29, light, 'pulse', -9),
    ...glint(0.79, 0.4, 0.13, light),
    layer('diamond', 0.21, 0.29, 0.065, 0.1, primary, 'rise', -14, 0.36),
  ],
  'Ringing Bell': ([primary, light, dark]) => [
    layer('circle', 0.5, 0.72, 0.17, 0.14, ink, 'wobble'),
    layer('circle', 0.5, 0.715, 0.12, 0.1, dark, 'wobble'),
    ...outlined('bell', 0.49, 0.51, 0.63, 0.69, primary, 'wobble', -8),
    layer('bar', 0.38, 0.44, 0.041, 0.14, light, 'wobble', 12),
    layer('bar', 0.49, 0.666, 0.48, 0.034, dark, 'wobble', -8),
    layer('bar', 0.19, 0.29, 0.038, 0.13, primary, 'blink', -37, 0.2),
    layer('bar', 0.78, 0.27, 0.035, 0.12, light, 'blink', 41, 0.2),
  ],
  'Chat Bubble': ([primary, light, dark]) => [
    ...outlined('bubble', 0.48, 0.53, 0.7, 0.56, primary, 'bounce', -7),
    ...[0.32, 0.46, 0.6].map((x, i) =>
      layer('circle', x, 0.48 - (i - 1) * 0.014, 0.075, 0.075, dark, 'bounce'),
    ),
    ...glint(0.77, 0.25, 0.17, light),
    ...glint(0.8, 0.68, 0.1),
  ],
  Crown: ([primary, light, dark]) => [
    ...outlined('crown', 0.48, 0.53, 0.69, 0.56, primary, 'bounce', -7),
    layer('bar', 0.49, 0.665, 0.45, 0.045, dark, 'bounce', -7),
    layer('diamond', 0.47, 0.5, 0.1, 0.14, light, 'bounce', -7),
    ...glint(0.79, 0.27, 0.16),
    ...glint(0.21, 0.22, 0.105, light, 0.65),
  ],
  'Sparkle Burst': ([primary, light, dark]) => [
    ...outlined('sparkle', 0.49, 0.54, 0.66, 0.68, primary, 'pulse', 13),
    layer('sparkle', 0.49, 0.54, 0.27, 0.33, light, 'pulse', 13),
    ...outlined('star', 0.74, 0.26, 0.2, 0.2, dark, 'wobble', 16),
    ...glint(0.22, 0.28, 0.12, light),
    ...glint(0.75, 0.76, 0.11),
  ],
  'Play Button': ([primary, light, dark]) => [
    ...outlined('circle', 0.49, 0.52, 0.66, 0.66, primary, 'pulse'),
    layer('circle', 0.49, 0.52, 0.53, 0.53, dark, 'pulse'),
    layer('circle', 0.49, 0.5, 0.5, 0.5, primary, 'pulse'),
    layer('play', 0.505, 0.526, 0.31, 0.34, dark, 'pulse'),
    layer('play', 0.51, 0.505, 0.29, 0.315, paper, 'pulse'),
    ...glint(0.77, 0.25, 0.16, light),
    ...glint(0.2, 0.7, 0.12, light),
  ],
  'Check Mark': ([primary, light, dark]) => [
    ...outlined('burst', 0.49, 0.52, 0.63, 0.64, primary, 'wobble'),
    layer('circle', 0.49, 0.52, 0.47, 0.47, dark, 'pulse'),
    layer('circle', 0.49, 0.509, 0.45, 0.45, primary, 'pulse'),
    layer('check', 0.5, 0.535, 0.34, 0.3, ink, 'pulse'),
    layer('check', 0.5, 0.513, 0.34, 0.3, paper, 'pulse'),
    ...glint(0.77, 0.26, 0.16, light),
    ...glint(0.18, 0.68, 0.1),
  ],
  Confetti: ([primary, light, dark]) => [
    ...outlined('triangle', 0.38, 0.65, 0.34, 0.52, primary, 'wobble', -135),
    layer('bar', 0.375, 0.64, 0.19, 0.048, dark, 'wobble', -40),
    layer('circle', 0.5, 0.53, 0.21, 0.09, ink, 'wobble', 44),
    layer('circle', 0.5, 0.526, 0.16, 0.055, light, 'wobble', 44),
    ...glint(0.68, 0.29, 0.22, light),
    ...glint(0.78, 0.53, 0.13),
    layer('bar', 0.53, 0.28, 0.048, 0.115, primary, 'rise', -26, 0.1),
    layer('bar', 0.74, 0.4, 0.045, 0.09, dark, 'twirl', 33, 0.2),
    layer('circle', 0.42, 0.32, 0.066, 0.066, light, 'float'),
    layer('circle', 0.67, 0.57, 0.06, 0.06, primary, 'orbit', 0, 0.2),
  ],
};
async function main() {
  for (const [group, design] of Object.entries(families)) {
    const folder = path.join(destination, group);
    await fs.mkdir(folder, { recursive: true });
    for (const [variant, colors] of Object.entries(palettes)) {
      const bytes = stickerGif({ seconds: 1.5, layers: design(colors) });
      await fs.writeFile(path.join(folder, variant + '.gif'), bytes);
    }
  }
  console.log(
    Object.keys(families).length + ' families, ' + Object.keys(palettes).length + ' variants each',
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
