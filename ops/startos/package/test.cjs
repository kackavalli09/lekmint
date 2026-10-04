// Exercises package exports with fixtures only; never invokes main or any daemon.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const pkg = require('./javascript/index.js')

test('default CLI package inputs are present before image builds', () => {
  for (const name of ['icon.svg', 'LICENSE', 'instructions.md', 'javascript/index.js']) {
    assert.ok(fs.statSync(path.join(__dirname, name)).isFile(), name)
  }
  assert.ok(fs.statSync(path.join(__dirname, 'assets')).isDirectory())
  assert.ok(fs.existsSync(path.join(__dirname, 'assets/README.md')),
    'Track a file so the required directory survives a checkout or ZIP export')
})

test('external lockfile has portable URLs and integrity for every download', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8'))
  for (const item of Object.values(lock.packages)) {
    if (!item.resolved) continue
    assert.ok(item.resolved.startsWith('https://registry.npmjs.org/') ||
      item.resolved === 'file:vendor/start9labs-start-sdk-2.0.9-lek.1.tgz')
    assert.ok(item.integrity, 'Download must retain integrity verification')
  }
})

test('package identity and image architecture cannot replace the live mint', () => {
  assert.equal(pkg.manifest.id, 'lek-mint-lab')
  assert.equal(pkg.manifest.sdkVersion, '2.0.9-lek.1')
  assert.deepEqual(pkg.manifest.volumes, ['postgres', 'config'])
  for (const image of Object.values(pkg.manifest.images)) {
    assert.deepEqual(image.arch, ['x86_64'])
    const build = image.source.dockerBuild
    // CLI 1.1.0 passes `build <workdir> -f <dockerfile>` without chdir:
    // both paths are relative to the package, not to each other.
    assert.ok(fs.existsSync(path.resolve(__dirname, build.workdir, 'pnpm-lock.yaml')))
    assert.ok(fs.existsSync(path.resolve(__dirname, build.dockerfile)))
  }
})
test('native backup refuses rather than copying a live database', async () => {
  await assert.rejects(pkg.createBackup(), /Native backup disabled/)
})
test('native restore refuses before any device or filesystem effect', async () => {
  let children = 0
  const effects = {
    child() { children++; return {} },
    setInitProgress() { throw new Error('Unexpected effect') },
  }
  await assert.rejects(pkg.init({ effects, kind: 'restore' }), /Native restore disabled/)
  assert.equal(children, 1)
})
test('standby, ordering and private config are explicit in the runtime source', () => {
  const main = fs.readFileSync(path.join(__dirname, 'startos/main.ts'), 'utf8')
  assert.match(main, /MINT_OPERATION_MODE: 'standby'/)
  assert.doesNotMatch(main, /MINT_OPERATION_MODE: 'active'/)
  assert.match(main, /requires: \['postgres'\]/)
  assert.match(main, /mountpoint: '\/run\/lek-config', readonly: true/)
  const init = fs.readFileSync(path.join(__dirname, 'startos/index.ts'), 'utf8')
  assert.match(init, /setupInterfaces\(async \(\) => \[\]\)/)
  assert.match(init, /actions = sdk.Actions.of\(\)/)
})
test('build recipe contains no install or publish target', () => {
  const make = fs.readFileSync(path.join(__dirname, 'Makefile'), 'utf8')
  assert.doesNotMatch(make, /^(install|publish)\s*:/m)
  assert.doesNotMatch(make, /start-cli package install/)
})