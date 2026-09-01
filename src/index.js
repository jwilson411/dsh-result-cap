/**
 * dsh-result-cap — a DeepSeek Harness function plugin putting a
 * **deterministic byte cap** on tool results.
 *
 * One tool returns a four-megabyte page and the conversation is over. This
 * plugin keeps the first `maxBytes` UTF-8 bytes of the result and drops the
 * rest — and then says so, in the result itself:
 *
 * ```json
 * { "text": "…", "truncated": true, "omitted_bytes": 4103217, "sha256": "9f86d0…" }
 * ```
 *
 * The digest is of the **full original**, not of the prefix, so a reader holding
 * a shortened result can check a later complete copy against the thing that was
 * actually cut.
 *
 * **Truncation here is never silent.** That is the whole difference between this
 * plugin and a bug. Every shortened result carries `truncated: true`, and a
 * result that fits comes back byte-for-byte unchanged with no wrapper at all, so
 * the flag's presence means something.
 *
 * **This is not a compressor and not a summarizer.** No model is called, no
 * tokenizer is consulted, nothing is chosen for relevance. The first N bytes are
 * the first N bytes; the same result and the same cap always produce the same
 * output. It is not Headroom, and it does no semantic compression.
 *
 * It complements `dsh-tool-quota`, which caps result bytes by **throwing**
 * (`TOOL_QUOTA_BYTES`) and never truncating. Install that one when an oversized
 * result should stop the run; install this one when the run should continue on a
 * prefix that admits what it is. They compose — put this row after that one and
 * the quota's cap becomes the ceiling this one never reaches.
 *
 * Two seams, so both ways a tool gets called are covered. `ctx.tools.register`
 * is patched, so every definition registered for the lifetime of this fiber
 * returns capped results. `ctx.tools.execute` is patched when the runtime
 * exposes it, which catches a tool registered before this plugin started. A call
 * passing through both is capped twice with no second effect: the inner wrapper
 * produces a value already under the cap, so the outer one returns it unchanged.
 *
 * No model-facing tool is registered. v1 has no way to ask for the tail; the
 * `sha256` is there so the omission is identifiable, not so it can be undone.
 *
 * @module dsh-result-cap
 */
import { env } from 'node:process'

import {
  PLUGIN_NAME,
  capResult,
  decorateTool,
  resolveConfig as resolveCapConfig,
} from './cap.js'

export {
  CONFIG_KEYS,
  DEFAULT_MAX_BYTES,
  InvalidResultCapConfigError,
  MAX_BYTES_ENV,
  PLUGIN_NAME,
  RESULT_CAP_CONFIG,
  WRAPPER_KEYS,
  capResult,
  capText,
  decorateTool,
  isTextResult,
  normalizeMaxBytes,
  sha256Hex,
  utf8Length,
  utf8Prefix,
  wrapDefinition,
  wrapExecute,
} from './cap.js'

/** Cordis plugin name, used in loader diagnostics and the runtime plugin tree. */
export const name = 'result-cap'

/**
 * `tools` is a hard dependency: with no registry there is nothing to cap, so the
 * plugin waits rather than starting as a limit nobody consults.
 */
export const inject = ['tools']

/**
 * Resolve the plugin's effective settings.
 *
 * The environment is read here, at the edge, and passed down as a plain object,
 * so the pure half stays a function of its arguments and a test can drive any
 * environment it likes without touching the real one.
 * @param config - The `config` block of this plugin's row in the composed patch.
 * @param environment - The environment to consult; defaults to the real one.
 * @returns `{ maxBytes }`, validated.
 * @throws {InvalidResultCapConfigError} When the config or the cap is unusable.
 */
export function resolveConfig(config = {}, environment = env) {
  return resolveCapConfig(config, environment)
}

/**
 * Replace a method on an object and return the exact restorer.
 *
 * The distinction between an own property and an inherited one matters: the
 * real registry carries `register` on `ToolRuntime.prototype`, so restoring by
 * assignment would leave a permanent own property shadowing the class method
 * even after the plugin is gone. Deleting is the only restoration that is
 * actually a restoration.
 * @param target - The object holding the method.
 * @param key - The method name.
 * @param build - Given the original bound method, returns the replacement.
 * @returns A disposer that puts the object back exactly as it was found.
 */
function patchMethod(target, key, build) {
  const original = target[key]
  const wasOwn = Object.prototype.hasOwnProperty.call(target, key)

  target[key] = build(original.bind(target))

  return () => {
    if (wasOwn) target[key] = original
    else delete target[key]
  }
}

/**
 * Cap every tool registered from here on.
 *
 * Patching `register` rather than asking the host to wrap each definition is
 * what makes this plugin a drop-in: a profile adds the row and every tool in the
 * composition is capped, including tools from plugins that have never heard of
 * this one. The registry's disposer is passed straight back, so ownership and
 * HMR cleanup for the wrapped tool stay exactly where they were.
 * @param ctx - The injected Cordis context, with `tools` resolved.
 * @param maxBytes - The byte cap.
 * @returns A disposer restoring the original `register`.
 * @throws {Error} When the context exposes no tool registry.
 */
export function patchRegister(ctx, maxBytes) {
  const registry = ctx?.tools

  if (typeof registry?.register !== 'function') {
    throw new Error(
      `${name}: ctx.tools.register is not a function — this plugin injects "tools" and has ` +
        'nothing to cap without a tool registry',
    )
  }

  return patchMethod(registry, 'register', (register) => (definition) =>
    register(decorateTool(definition, maxBytes)),
  )
}

/**
 * Cap the registry's own execute, when the runtime has one.
 *
 * This is the seam that catches what the register patch cannot: a tool
 * registered before this plugin applied. A call reaching both seams is capped
 * twice and shortened once — the inner wrapper hands out a value already under
 * the cap, and capping a value that fits returns it unchanged.
 *
 * Optional on purpose. Everything here rests on `execute` being a public method
 * of the injected service; a runtime without one is simply covered by the
 * register patch alone, and no private API is reached for to close the gap.
 * @param ctx - The injected Cordis context.
 * @param maxBytes - The byte cap.
 * @returns A disposer, or null when the runtime exposes no `execute`.
 */
export function patchExecute(ctx, maxBytes) {
  const registry = ctx?.tools
  if (typeof registry?.execute !== 'function') return null

  return patchMethod(registry, 'execute', (execute) => async (input) =>
    capResult(await execute(input), maxBytes),
  )
}

/**
 * Install the cap for the lifetime of this fiber.
 *
 * The config is validated before the registry is touched, so a profile with an
 * unusable cap fails with nothing half-installed. Both patches are undone on
 * dispose when the context offers the hook, leaving the registry exactly as it
 * was found.
 * @param ctx - The injected Cordis context, with `tools` resolved.
 * @param config - The `config` block of this plugin's row in the composed patch.
 * @returns `{ maxBytes, plugin }`, so a host or a test can see what was installed.
 * @throws {InvalidResultCapConfigError} When the configured cap is unusable.
 * @throws {Error} When the context exposes no tool registry.
 */
export function apply(ctx, config = {}) {
  const { maxBytes } = resolveConfig(config)

  const disposers = [patchRegister(ctx, maxBytes), patchExecute(ctx, maxBytes)].filter(
    (disposer) => typeof disposer === 'function',
  )

  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers.reverse()) dispose()
    })
  }

  return { plugin: PLUGIN_NAME, maxBytes }
}
