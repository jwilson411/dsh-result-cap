/**
 * The plugin seam: that `apply` patches the registry it is given, that both
 * patched paths cap, that errors travel untouched, and that dispose leaves the
 * registry exactly as it was found.
 *
 * The mandatory case is a stub context exposing nothing but `tools.register`.
 * The optional `tools.execute` seam is exercised separately, against a stub that
 * dispatches the way the real runtime does, so a call travelling through both
 * wrappers is proved to be shortened once and not twice.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MAX_BYTES,
  InvalidResultCapConfigError,
  MAX_BYTES_ENV,
  PLUGIN_NAME,
  apply,
  capResult,
  decorateTool,
  inject,
  name,
  patchExecute,
  patchRegister,
  resolveConfig,
} from '../src/index.js'

import { dispatchingContext, exec, stubContext, stubTool } from './helpers.js'

/** The package root. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The package manifest, read once. */
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The digest of a string's UTF-8 bytes, computed independently of the source.
 * @param text - Any string.
 * @returns Lowercase hex.
 */
function digest(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

test('the plugin declares the name, injection, and identity a loader reads', () => {
  assert.equal(name, 'result-cap')
  assert.equal(PLUGIN_NAME, 'dsh-result-cap')
  assert.deepEqual(inject, ['tools'])
})

test('apply patches register so a tool registered afterwards is capped', async () => {
  const { ctx, registered } = stubContext()
  const installed = apply(ctx, { maxBytes: 32 })

  assert.deepEqual(installed, { plugin: PLUGIN_NAME, maxBytes: 32 })

  const original = 'q'.repeat(500)
  const { definition, calls } = stubTool('search', () => original)
  ctx.tools.register(definition)

  assert.equal(registered.length, 1)
  assert.notEqual(registered[0], definition, 'the definition was mutated rather than copied')
  assert.equal(registered[0].name, 'search')

  const result = await registered[0].execute({ q: 'x' }, exec)

  assert.equal(calls.count, 1, 'the body must still run — this plugin caps output, not calls')
  assert.equal(result.text, 'q'.repeat(32))
  assert.equal(result.truncated, true)
  assert.equal(result.omitted_bytes, 468)
  assert.equal(result.sha256, digest(original))
})

test('a result under the cap reaches the caller unchanged through the patch', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx, { maxBytes: 64 })

  const { definition } = stubTool('search', () => 'small enough')
  ctx.tools.register(definition)

  assert.equal(await registered[0].execute({}, exec), 'small enough')
})

test('a definition with no callable execute is registered untouched', () => {
  const { ctx, registered } = stubContext()
  apply(ctx, {})

  const bare = { name: 'inert', description: 'nothing to cap' }
  const odd = { name: 'odd', execute: 'not a function' }

  ctx.tools.register(bare)
  ctx.tools.register(odd)

  assert.equal(registered[0], bare)
  assert.equal(registered[1], odd)
})

test('a thrown tool error is not swallowed, shortened, or turned into a result', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx, { maxBytes: 8 })

  const boom = new Error('the tool failed')
  const { definition } = stubTool('search', () => {
    throw boom
  })
  ctx.tools.register(definition)

  await assert.rejects(() => registered[0].execute({}, exec), (error) => {
    assert.equal(error, boom)
    return true
  })
})

test('the execute seam caps a tool registered before the plugin applied', async () => {
  const { ctx, calls } = dispatchingContext()

  const original = 'w'.repeat(300)
  const { definition } = stubTool('legacy', () => original)
  ctx.tools.register(definition) // before apply: the register patch cannot see it

  apply(ctx, { maxBytes: 40 })

  const result = await ctx.tools.execute({ name: 'legacy', arguments: {}, callId: 'c1' })

  assert.equal(calls.body, 1)
  assert.equal(result.text, 'w'.repeat(40))
  assert.equal(result.truncated, true)
  assert.equal(result.omitted_bytes, 260)
  assert.equal(result.sha256, digest(original))
})

test('a call passing through both seams is shortened once', async () => {
  const { ctx } = dispatchingContext()
  apply(ctx, { maxBytes: 40 })

  const original = 'w'.repeat(300)
  const { definition } = stubTool('search', () => original)
  ctx.tools.register(definition) // after apply: wrapped, and dispatched through execute

  const result = await ctx.tools.execute({ name: 'search', arguments: {}, callId: 'c2' })

  // Not a wrapper wrapped in a wrapper: one prefix, one digest of the original.
  assert.deepEqual(Object.keys(result).sort(), [
    'omitted_bytes',
    'sha256',
    'text',
    'truncated',
  ])
  assert.equal(result.text, 'w'.repeat(40))
  assert.equal(result.omitted_bytes, 260)
  assert.equal(result.sha256, digest(original))
})

test('patchRegister refuses a context with no tool registry', () => {
  assert.throws(() => patchRegister({}, 100), /ctx\.tools\.register is not a function/)
  assert.throws(() => apply({}, {}), /ctx\.tools\.register is not a function/)
})

test('patchExecute is optional and returns null when the runtime has none', () => {
  const { ctx } = stubContext()
  assert.equal(patchExecute(ctx, 100), null)
})

test('dispose restores the registry exactly as it was found', async () => {
  const { ctx, disposers } = stubContext()
  const registerBefore = ctx.tools.register

  apply(ctx, { maxBytes: 8 })
  assert.notEqual(ctx.tools.register, registerBefore)

  assert.equal(disposers.length, 1)
  assert.equal(disposers[0].event, 'dispose')
  disposers[0].listener()

  assert.equal(ctx.tools.register, registerBefore)
})

test('dispose deletes an inherited method rather than shadowing it', async () => {
  class Registry {
    register(definition) {
      this.last = definition
      return () => {}
    }
  }
  const registry = new Registry()
  const events = []
  const ctx = { tools: registry, on: (event, listener) => events.push({ event, listener }) }

  apply(ctx, { maxBytes: 8 })
  assert.equal(Object.hasOwn(registry, 'register'), true)

  events[0].listener()

  assert.equal(Object.hasOwn(registry, 'register'), false, 'an own property was left shadowing')
  assert.equal(registry.register, Registry.prototype.register)
})

test('apply validates before it touches the registry', () => {
  const { ctx } = stubContext()
  const registerBefore = ctx.tools.register

  assert.throws(() => apply(ctx, { maxBytes: 0 }), InvalidResultCapConfigError)
  assert.throws(() => apply(ctx, { maxByte: 200 }), InvalidResultCapConfigError)
  assert.throws(() => apply(ctx, { maxBytes: 'nope' }), InvalidResultCapConfigError)

  assert.equal(ctx.tools.register, registerBefore, 'the registry was patched before validating')
})

test('apply with no config installs the documented default', () => {
  const { ctx } = stubContext()
  assert.equal(apply(ctx, {}).maxBytes, DEFAULT_MAX_BYTES)
  assert.equal(resolveConfig({}, {}).maxBytes, 8192)
  assert.equal(resolveConfig({}, { [MAX_BYTES_ENV]: '64' }).maxBytes, 64)
})

test('decorateTool caps without disturbing the rest of the definition', async () => {
  const { definition } = stubTool('search', () => ({ text: 'p'.repeat(120), source: 'stub' }))
  const capped = decorateTool(definition, 16)

  assert.equal(capped.name, definition.name)
  assert.equal(capped.description, definition.description)
  assert.deepEqual(capped.parameters, definition.parameters)
  assert.equal(Object.getPrototypeOf(capped), Object.getPrototypeOf(definition))

  const result = await capped.execute({}, exec)
  assert.equal(result.text, 'p'.repeat(16))
  assert.equal(result.source, 'stub')
  assert.equal(result.sha256, digest('p'.repeat(120)))
})

test('the package is shaped the way the profile installer expects', () => {
  assert.equal(manifest.name, PLUGIN_NAME)
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'src/index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.engines.node, '>=22.14.0')
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'], '0.1.1-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '^4.0.1')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '^0.1.1-rc.2')
  assert.equal(manifest.scripts.test, 'node --test "test/**/*.test.js"')

  for (const keyword of ['dsh-plugin', 'deepseek-harness']) {
    assert.ok(manifest.keywords.includes(keyword), `keywords omit ${keyword}`)
  }
  for (const entry of ['.', './cap', './cordis.patch.yml', './package.json']) {
    assert.ok(Object.hasOwn(manifest.exports, entry), `exports omit ${entry}`)
  }
  for (const file of ['src', 'cordis.patch.yml', 'LICENSE', 'README.md']) {
    assert.ok(manifest.files.includes(file), `files omit ${file}`)
  }
  for (const url of [manifest.homepage, manifest.bugs.url, manifest.repository.url]) {
    assert.match(url, /github\.com\/jwilson411\/dsh-result-cap/)
  }
})

test('the patch row is the one the installer will compose', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

  assert.match(patch, /^- insert:$/m)
  assert.match(patch, /^ {4}- id: result-cap$/m)
  assert.match(patch, /^ {6}name: dsh-result-cap$/m)
  // The two things a profile author has to know from this file alone.
  assert.match(patch, /Defaults to 8192/)
  assert.match(patch, /REPLACES the row's whole `config`/)
})

test('capResult is re-exported from the package entry point', () => {
  assert.equal(typeof capResult, 'function')
  assert.equal(capResult('short', 100), 'short')
  assert.equal(capResult('x'.repeat(200), 10).truncated, true)
})
