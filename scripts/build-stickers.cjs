// Generate the stock annotation GIFs offline. Coordinates and nib widths are in output pixels.
const fs = require('node:fs/promises');
const path = require('node:path');
const { GIFEncoder } = require('gifenc');

const destination = path.join(__dirname, '..', 'assets', 'library', 'sticker');
const colors = {
  Coral: ['#ff6159', '#994149'],
  Gold: ['#ffd249', '#936821'],
  Ink: ['#252732', '#9296a2'],
  Mint: ['#36deb1', '#27796d'],
  Violet: ['#ae91ff', '#68509e'],
  White: ['#fffdf8', '#898899'],
};
const clamp = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

// Each group of six coordinates is one cubic Bézier from the previous endpoint.
function curve(start, ...sections) {
  const points = [start];
  for (const [ax, ay, bx, by, x, y] of sections) {
    const [sx, sy] = points.at(-1);
    for (let i = 1; i <= 48; i++) {
      const t = i / 48, u = 1 - t;
      points.push([
        u ** 3 * sx + 3 * u * u * t * ax + 3 * u * t * t * bx + t ** 3 * x,
        u ** 3 * sy + 3 * u * u * t * ay + 3 * u * t * t * by + t ** 3 * y,
      ]);
    }
  }
  return points;
}

function ellipse(cx, cy, rx, ry, tilt, start) {
  const angle = tilt * Math.PI / 180;
  return Array.from({ length: 181 }, (_, i) => {
    const a = start + 2 * Math.PI * i / 180;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    return [cx + x * Math.cos(angle) - y * Math.sin(angle), cy + x * Math.sin(angle) + y * Math.cos(angle)];
  });
}

// Width follows the pen's distance along the line, including changes in pressure.
function stroke(points, width) {
  let length = 0;
  const distances = points.map(([x, y], i) => {
    if (i) length += Math.hypot(x - points[i - 1][0], y - points[i - 1][1]);
    return length;
  });
  return {
    length,
    points: points.map(([x, y], i) => ({
      x, y, distance: distances[i],
      radius: (typeof width === 'number' ? width : width(distances[i] / length)) / 2,
    })),
  };
}

function roundedPolygon(corners) {
  const points = [];
  for (let i = 0; i < corners.length; i++) {
    const [x, y, radius] = corners[i];
    const tangent = ([tx, ty]) => {
      const distance = Math.hypot(tx - x, ty - y);
      return [x + radius * (tx - x) / distance, y + radius * (ty - y) / distance];
    };
    const before = tangent(corners[(i + corners.length - 1) % corners.length]);
    const after = tangent(corners[(i + 1) % corners.length]);
    for (let step = 0; step <= 6; step++) {
      const t = step / 6, u = 1 - t;
      points.push([u * u * before[0] + 2 * u * t * x + t * t * after[0],
        u * u * before[1] + 2 * u * t * y + t * t * after[1]]);
    }
  }
  return points;
}

const brush = (width) => (t) => width * (0.2 + 0.8 * Math.sin(Math.PI * t) ** 0.6);
const families = {
  'Straight Arrow Thin': {
    size: [480, 132], nudge: [23, 0],
    strokes: [
      stroke([[23, 66], [429, 66]], 7),
      stroke([[368, 23], [430, 66], [368, 109]], 7.5),
    ],
  },
  'Straight Arrow Bold': {
    size: [480, 148], nudge: [23, 0],
    fill: roundedPolygon([
      [22, 60, 12], [329, 60, 4], [329, 19, 6], [435, 74, 7],
      [329, 129, 6], [329, 88, 4], [22, 88, 12],
    ]),
  },
  'Curved Arrow Thin': {
    size: [448, 216], nudge: [13, 16],
    strokes: [
      stroke(curve([25, 179], [87, 168, 91, 55, 198, 41], [290, 27, 342, 64, 393, 143]),
        (t) => 5.2 + 3.2 * Math.sin(t * Math.PI * 0.8)),
      stroke(curve([386, 85], [388, 104, 388, 125, 393, 143],
        [376, 138, 353, 133, 339, 129]), (t) => 6.5 + 1.2 * Math.sin(Math.PI * t)),
    ],
  },
  'Curved Arrow Bold': {
    size: [448, 244], nudge: [13, -18],
    strokes: [
      stroke(curve([25, 57], [62, 131, 100, 191, 177, 194], [256, 198, 315, 159, 366, 83]),
        (t) => 8 + 20 * Math.sin(t * Math.PI * 0.63) ** 0.8),
    ],
    fill: roundedPolygon([[313, 91, 5], [394, 43, 7], [386, 137, 5]]),
  },
  'Clean Circle': {
    size: [352, 352], circular: true,
    strokes: [stroke(ellipse(176, 176, 149, 149, 0, -Math.PI / 2), 10)],
  },
  'Sketched Circle': {
    size: [468, 288], circular: true,
    strokes: [
      stroke(curve([334, 47],
        [265, 18, 146, 30, 82, 77], [23, 119, 11, 183, 51, 222],
        [98, 267, 209, 269, 309, 239], [398, 213, 453, 160, 438, 108],
        [422, 52, 331, 27, 244, 42], [215, 47, 186, 57, 166, 67]),
      (t) => brush(12)(t) * (1 + 0.2 * Math.sin(3.6 * Math.PI * t + 0.6))),
    ],
  },
  'Double Circle': {
    size: [440, 336], circular: true,
    strokes: [
      stroke(ellipse(220, 168, 194, 137, -7, -0.62), 9),
      stroke(ellipse(220, 168, 175, 120, -7, -0.85), 5.2),
    ],
  },
  'Single Underline': {
    size: [480, 64],
    strokes: [stroke(curve([20, 40], [109, 30, 180, 31, 242, 32], [323, 34, 396, 27, 458, 22]), brush(19))],
  },
  'Double Underline': {
    size: [480, 88],
    strokes: [
      stroke(curve([20, 37], [149, 19, 333, 20, 457, 29]), brush(13.5)),
      stroke(curve([429, 53], [302, 45, 158, 50, 54, 67]), brush(8.5)),
    ],
  },
};

// GIF has one transparent index. A narrow, color-matched rim makes the inner
// edge smooth without matting the silhouette to an assumed video background.
function tone(depth) {
  return depth < 0 ? 0 : 1 + Math.min(5, Math.floor(depth * 3.6));
}

function segment(pixels, width, height, x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1, dy = y2 - y1;
  const length2 = dx * dx + dy * dy;
  const radius = Math.max(r1, r2);
  const left = Math.max(0, Math.floor(Math.min(x1, x2) - radius));
  const right = Math.min(width, Math.ceil(Math.max(x1, x2) + radius));
  const top = Math.max(0, Math.floor(Math.min(y1, y2) - radius));
  const bottom = Math.min(height, Math.ceil(Math.max(y1, y2) + radius));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const px = x + 0.5 - x1, py = y + 0.5 - y1;
      const t = length2 ? clamp((px * dx + py * dy) / length2) : 0;
      const depth = mix(r1, r2, t) - Math.sqrt((px - t * dx) ** 2 + (py - t * dy) ** 2);
      const i = y * width + x;
      pixels[i] = Math.max(pixels[i], tone(depth));
    }
  }
}

function paintStrokes(pixels, design, from = 0, to = 1) {
  const strokes = design.strokes || [];
  const length = strokes.reduce((sum, pen) => sum + pen.length, 0);
  let offset = 0;
  for (const pen of strokes) {
    const start = from * length - offset, end = to * length - offset;
    for (let i = 1; i < pen.points.length; i++) {
      const a = pen.points[i - 1], b = pen.points[i];
      const lo = Math.max(start, a.distance), hi = Math.min(end, b.distance);
      if (hi <= lo) continue;
      const span = b.distance - a.distance;
      const t0 = (lo - a.distance) / span, t1 = (hi - a.distance) / span;
      segment(pixels, ...design.size, mix(a.x, b.x, t0), mix(a.y, b.y, t0), mix(a.radius, b.radius, t0),
        mix(a.x, b.x, t1), mix(a.y, b.y, t1), mix(a.radius, b.radius, t1));
    }
    offset += pen.length;
  }
}

function paintFill(pixels, width, polygon) {
  const xs = polygon.map(([x]) => x), ys = polygon.map(([, y]) => y);
  const left = Math.floor(Math.min(...xs)), right = Math.ceil(Math.max(...xs));
  const top = Math.floor(Math.min(...ys)), bottom = Math.ceil(Math.max(...ys));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const px = x + 0.5, py = y + 0.5;
      let inside = false, distance2 = Infinity;
      let [ax, ay] = polygon.at(-1);
      for (const [bx, by] of polygon) {
        const dx = bx - ax, dy = by - ay;
        if ((ay > py) !== (by > py) && px < ax + dx * (py - ay) / dy) inside = !inside;
        const length2 = dx * dx + dy * dy;
        const t = length2 ? clamp(((px - ax) * dx + (py - ay) * dy) / length2) : 0;
        distance2 = Math.min(distance2, (px - ax - dx * t) ** 2 + (py - ay - dy * t) ** 2);
        ax = bx;
        ay = by;
      }
      if (inside) {
        const i = y * width + x;
        pixels[i] = Math.max(pixels[i], tone(Math.sqrt(distance2)));
      }
    }
  }
}

function arrowFrames(design) {
  const [width, height] = design.size;
  const artwork = new Uint8Array(width * height);
  paintStrokes(artwork, design);
  if (design.fill) paintFill(artwork, width, design.fill);
  // Anticipation, a point towards the subject, then a small recoil and return.
  const keys = [[0, 0], [0.14, -0.16], [0.38, 1], [0.52, 0.76], [0.62, 0.82], [0.88, 0], [1, 0]];
  return Array.from({ length: 42 }, (_, frame) => {
    const t = frame / 42;
    const k = keys.findIndex(([time]) => time > t);
    const [t0, a] = keys[k - 1], [t1, b] = keys[k];
    const amount = mix(a, b, ease((t - t0) / (t1 - t0)));
    const dx = Math.round(design.nudge[0] * amount), dy = Math.round(design.nudge[1] * amount);
    const shifted = new Uint8Array(artwork.length);
    const xStart = Math.max(0, -dx), xEnd = Math.min(width, width - dx);
    for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++)
      shifted.set(artwork.subarray(y * width + xStart, y * width + xEnd), (y + dy) * width + xStart + dx);
    return shifted;
  });
}

function drawnFrames(design) {
  return Array.from({ length: 56 }, (_, frame) => {
    const t = frame / 56;
    const wiped = ease(clamp((t - 0.13) / 0.23));
    const written = ease(clamp((t - 0.36) / 0.43));
    let from = 0, to = written;
    if (t < 0.36) {
      if (design.circular) { from = wiped; to = 1; }
      else to = 1 - wiped;
    }
    const pixels = new Uint8Array(design.size[0] * design.size[1]);
    paintStrokes(pixels, design, from, to);
    return pixels;
  });
}

function timedFrames(design) {
  const frames = design.nudge ? arrowFrames(design) : drawnFrames(design);
  const timed = [];
  for (const pixels of frames) {
    const previous = timed.at(-1);
    const buffer = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (previous && previous.pixels.equals(buffer)) previous.delay += 40;
    else timed.push({ pixels: buffer, delay: 40 });
  }
  return timed;
}

function paletteFor([fill, rim]) {
  const rgb = (hex) => hex.slice(1).match(/../g).map((byte) => parseInt(byte, 16));
  const a = rgb(rim), b = rgb(fill);
  return [[0, 0, 0], ...Array.from({ length: 6 }, (_, step) => a.map((c, i) => Math.round(mix(c, b[i], step / 5))))];
}

async function main() {
  for (const [name, design] of Object.entries(families)) {
    const folder = path.join(destination, name);
    await fs.mkdir(folder, { recursive: true });
    const frames = timedFrames(design);
    for (const [variant, inks] of Object.entries(colors)) {
      const gif = GIFEncoder();
      const palette = paletteFor(inks);
      for (const [i, { pixels, delay }] of frames.entries())
        gif.writeFrame(pixels, ...design.size, {
          palette: i === 0 ? palette : undefined, delay, transparent: true, transparentIndex: 0, repeat: 0, dispose: 2,
        });
      gif.finish();
      await fs.writeFile(path.join(folder, variant + '.gif'), gif.bytes());
    }
  }
  console.log(`${Object.keys(families).length} annotation families × ${Object.keys(colors).length} colors`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
