/**
 * The pure half of dsh-result-cap: keep the first N UTF-8 bytes of a tool
 * result, and say so.
 *
 * The whole package is one integer and one hash. `maxBytes` is how much of a
 * result reaches the conversation. Everything past it is dropped, and the value
 * that comes back in its place carries `truncated: true`, how many bytes went
 * missing, and the SHA-256 of the **full original** — so a reader downstream can
 * tell it is holding a prefix, can say how much is gone, and can check a later
 * full copy against the digest of the one that was cut.
 *
 * **Nothing here is a compressor.** There is no model call, no tokenizer, no
 * summary, no semantic selection of what mattered. The first N bytes are the
 * first N bytes, chosen by counting and nothing else, which is why the same
 * input and the same cap always produce byte-identical output. A summarizer
 * would be a different package with a different failure mode.
 *
 * **The cap is bytes, not characters.** A JS string's `.length` counts UTF-16
 * code units and disagrees with UTF-8 for every character outside ASCII, so it
 * is never used for the measurement. The prefix is cut on a character boundary:
 * a multi-byte character straddling the limit is dropped whole rather than
 * halved into a torn sequence that round-trips to a replacement character.
 *
 * **v1 caps strings.** A bare string, or the `text` field of a result object.
 * A Buffer, a typed array, an image, a number, an array, an object with no
 * string `text` — all pass through untouched. There is no useful prefix of a
 * PNG, and inventing one would corrupt the result rather than shorten it.
 *
 * @module dsh-result-cap/cap
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

/** The npm package name, carried on every error so a rejection names its source. */
export const PLUGIN_NAME = 'dsh-result-cap'

/** The `code` on a rejected configuration. */
export const RESULT_CAP_CONFIG = 'RESULT_CAP_CONFIG'

/**
 * The cap applied when neither the patch row nor the environment names one.
 *
 * 8192 bytes is a few pages of text: enough that an ordinary tool result is
 * never touched, small enough that a tool which fetched a whole page cannot
 * spend a context window on it by accident.
 */
export const DEFAULT_MAX_BYTES = 8192

/** The environment variable consulted when the patch row sets no `maxBytes`. */
export const MAX_BYTES_ENV = 'DSH_RESULT_CAP_MAX_BYTES'

/** The only keys the config block may carry; anything else is an author error. */
export const CONFIG_KEYS = Object.freeze(['maxBytes'])

/** The four keys a truncated result always carries, in the order documented. */
export const WRAPPER_KEYS = Object.freeze(['text', 'truncated', 'omitted_bytes', 'sha256'])

/**
 * Raised when a configured cap is not one this plugin can enforce.
 *
 * Falling back to the default would be the worst possible reading of a typo. A
 * profile that wrote `maxByte: 200` meant to cap at 200 and would instead get
 * 8192, discovering the difference — if ever — only from a result that was
 * never shortened. An unusable cap stops the plugin from applying instead.
 */
export class InvalidResultCapConfigError extends Error {
  /**
   * @param message - What is wrong, naming the offending key.
   */
  constructor(message) {
    super(`result cap config: ${message}`)
    this.name = 'InvalidResultCapConfigError'
    /** Always {@link RESULT_CAP_CONFIG}. */
    this.code = RESULT_CAP_CONFIG
    /** The plugin that rejected the configuration. */
    this.plugin = PLUGIN_NAME
  }
}

/**
 * Validate a byte cap.
 *
 * Numeric strings are accepted because YAML quoting is an easy accident and a
 * quoted `"8192"` plainly means 8192. Everything else is rejected rather than
 * coerced: a float has no meaning as a byte count, and zero is not a cap but a
 * way to delete every result, which is a thing to say with a different plugin.
 * The floor is 1 — one byte, which for multi-byte text yields an empty prefix
 * and an honest `truncated: true` rather than a torn character.
 * @param value - A candidate cap.
 * @param label - The key being validated, for the message.
 * @returns The cap as an integer.
 * @throws {InvalidResultCapConfigError} When it is not an integer of at least 1.
 */
export function normalizeMaxBytes(value, label = 'maxBytes') {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value

  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 1) {
    throw new InvalidResultCapConfigError(
      `${label} must be an integer of at least 1 — got ${
        typeof value === 'string' ? `"${value}"` : String(value)
      }`,
    )
  }
  return numeric
}

/**
 * Resolve the effective cap from the patch row and the environment.
 *
 * Precedence is config, then environment, then the default. The patch row is
 * what a profile author wrote down and reviewed, so it wins over an environment
 * variable that some shell three layers up happened to export; the variable
 * exists so an operator can bound a deployment that never edited its profile.
 *
 * An unknown key is rejected, not ignored, for the same reason a bad value is:
 * `maxByte: 200` must not quietly mean "the default".
 * @param config - The `config` block of this plugin's row in the composed patch.
 * @param env - The environment to consult; injectable so tests need no globals.
 * @returns `{ maxBytes }`, validated.
 * @throws {InvalidResultCapConfigError} When the shape or the cap is unusable.
 */
export function resolveConfig(config = {}, env = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new InvalidResultCapConfigError(
      `config must be an object — got ${Array.isArray(config) ? 'an array' : String(config)}`,
    )
  }

  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new InvalidResultCapConfigError(
        `unknown key "${key}" — the only key this plugin reads is ${CONFIG_KEYS.join(', ')}`,
      )
    }
  }

  if (config.maxBytes !== undefined) return { maxBytes: normalizeMaxBytes(config.maxBytes) }

  const fromEnv = env?.[MAX_BYTES_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { maxBytes: normalizeMaxBytes(fromEnv, MAX_BYTES_ENV) }
  }

  return { maxBytes: DEFAULT_MAX_BYTES }
}

/**
 * The UTF-8 byte length of a string.
 * @param text - Any string.
 * @returns Its length in UTF-8 bytes, which is not its `.length` outside ASCII.
 */
export function utf8Length(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The lowercase hex SHA-256 of a string's UTF-8 bytes.
 * @param text - Any string.
 * @returns 64 hex characters.
 */
export function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/**
 * The longest valid UTF-8 prefix of `text` that fits in `maxBytes` bytes.
 *
 * The cut lands wherever `maxBytes` falls, which is very often in the middle of
 * a character: `€` is three bytes, and slicing after one of them leaves a
 * sequence no decoder will accept, which Node renders as `�` and a model
 * reads as damage. So the index is walked back over continuation bytes — every
 * byte of a multi-byte character after the first matches `0b10xxxxxx`, and no
 * lead byte does — until it sits on a character start. A character on the
 * boundary is therefore wholly in the prefix or wholly omitted, never both.
 *
 * At most three bytes are given up this way, since UTF-8 characters are at most
 * four bytes long.
 * @param text - The string to cut.
 * @param maxBytes - The byte budget for the prefix.
 * @returns A prefix that is valid UTF-8 and no longer than `maxBytes` bytes.
 */
export function utf8Prefix(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text

  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0b1100_0000) === 0b1000_0000) cut -= 1

  return bytes.subarray(0, cut).toString('utf8')
}

/**
 * Cap one string, or say it did not need capping.
 *
 * Null is the "fits" answer rather than a wrapper with `truncated: false`,
 * because a result that was not shortened should reach the conversation as
 * exactly what the tool returned. Wrapping everything would put a hash and a
 * flag in front of every ordinary result, and change the shape of a value the
 * caller already knows how to read.
 * @param text - The string to measure.
 * @param maxBytes - The byte cap.
 * @returns The four-key wrapper, or null when the string fits.
 */
export function capText(text, maxBytes) {
  const originalBytes = utf8Length(text)
  if (originalBytes <= maxBytes) return null

  const prefix = utf8Prefix(text, maxBytes)

  return {
    text: prefix,
    truncated: true,
    omitted_bytes: originalBytes - utf8Length(prefix),
    // The digest is of the FULL original, not of the prefix. A hash of what
    // survived would identify the truncation; a hash of what was cut identifies
    // the thing that was cut, which is what anyone holding a prefix wants to
    // check a later full copy against.
    sha256: sha256Hex(text),
  }
}

/**
 * Whether a value is a result object this plugin knows how to cap.
 *
 * The test is narrow on purpose: an own, enumerable, string `text` field on a
 * plain-ish object. Buffers and typed arrays are excluded explicitly even though
 * they carry no `text`, so that the exclusion is a stated rule rather than an
 * accident of what those classes happen to expose.
 * @param value - Anything a tool returned.
 * @returns True when {@link capResult} should look at its `text`.
 */
export function isTextResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return false
  }
  if (!Object.hasOwn(value, 'text') || !Object.prototype.propertyIsEnumerable.call(value, 'text')) {
    return false
  }
  return typeof value.text === 'string'
}

/**
 * Cap a tool result at `maxBytes` UTF-8 bytes.
 *
 * The product, and the only function most callers need. Deterministic: the same
 * value and the same cap always produce the same output, digest included, with
 * no clock, no counter, and no randomness anywhere in the path.
 *
 * Three outcomes:
 *
 *  - **Under the cap.** The value comes back unchanged — the same string, or the
 *    same object with the same fields. No flag, no hash, no wrapper.
 *  - **Over the cap.** A `{ text, truncated: true, omitted_bytes, sha256 }`
 *    object. For a result object, its other own enumerable fields are carried
 *    across too, and cannot overwrite those four.
 *  - **Not text.** Passed through. Numbers, booleans, null, arrays, Buffers,
 *    typed arrays, and objects with no string `text` are none of this plugin's
 *    business, and an arbitrary object is never JSON-stringified to be measured.
 *
 * @param value - Whatever the tool body returned.
 * @param maxBytes - The byte cap; defaults to {@link DEFAULT_MAX_BYTES}.
 * @returns The value, or its capped replacement.
 * @throws {InvalidResultCapConfigError} When `maxBytes` is not a usable cap.
 */
export function capResult(value, maxBytes = DEFAULT_MAX_BYTES) {
  const limit = normalizeMaxBytes(maxBytes)

  if (typeof value === 'string') return capText(value, limit) ?? value

  if (isTextResult(value)) {
    const capped = capText(value.text, limit)
    // Siblings first, so `text` cannot be shadowed by the original's own `text`
    // and a stale `truncated: false` from an upstream cap cannot survive.
    return capped === null ? value : { ...value, ...capped }
  }

  return value
}

/**
 * Wrap one tool's `execute` so its return value is capped.
 *
 * The cap runs **after** the body returns, on the value it produced. A thrown
 * error travels untouched: an error is not a result, has no prefix worth taking,
 * and swallowing one here would turn a tool failure into a short success.
 * @param execute - The original `execute(args, exec)`.
 * @param maxBytes - The byte cap.
 * @returns A drop-in replacement `execute`.
 */
export function wrapExecute(execute, maxBytes) {
  return async function resultCappedExecute(args, exec) {
    return capResult(await execute(args, exec), maxBytes)
  }
}

/**
 * Copy a tool definition with its `execute` capped.
 *
 * A copy rather than a mutation: the definition may be shared, frozen, or
 * re-registered into another scope, and a plugin that reached into someone
 * else's object to swap a method would make the cap impossible to remove. The
 * prototype is preserved so a definition built by a factory keeps whatever that
 * factory put on it.
 *
 * A definition with no callable `execute` is returned untouched — there is
 * nothing to cap, and failing here would break registration for a shape this
 * plugin has no opinion about.
 * @param definition - A `defineTool()` result, or any `{ name, execute }` object.
 * @param maxBytes - The byte cap.
 * @returns A capped copy, or the original when there is nothing to wrap.
 */
export function decorateTool(definition, maxBytes) {
  if (typeof definition?.execute !== 'function') return definition

  const copy = Object.assign(Object.create(Object.getPrototypeOf(definition)), definition)
  copy.execute = wrapExecute(definition.execute.bind(definition), maxBytes)
  return copy
}

/** {@link decorateTool} under the name a host patching definitions may look for. */
export const wrapDefinition = decorateTool
