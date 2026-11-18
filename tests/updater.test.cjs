const test = require('node:test');
const assert = require('node:assert/strict');
const { newerVersion, releaseInfo, expectedChecksum } = require('../app/updater.cjs');
const name = 'Cutting-edge-Setup-x64.exe';
const base = 'https://github.com/szymongazinski/Cutting-edge/releases/download/v1.10.0/';
const data = {
  tag_name: 'v1.10.0',
  draft: false,
  prerelease: false,
  assets: [name, 'SHA256SUMS.txt'].map((name) => ({
    name,
    state: 'uploaded',
    browser_download_url: base + name,
  })),
};
test('compares stable versions numerically and accepts releases from the project', () => {
  assert.ok(newerVersion('1.10.0', '1.9.9'));
  assert.equal(newerVersion('1.0.0', '1.0.0'), false);
  assert.equal(newerVersion('1.0.0', '1.0.1'), false);
  assert.equal(releaseInfo(data).version, '1.10.0');
  assert.throws(() =>
    releaseInfo({
      ...data,
      assets: [
        { ...data.assets[0], browser_download_url: 'https://unrelated.test/app.exe' },
        data.assets[1],
      ],
    }),
  );
  assert.throws(() => releaseInfo({ ...data, assets: [data.assets[0]] }));
});
test('verifies the named installer and rejects duplicate or malformed hash entries', () => {
  const sha = 'ad'.repeat(32);
  assert.equal(expectedChecksum(sha + '  other.exe\n' + sha.toUpperCase() + ' *' + name + '\r\n'), sha);
  assert.throws(() => expectedChecksum(sha + '  other.exe'));
  assert.throws(() => expectedChecksum('broken  ' + name));
  assert.throws(() => expectedChecksum(sha + '  ' + name + '\n' + sha + '  ' + name));
});
