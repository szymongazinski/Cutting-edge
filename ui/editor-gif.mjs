// GIF delays precede their associated image descriptors. Reading the timing
// table once lets ImageDecoder seek even when original GIFs have unequal delays.
function frameEnds(data) {
  const view = new Uint8Array(data);
  const ends = [];
  let i = 13,
    delay = 0.1,
    end = 0;
  if (view[10] & 128) i += 3 * (2 << (view[10] & 7));
  function skipBlocks() {
    while (i < view.length) {
      const size = view[i++];
      if (!size) return;
      i += size;
    }
  }
  while (i < view.length) {
    const token = view[i++];
    if (token === 0x21) {
      const code = view[i++];
      if (code === 0xf9 && view[i] === 4) {
        const cs = view[i + 2] | (view[i + 3] << 8);
        delay = cs > 1 ? cs / 100 : 0.1;
      }
      skipBlocks();
    } else if (token === 0x2c) {
      const packed = view[i + 8];
      i += 9;
      if (packed & 128) i += 3 * (2 << (packed & 7));
      i++;
      skipBlocks();
      end += delay;
      ends.push(end);
      delay = 0.1;
    } else break;
  }
  return ends;
}

export function gifPlayer(canvas, url, fail) {
  let decoder,
    ends,
    disposed = false,
    decoding = false,
    shown = -1,
    target = 0;
  const aborter = new AbortController();
  const ctx = canvas.getContext('2d', { alpha: true });
  async function draw() {
    if (!decoder || !ends || disposed || decoding) return;
    let lo = 0,
      hi = ends.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (target < ends[mid]) hi = mid;
      else lo = mid + 1;
    }
    if (lo === shown) return;
    decoding = true;
    try {
      const { image } = await decoder.decode({ frameIndex: lo });
      if (!disposed) {
        if (canvas.width !== image.displayWidth) canvas.width = image.displayWidth;
        if (canvas.height !== image.displayHeight) canvas.height = image.displayHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0);
        shown = lo;
      }
      image.close();
    } catch {
      if (!disposed) {
        fail();
        return;
      }
    } finally {
      decoding = false;
    }
    if (!disposed) void draw();
  }
  (async () => {
    const res = await fetch(url, { signal: aborter.signal });
    if (!res.ok) throw Error('GIF');
    const bytes = await res.arrayBuffer();
    if (disposed) return;
    ends = frameEnds(bytes);
    if (!ends.length || !globalThis.ImageDecoder) throw Error('GIF');
    decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await decoder.tracks.ready;
    await draw();
  })().catch(() => {
    if (!disposed) fail();
  });
  return {
    seek(time) {
      target = time;
      void draw();
    },
    destroy() {
      disposed = true;
      aborter.abort();
      decoder?.close();
    },
  };
}
