const dns = require('node:dns/promises');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const forbidden = new net.BlockList();
for (const [ip, mask] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  forbidden.addSubnet(ip, mask, 'ipv4');
const v6Global = new net.BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
for (const [ip, mask] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
]) {
  forbidden.addSubnet(ip, mask, 'ipv6');
}
function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !forbidden.check(address, 'ipv4');
  return family === 6 && v6Global.check(address, 'ipv6') && !forbidden.check(address, 'ipv6');
}

async function resolveBefore(host, deadline) {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  let timeout;
  try {
    return await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('DNS lookup timed out')),
          Math.max(1, deadline - Date.now()),
        );
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
async function readResponse(url, options, remaining = 5) {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    (target.port && target.port !== '443') ||
    (options.allowedHosts && !options.allowedHosts(host))
  )
    throw new Error('Unsupported HTTPS destination');
  const addresses = await resolveBefore(host, options.deadline);
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw new Error('A public internet address is required');
  const route = addresses.find((item) => item.family === 4) || addresses[0];
  const left = options.deadline - Date.now();
  if (left <= 0) throw new Error('Download timed out');
  // Pin the address used by TLS to the checked DNS result, including after redirects.
  const response = await new Promise((resolve, reject) => {
    const request = https.get(
      target,
      {
        agent: false,
        autoSelectFamily: false,
        family: route.family,
        signal: AbortSignal.timeout(left),
        lookup: (_host, opts, cb) =>
          opts.all ? cb(null, [route]) : cb(null, route.address, route.family),
        headers: {
          'User-Agent': 'Cutting-edge-video-editor/1.0 (https://github.com/szymongazinski/Cutting-edge)',
          Accept: options.accept || '*/*',
        },
      },
      resolve,
    );
    request.once('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (!remaining || !response.headers.location) throw new Error('Invalid redirect');
    return readResponse(new URL(response.headers.location, target), options, remaining - 1);
  }
  if (response.statusCode !== 200 || Number(response.headers['content-length']) > options.maxBytes) {
    response.destroy();
    const error = new Error(
      response.statusCode !== 200
        ? 'HTTP ' + response.statusCode + ' (' + host + ')'
        : 'Download is too large',
    );
    error.statusCode = response.statusCode;
    throw error;
  }
  return response;
}

async function downloadPublic(url, { maxBytes, output, allowedHosts, timeoutMs = 45000, accept } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error('A download size limit is required');
  const response = await readResponse(url, {
    maxBytes,
    allowedHosts,
    accept,
    deadline: Date.now() + timeoutMs,
  });
  const pieces = [];
  let size = 0;
  const hash = createHash('sha256');
  const measure = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new Error('Download is too large'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const sink = output
    ? fs.createWriteStream(output, { flags: 'wx' })
    : new Writable({
        write(chunk, enc, cb) {
          pieces.push(chunk);
          cb();
        },
      });
  await pipeline(response, measure, sink);
  if (!size) throw new Error('Empty download');
  return { buffer: output ? undefined : Buffer.concat(pieces, size), sha256: hash.digest('hex'), size };
}

function mediaExtension(bytes) {
  const head = bytes.toString('latin1', 0, 16);
  if (head.startsWith('GIF89a') || head.startsWith('GIF87a')) return 'gif';
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'png';
  if (head.startsWith('\xff\xd8\xff')) return 'jpg';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'wav';
  if (head.startsWith('OggS')) return 'ogg';
  if (head.startsWith('fLaC')) return 'flac';
  if (head.startsWith('ID3') || (head.charCodeAt(0) === 255 && (head.charCodeAt(1) & 0xe6) === 0xe2))
    return 'mp3';
  if (head.slice(4, 8) === 'ftyp') {
    const brand = head.slice(8, 12);
    if (/^(?:avif|avis|heic|mif1|heix|hevc)$/.test(brand)) throw new Error('Unsupported image container');
    if (brand === 'qt  ') return 'mov';
    if (/^M4A/.test(brand)) return 'm4a';
    return 'mp4';
  }
  if (head.startsWith('\x1a\x45\xdf\xa3'))
    return bytes.subarray(0, 4096).includes(Buffer.from('webm')) ? 'webm' : 'mkv';
  throw new Error('Unsupported media file');
}

const MEDIA_LIMIT = 32 * 1024 * 1024;
const plain = (text) =>
  String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
async function findCommons(query, category) {
  const needle =
    category === 'audiofx'
      ? 'filetype:audio'
      : category === 'sticker'
        ? 'filemime:image/gif'
        : category === 'visualfx'
          ? 'filetype:video'
          : '';
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  api.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: query + ' ' + needle,
    gsrlimit: '14',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|Attribution|Credit',
  });
  const { buffer } = await downloadPublic(api, {
    maxBytes: 1024 * 1024,
    allowedHosts: (host) => host === 'commons.wikimedia.org',
  });
  const pages = JSON.parse(buffer).query?.pages || [];
  for (const page of pages.sort((a, b) => a.index - b.index)) {
    const info = page.imageinfo?.[0];
    if (
      !info ||
      info.size > MEDIA_LIMIT ||
      !/^(image\/(gif|png|jpeg|webp)|audio\/(ogg|mpeg|flac|wav|x-wav)|video\/(webm|mp4|ogg)|application\/ogg)$/.test(
        info.mime,
      )
    )
      continue;
    const meta = info.extmetadata || {};
    const license = plain(meta.LicenseShortName?.value);
    if (!/^(CC0|Public domain|CC BY(?:-SA)? [\d.]+)$/i.test(license)) continue;
    const author = plain(meta.Attribution?.value || meta.Artist?.value);
    if (/^CC BY/i.test(license) && !author) continue;
    return {
      url: info.url,
      source: {
        title: plain(page.title),
        page: info.descriptionurl,
        author,
        credit: plain(meta.Credit?.value),
        license,
        licenseUrl: plain(meta.LicenseUrl?.value),
      },
    };
  }
  throw new Error('Wikimedia Commons: no matching, supported media found / brak odpowiedniego pliku');
}
module.exports = { publicAddress, downloadPublic, mediaExtension, findCommons, MEDIA_LIMIT };
