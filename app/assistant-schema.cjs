const { shapeNames, motions, waves } = require('./synthesis.cjs');
const str = { type: 'string' },
  num = { type: 'number' },
  bool = { type: 'boolean' };
const one = (values) => ({ type: 'string', enum: values });
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const list = (items) => ({ type: 'array', items });
const ref = (name) => ({ $ref: '#/$defs/' + name });
const nullable = (value) => ({ anyOf: [value, { type: 'null' }] });
const optionalFields = (properties) =>
  Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, nullable(value)]));
const style = {
  font: str,
  size: num,
  color: str,
  stroke: str,
  strokeWidth: num,
  background: str,
  bold: bool,
  italic: bool,
};
const placement = { start: num, track: { type: 'integer' } };
const category = one(['global', 'audiofx', 'visualfx', 'sticker']);
const graphicCategory = one(['sticker', 'visualfx']);
const group = { group: str, variant: str };
const cmd = (name, properties) => object({ type: one([name]), ...properties });
module.exports = {
  ...object({
    reply: str,
    actions: list({
      anyOf: [
        cmd('update', { id: str, patch: ref('patch') }),
        cmd('remove', { id: str }),
        cmd('split', { id: str, time: num }),
        cmd('compound', { ids: list(str) }),
        cmd('addText', {
          text: str,
          ...placement,
          duration: num,
          box: nullable(ref('box')),
          style: nullable(ref('style')),
        }),
        cmd('useAsset', { assetId: str, ...placement }),
        cmd('generateSticker', {
          category: graphicCategory,
          ...group,
          seconds: num,
          layers: list(ref('layer')),
          ...placement,
        }),
        cmd('generateSound', { name: str, voices: list(ref('voice')), ...placement }),
        cmd('downloadAsset', { url: str, category, ...group, ...placement }),
        cmd('findAsset', { query: str, category, ...group, ...placement }),
      ],
    }),
  }),
  $defs: {
    box: object({ x: num, y: num, w: num, h: num }),
    style: object(optionalFields(style)),
    patch: object(
      optionalFields({
        name: str,
        start: num,
        in: num,
        duration: num,
        track: { type: 'integer' },
        box: ref('box'),
        crop: ref('box'),
        volume: num,
        muted: bool,
        text: str,
        style: ref('style'),
      }),
    ),
    layer: object({
      shape: one(shapeNames),
      points: nullable(list(object({ x: num, y: num }))),
      x: num,
      y: num,
      width: num,
      height: num,
      color: str,
      rotation: num,
      motion: one(motions),
      phase: num,
    }),
    voice: object({
      wave: one(waves),
      start: num,
      duration: num,
      fromHz: num,
      toHz: num,
      volume: num,
      attack: num,
      release: num,
    }),
  },
};
