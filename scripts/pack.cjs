'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  build = path.join(root, 'build'),
  dist = path.join(root, 'dist');
const manifest = require('../package.json');
async function main() {
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-media.cjs')], { stdio: 'inherit' });
  await Promise.all([fs.mkdir(build, { recursive: true }), fs.mkdir(dist, { recursive: true })]);
  const stage = await fs.mkdtemp(path.join(build, 'stage-'));
  try {
    for (const name of [
      'app',
      'ui',
      'assets/library',
      'assets/fonts',
      'assets/icons',
      'assets/app.ico',
      'LICENSE',
      'THIRD-PARTY.md',
      'node_modules/gifenc',
    ]) {
      const target = path.join(stage, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(path.join(root, name), target, { recursive: true });
    }
    await fs.writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          productName: manifest.productName,
          main: manifest.main,
          description: manifest.description,
          author: manifest.author,
          license: manifest.license,
          dependencies: manifest.dependencies,
        },
        null,
        2,
      ),
    );
    const { packager } = await import('@electron/packager');
    const [product] = await packager({
      dir: stage,
      name: manifest.productName,
      executableName: manifest.productName,
      appVersion: manifest.version,
      platform: 'win32',
      arch: 'x64',
      electronVersion: manifest.devDependencies.electron,
      prune: false,
      asar: true,
      overwrite: true,
      out: path.join(build, 'electron'),
      extraResource: [path.join(root, 'tools'), path.join(root, 'assets', 'sample')],
      icon: path.join(root, 'assets', 'app.ico'),
      win32metadata: {
        CompanyName: manifest.author,
        ProductName: manifest.productName,
        FileDescription: manifest.description,
        OriginalFilename: manifest.productName + '.exe',
      },
    });
    const output = path.resolve(dist, 'win-unpacked');
    if (path.dirname(output) !== dist || !path.resolve(product).startsWith(build + path.sep))
      throw Error('Invalid output path');
    await fs.rm(output, { recursive: true, force: true });
    await fs.rename(product, output);
    console.log(path.join(output, manifest.productName + '.exe'));
  } finally {
    if (path.dirname(stage) === build && path.basename(stage).startsWith('stage-'))
      await fs.rm(stage, { recursive: true, force: true });
  }
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
