const { number, between } = require('./media-timeline.cjs');

function assTime(seconds) {
  const units = Math.round(Math.max(0, seconds) * 100);
  return (
    Math.floor(units / 360000) +
    ':' +
    String(Math.floor(units / 6000) % 60).padStart(2, '0') +
    ':' +
    String(Math.floor(units / 100) % 60).padStart(2, '0') +
    '.' +
    String(units % 100).padStart(2, '0')
  );
}
function color(css, fallback) {
  const hex = /^#[0-9a-f]{6}$/i.test(css || '') ? css : fallback;
  return '&H00' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);
}
function literal(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\u2060')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

function captionsFile(leaf, width, height, projectHeight) {
  const { clip, sourceTime, duration } = leaf;
  const style = clip.style || {};
  const font = String(style.font || 'Arial')
    .replace(/[,\n\r\x00-\x1f]/g, ' ')
    .slice(0, 120);
  const size = between(number(style.size, projectHeight * 0.05), 1, 8192);
  const outline = between(number(style.strokeWidth, 2), 0, 512);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    'PlayResX: ' + width,
    'PlayResY: ' + height,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Caption',
      font,
      size,
      color(style.color, '#ffffff'),
      '&H00000000',
      color(style.stroke, '#000000'),
      '&H00000000',
      style.bold ? -1 : 0,
      style.italic ? -1 : 0,
      0,
      0,
      100,
      100,
      0,
      0,
      1,
      outline,
      0,
      5,
      0,
      0,
      0,
      1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const cues =
    clip.kind === 'text'
      ? [{ start: sourceTime, end: sourceTime + duration, text: clip.text }]
      : clip.cues || [];
  for (const cue of cues) {
    const start = assTime(Math.max(0, number(cue.start) - sourceTime));
    const endOffset = Math.min(duration, number(cue.end) - sourceTime);
    if (endOffset <= 0 || number(cue.start) >= sourceTime + duration || !String(cue.text || '').trim())
      continue;
    const end = assTime(endOffset);
    if (start === end) continue;
    const timing = ',' + start + ',' + end + ',Caption,,0,0,0,,';
    if (/^#[0-9a-f]{6}$/i.test(style.background || '')) {
      const fill = color(style.background, '#000000').replace('&H00', '&H');
      lines.push(
        'Dialogue: 0' +
          timing +
          '{\\an7\\pos(0,0)\\bord0\\shad0\\1c' +
          fill +
          '&\\p1}m 0 0 l ' +
          width +
          ' 0 ' +
          width +
          ' ' +
          height +
          ' 0 ' +
          height +
          ' 0 0{\\p0}',
      );
    }
    lines.push('Dialogue: 1' + timing + literal(cue.text));
  }
  return lines.join('\n') + '\n';
}

module.exports = { captionsFile };
