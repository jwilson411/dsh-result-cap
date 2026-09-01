/**
 * The product: what `capResult` does to a string, to a `{ text }` result, and to
 * everything else.
 *
 * Four properties are load-bearing and each is asserted directly rather than
 * inferred. A result that fits comes back **identical**, so the presence of
 * `truncated` means something. The digest is of the **full original**, not of
 * the prefix — proved by checking it against `Buffer.from(original)` *and* by
 * showing it differs from the prefix's own digest. The prefix is **valid UTF-8**
 * even when the cap lands inside a three-byte character. And the whole thing is
 * **deterministic**: same input, same cap, byte-identical output.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  DEFAULT_MAX_BYTES,
  InvalidResultCapConfigError,
  MAX_BYTES_ENV,
  RESULT_CAP_CONFIG,
  WRAPPER_KEYS,
  capResult,
  capText,
  isTextResult,
  normalizeMaxBytes,
  resolveConfig,
  sha256Hex,
  utf8Length,
  utf8Prefix,
} from '../src/cap.js'

/**
 * The digest of a string's UTF-8 bytes, computed the long way so the test does
 * not merely agree with the implementation it is checking.
 * @param text - Any string.
 * @returns Lowercase hex.
 */
function digest(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

test('a string under the cap comes back identical, with no wrapper', () => {
  for (const value of ['', 'ok', 'x'.repeat(99), 'héllo wörld']) {
    const capped = capResult(value, 100)

    assert.equal(typeof capped, 'string')
    assert.equal(capped, value)
  }

  // Exactly at the cap is under it: the limit is what may pass, not what may not.
  const exact = 'x'.repeat(100)
  assert.equal(capResult(exact, 100), exact)
  assert.equal(capText(exact, 100), null)
})

test('a string over the cap becomes the four-key wrapper', () => {
  const original = 'abcdefghij'.repeat(10)
  const capped = capResult(original, 12)

  assert.deepEqual(Object.keys(capped).sort(), [...WRAPPER_KEYS].sort())
  assert.equal(capped.text, 'abcdefghijab')
  assert.equal(capped.truncated, true)
  assert.equal(capped.omitted_bytes, utf8Length(original) - utf8Length(capped.text))
  assert.equal(capped.omitted_bytes, 88)
})

test('the digest is of the full original, not of the prefix', () => {
  const original = `${'a'.repeat(50)}the tail that was cut`
  const capped = capResult(original, 20)

  assert.equal(capped.sha256, digest(original))
  assert.equal(capped.sha256, sha256Hex(original))

  // The point of the assertion above: it is a different hash from the prefix's.
  assert.notEqual(digest(capped.text), digest(original))
  assert.notEqual(capped.sha256, digest(capped.text))

  assert.match(capped.sha256, /^[0-9a-f]{64}$/)
})

test('a three-byte character on the boundary is never split', () => {
  // U+20AC EURO SIGN is e2 82 ac. With ten leading ASCII bytes the character
  // occupies bytes 10, 11 and 12, so caps of 10, 11 and 12 all land on or inside
  // it and only 13 fits it whole.
  const original = `${'a'.repeat(10)}€${'b'.repeat(40)}`
  assert.equal(utf8Length(original), 53)

  for (const maxBytes of [10, 11, 12, 13]) {
    const capped = capResult(original, maxBytes)
    const prefix = capped.text
    const bytes = Buffer.from(prefix, 'utf8')

    // Valid UTF-8: no replacement character, and a lossless round trip. A torn
    // e2 82 would decode to U+FFFD and fail both.
    assert.equal(prefix.includes('�'), false, `cap ${maxBytes} tore a character`)
    assert.equal(bytes.toString('utf8'), prefix, `cap ${maxBytes} did not round-trip`)
    assert.ok(bytes.length <= maxBytes, `cap ${maxBytes} overshot`)

    // The euro sign is wholly in the prefix or wholly omitted, never in part.
    assert.equal(prefix, maxBytes < 13 ? 'a'.repeat(10) : `${'a'.repeat(10)}€`)
    assert.equal(bytes.includes(0xe2), maxBytes >= 13)

    assert.equal(capped.omitted_bytes, 53 - bytes.length)
    assert.equal(capped.sha256, digest(original))
  }
})

test('four-byte characters and combining sequences survive the same way', () => {
  // U+1F600 is f0 9f 98 80 — the widest UTF-8 gets, and the worst case for the
  // walk back, which gives up at most three bytes.
  const original = `${'a'.repeat(8)}\u{1F600}${'b'.repeat(30)}`

  for (const maxBytes of [8, 9, 10, 11, 12]) {
    const prefix = utf8Prefix(original, maxBytes)

    assert.equal(prefix.includes('�'), false)
    assert.equal(Buffer.from(prefix, 'utf8').toString('utf8'), prefix)
    assert.equal(prefix, maxBytes < 12 ? 'a'.repeat(8) : `${'a'.repeat(8)}\u{1F600}`)
  }
})

test('the cap counts UTF-8 bytes, not JS string length', () => {
  // Twenty euro signs: 20 UTF-16 code units, 60 UTF-8 bytes. A cap of 30 counted
  // as characters would keep all twenty; counted as bytes it keeps ten.
  const original = '€'.repeat(20)
  assert.equal(original.length, 20)
  assert.equal(utf8Length(original), 60)

  const capped = capResult(original, 30)
  assert.equal(capped.text, '€'.repeat(10))
  assert.equal(capped.omitted_bytes, 30)
})

test('a one-byte cap on multi-byte text yields an empty prefix, honestly flagged', () => {
  const capped = capResult('€€', 1)

  assert.equal(capped.text, '')
  assert.equal(capped.truncated, true)
  assert.equal(capped.omitted_bytes, 6)
  assert.equal(capped.sha256, digest('€€'))
})

test('a { text } result over the cap is wrapped, and one under it is untouched', () => {
  const short = { text: 'small', mimeType: 'text/plain' }
  assert.equal(capResult(short, 100), short)
  assert.deepEqual(capResult(short, 100), { text: 'small', mimeType: 'text/plain' })

  const long = { text: 'z'.repeat(500), mimeType: 'text/plain', source: 'stub' }
  const capped = capResult(long, 64)

  assert.equal(capped.text, 'z'.repeat(64))
  assert.equal(capped.truncated, true)
  assert.equal(capped.omitted_bytes, 436)
  assert.equal(capped.sha256, digest('z'.repeat(500)))

  // Siblings ride along; the original object is not mutated.
  assert.equal(capped.mimeType, 'text/plain')
  assert.equal(capped.source, 'stub')
  assert.equal(long.text.length, 500)
  assert.equal(Object.hasOwn(long, 'truncated'), false)
})

test('a sibling key cannot overwrite the four the wrapper owns', () => {
  const original = { text: 'y'.repeat(200), truncated: false, sha256: 'stale', omitted_bytes: 0 }
  const capped = capResult(original, 16)

  assert.equal(capped.truncated, true)
  assert.equal(capped.sha256, digest('y'.repeat(200)))
  assert.equal(capped.omitted_bytes, 184)
  assert.equal(capped.text, 'y'.repeat(16))
})

test('non-text results pass through untouched', () => {
  const buffer = Buffer.alloc(4096, 0xff)
  const typed = new Uint8Array(4096)
  const image = { image: 'x'.repeat(5000) }
  const media = { mimeType: 'image/png', data: 'x'.repeat(5000) }
  const array = ['x'.repeat(5000)]
  const nested = { result: { text: 'x'.repeat(5000) } }
  const numericText = { text: 12345 }

  for (const value of [
    buffer,
    typed,
    image,
    media,
    array,
    nested,
    numericText,
    42,
    true,
    false,
    null,
    undefined,
  ]) {
    assert.equal(capResult(value, 8), value)
  }

  // Nothing was measured by stringifying: the nested giant string is still there.
  assert.equal(nested.result.text.length, 5000)
  assert.equal(isTextResult(buffer), false)
  assert.equal(isTextResult(typed), false)
  assert.equal(isTextResult({ text: 'yes' }), true)
})

test('an inherited text field is not treated as a result field', () => {
  const value = Object.create({ text: 'x'.repeat(500) })
  assert.equal(isTextResult(value), false)
  assert.equal(capResult(value, 8), value)
})

test('capping is deterministic and idempotent', () => {
  const original = `${'é'.repeat(400)}tail`

  const first = capResult(original, 101)
  const second = capResult(original, 101)

  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(first.sha256, second.sha256)

  // Capping the capped result again changes nothing: its text already fits.
  const again = capResult(first, 101)
  assert.deepEqual(again, first)
  assert.equal(again.sha256, first.sha256)
})

test('the default cap is 8192 bytes', () => {
  assert.equal(DEFAULT_MAX_BYTES, 8192)
  assert.deepEqual(resolveConfig(), { maxBytes: 8192 })
  assert.deepEqual(resolveConfig({}, {}), { maxBytes: 8192 })

  assert.equal(capResult('x'.repeat(8192)), 'x'.repeat(8192))

  const capped = capResult('x'.repeat(8193))
  assert.equal(capped.text.length, 8192)
  assert.equal(capped.omitted_bytes, 1)
})

test('config wins over the environment, which wins over the default', () => {
  assert.deepEqual(resolveConfig({ maxBytes: 100 }, { [MAX_BYTES_ENV]: '200' }), { maxBytes: 100 })
  assert.deepEqual(resolveConfig({}, { [MAX_BYTES_ENV]: '200' }), { maxBytes: 200 })
  assert.deepEqual(resolveConfig({}, { [MAX_BYTES_ENV]: '  ' }), { maxBytes: DEFAULT_MAX_BYTES })
  assert.deepEqual(resolveConfig({}, {}), { maxBytes: DEFAULT_MAX_BYTES })
})

test('a quoted number is accepted; anything else is rejected, never defaulted', () => {
  assert.deepEqual(resolveConfig({ maxBytes: '8192' }), { maxBytes: 8192 })
  assert.deepEqual(resolveConfig({ maxBytes: ' 512 ' }), { maxBytes: 512 })
  assert.equal(normalizeMaxBytes('1'), 1)

  for (const bad of [0, -1, 1.5, 'nope', '', true, false, null, [], {}, Number.NaN, Infinity]) {
    assert.throws(
      () => resolveConfig({ maxBytes: bad }),
      (error) => {
        assert.ok(error instanceof InvalidResultCapConfigError)
        assert.equal(error.name, 'InvalidResultCapConfigError')
        assert.equal(error.code, RESULT_CAP_CONFIG)
        assert.equal(error.plugin, 'dsh-result-cap')
        assert.match(error.message, /at least 1/)
        return true
      },
      `maxBytes: ${JSON.stringify(bad)} was not rejected`,
    )
  }

  // An unusable cap reaching capResult directly is rejected too, rather than
  // silently becoming the default and shortening nothing.
  assert.throws(() => capResult('x'.repeat(100), 0), InvalidResultCapConfigError)
  assert.throws(() => capResult('x'.repeat(100), 1.5), InvalidResultCapConfigError)
})

test('an unknown config key is rejected, not ignored', () => {
  assert.throws(
    () => resolveConfig({ maxByte: 200 }),
    (error) => {
      assert.ok(error instanceof InvalidResultCapConfigError)
      assert.equal(error.code, RESULT_CAP_CONFIG)
      assert.match(error.message, /unknown key "maxByte"/)
      return true
    },
  )

  assert.throws(() => resolveConfig({ maxBytes: 100, mode: 'summary' }), InvalidResultCapConfigError)
  assert.throws(() => resolveConfig([]), InvalidResultCapConfigError)
  assert.throws(() => resolveConfig(null), InvalidResultCapConfigError)
  assert.throws(() => resolveConfig('8192'), InvalidResultCapConfigError)
})

test('an unusable environment value fails loudly rather than falling back', () => {
  assert.throws(
    () => resolveConfig({}, { [MAX_BYTES_ENV]: 'lots' }),
    (error) => {
      assert.ok(error instanceof InvalidResultCapConfigError)
      assert.match(error.message, new RegExp(MAX_BYTES_ENV))
      return true
    },
  )
})
