/**
 * Repository hygiene, asserted rather than promised.
 *
 * Four claims are checked here. That the tree carries no machine names, mount
 * paths, or credential-variable names from wherever it was written. That the
 * shipped source opens nothing — no socket, no file, no subprocess — because a
 * plugin that sits on the return path of every tool call in a composition, and
 * hashes what passes through it, is the last place anyone should have to audit
 * for an egress path. That the manifest points the profile installer at a patch
 * file that exists. And that the README states the boundary of the product in
 * plain words, since "shrinks tool results" is exactly the overstatement a
 * reader would otherwise make on this package's behalf — it truncates, it does
 * not compress, and it never calls a model to decide what to keep.
 *
 * The forbidden literals are assembled from fragments so that this file does not
 * itself trip the scan it performs.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The package root, walked below. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directories never worth scanning: not ours, or not text. */
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** Extensions with no text worth scanning. */
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2'])

/**
 * Every checked-in text file, repo-relative.
 * @returns Paths relative to the package root, in directory order.
 */
function repoFiles() {
  return readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath ?? entry.path, entry.name)))
    .filter((path) => !path.split(sep).some((segment) => SKIP_DIRS.has(segment)))
    .filter((path) => !BINARY_EXTENSIONS.has(extname(path)))
}

/**
 * Read a repo file as text.
 * @param path - A repo-relative path.
 * @returns Its contents.
 */
function readRepoFile(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

/**
 * The literals that must not appear anywhere in the tree, each built from
 * fragments so this file is not its own counterexample.
 */
const FORBIDDEN = [
  { what: 'a private machine name', pattern: new RegExp(['def', 'iant'].join(''), 'i') },
  { what: 'a host-local mount path', pattern: /\/mnt\/[a-z]/i },
  { what: 'a CI token variable', pattern: new RegExp(['GITHUB', 'TOKEN'].join('_')) },
  { what: 'a provider key variable', pattern: new RegExp(['ANTHROPIC', 'API', 'KEY'].join('_')) },
  { what: 'a provider key variable', pattern: new RegExp(['OPENAI', 'API', 'KEY'].join('_')) },
  { what: 'a bearer token literal', pattern: /\bBearer [A-Za-z0-9._-]{20,}/ },
]

test('the tree carries no machine names, mount paths, or credential variables', () => {
  const offences = []

  for (const path of repoFiles()) {
    const text = readRepoFile(path)
    for (const { what, pattern } of FORBIDDEN) {
      const hit = pattern.exec(text)
      if (hit !== null) offences.push(`${path}: ${what} (${hit[0].slice(0, 24)})`)
    }
  }

  assert.deepEqual(offences, [])
})

test('the scan actually covers the files it claims to', () => {
  const files = repoFiles()

  for (const expected of [
    'package.json',
    'package-lock.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    '.gitignore',
    join('.github', 'workflows', 'ci.yml'),
    join('src', 'index.js'),
    join('src', 'cap.js'),
    join('test', 'helpers.js'),
    join('test', 'cap.test.js'),
    join('test', 'hygiene.test.js'),
    join('test', 'plugin.test.js'),
  ]) {
    assert.ok(files.includes(expected), `hygiene scan missed ${expected}`)
  }
  assert.equal(
    files.some((path) => path.startsWith('node_modules')),
    false,
  )
})

test('the shipped source opens nothing: no socket, no file, no subprocess', () => {
  // This package slices strings and hashes them. These are the ways it could
  // acquire an egress path or a write of its own, and it sees every tool result
  // in a composition on the way past.
  const banned = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bnode:(dns|net|tls|http|https|dgram|fs|child_process|worker_threads)\b/,
    /\bwriteFile|\bappendFile|\bcreateWriteStream\b/,
    /\bspawn\s*\(|\bexecSync\s*\(/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
  ]

  for (const path of repoFiles().filter((file) => file.startsWith(`src${sep}`))) {
    const text = readRepoFile(path)
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})

test('the shipped source imports only node builtins it needs', () => {
  const allowed = new Set(['node:buffer', 'node:crypto', 'node:process'])
  const specifiers = []

  for (const path of repoFiles().filter((file) => file.startsWith(`src${sep}`))) {
    const text = readRepoFile(path)
    for (const match of text.matchAll(/^\s*(?:import|export)[^'"\n]*from\s*'([^']+)'/gm)) {
      specifiers.push(match[1])
    }
  }

  assert.ok(specifiers.length > 0)
  for (const specifier of specifiers) {
    assert.ok(allowed.has(specifier) || specifier.startsWith('./'), `unexpected import ${specifier}`)
  }
})

test('the shipped source calls no model and reaches for no LLM', () => {
  // The disclaimers in the README are only worth what the source backs up. A
  // compressor model, a tokenizer, or a summarizer prompt would each turn the
  // deterministic guarantee into an approximate one.
  const banned = [
    /\bcreateMessage\b/,
    /\bcompletions?\.create\b/,
    /\bchat\.completions\b/,
    /\bctx\.llm\b/,
    /\binject\s*=\s*\[[^\]]*['"]llm['"]/,
    /\bencode\s*\(\s*prompt\b/,
  ]

  for (const path of repoFiles().filter((file) => file.startsWith(`src${sep}`))) {
    const text = readRepoFile(path)
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})

test('the manifest points the installer at a patch file that is in the published files', () => {
  const manifest = JSON.parse(readRepoFile('package.json'))
  const patch = manifest.dsh.bundle.patch

  assert.equal(patch, './cordis.patch.yml')
  assert.ok(repoFiles().includes(patch.replace('./', '')), 'dsh.bundle.patch names no real file')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch would not be published')

  const yaml = readRepoFile('cordis.patch.yml')
  assert.match(yaml, /name: dsh-result-cap/)
  assert.match(yaml, /id: result-cap/)
})

test('CI needs no credentials', () => {
  const workflow = readRepoFile(join('.github', 'workflows', 'ci.yml'))

  assert.match(workflow, /contents: read/)
  assert.match(workflow, /npm ci/)
  assert.match(workflow, /npm test/)
  assert.match(workflow, /'22\.x', '24\.x'/)
  assert.equal(/secrets\./.test(workflow), false)
})

test('the .gitignore keeps the usual noise out of the tree', () => {
  const ignored = readRepoFile('.gitignore')

  for (const entry of ['node_modules/', '*.tgz', '.env', '.DS_Store']) {
    assert.ok(ignored.includes(entry), `.gitignore omits ${entry}`)
  }
})

test('the README states the boundary of the product, not just its behaviour', () => {
  const readme = readRepoFile('README.md')

  // The load-bearing disclaimers. A reader who takes this for a compressor will
  // expect the meaning to survive the cap, and it keeps the first N bytes.
  assert.match(readme, /not Headroom/i)
  assert.match(readme, /not a compressor/i)
  assert.match(readme, /not semantic compression/i)
  assert.match(readme, /not a summarizer/i)
  assert.match(readme, /not a silent truncate/i)
  assert.match(readme, /calls no model|does not call an LLM/i)

  // And the things a reader has to be able to find.
  assert.match(readme, /dsh plugin --profile default add github:jwilson411\/dsh-result-cap/)
  assert.match(readme, /0\.1\.1-rc\.2/)
  assert.match(readme, /maxBytes/)
  assert.match(readme, /\b8192\b/)
  assert.match(readme, /DSH_RESULT_CAP_MAX_BYTES/)
  assert.match(readme, /truncated/)
  assert.match(readme, /omitted_bytes/)
  assert.match(readme, /sha256/)
  assert.match(readme, /dsh-tool-quota/)
  assert.match(readme, /TOOL_QUOTA_BYTES/)
  assert.match(readme, /strings only|v1 caps strings/i)
  assert.match(readme, /\bMIT\b/)
})
