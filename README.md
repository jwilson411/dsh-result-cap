# dsh-result-cap

A [DeepSeek Harness][dsh] function plugin: a **deterministic byte cap** on tool
results, with a receipt.

An agent calls a fetch tool. The page is four megabytes. The whole thing goes
into the conversation, and the run is over — not because anything failed, but
because one result ate the context.

This plugin keeps the first `maxBytes` UTF-8 bytes and drops the rest:

```json
{
  "text": "…the first 8192 bytes…",
  "truncated": true,
  "omitted_bytes": 4103217,
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

Three things are true of that object, and each of them is the point:

- **`truncated: true` is always there.** A result that fits comes back
  byte-for-byte unchanged, with no wrapper and no flag, so the flag's presence
  actually means something. Nothing is ever shortened quietly.
- **`sha256` is the digest of the full original**, not of the prefix. The
  shortened result names the thing that was cut, so a later complete copy can be
  checked against it.
- **The prefix is valid UTF-8.** A multi-byte character straddling the limit is
  dropped whole rather than sliced into a torn sequence that decodes to `�`.

And the same result with the same cap always produces the same output, digest
included. There is no clock, no counter, no randomness, and no model call
anywhere in the path.

## What it is not

**Not Headroom.** It does not manage a context window, decide what belongs in
one, or rewrite a conversation. It caps one tool result at a time and knows
nothing about the rest of the run.

**Not a compressor model.** This package calls no model. There is no compressor,
no encoder, and no learned anything — it slices a byte array and hashes it.

**Not semantic compression.** Nothing is scored for relevance. The first N bytes
are the first N bytes, chosen by counting and nothing else, which is exactly why
the output is reproducible.

**Not a summarizer.** The prefix is a prefix. It is not a précis, an abstract, or
a rewrite; it is the literal opening of the result with the tail missing, and the
`truncated` flag says so.

**Not a silent truncate.** This is the failure mode the package exists to avoid.
A cap that quietly shortened a result would hand a model something that looks
like a whole answer with its ending gone, and nothing downstream could tell. Every
shortened result here is labelled, sized, and hashed.

**Not a quota.** It does not count calls, deny anything, or fail a run.

## Compared with `dsh-tool-quota`

[`dsh-tool-quota`][quota] caps result bytes too, and does the opposite thing with
the ones over the cap: it **throws** `TOOL_QUOTA_BYTES` and discards the result
whole, never truncating. This package truncates and continues.

Pick by what should happen when a tool returns too much:

| | over the cap |
| --- | --- |
| `dsh-tool-quota` | the call fails, `TOOL_QUOTA_BYTES`, nothing is returned |
| `dsh-result-cap` | a labelled prefix is returned, the run continues |

They compose. Install both with this row after the quota's and the quota's byte
cap becomes a ceiling that a capped result can no longer reach — set
`maxResultBytes` above `maxBytes` and the quota fires only on the shapes this
plugin passes through, like an oversized binary result.

## What gets capped

**v1 caps strings only.** Two shapes:

- a **bare string** result, and
- the **`text` field** of a result object, when it is an own, enumerable string.

Everything else passes through untouched: numbers, booleans, `null`, arrays,
`Buffer`s, typed arrays, images, `{ mimeType, data }` media, and any object with
no string `text`. There is no useful prefix of a PNG, and inventing one would
corrupt the result rather than shorten it. Arbitrary objects are never
JSON-stringified to be measured, either — a nested giant string is left alone
rather than approximated.

The cap is counted in **UTF-8 bytes**, not characters and not JavaScript string
length. `'€'.repeat(20)` is 20 code units and 60 bytes; under a 30-byte cap ten
euro signs survive.

## Install

```sh
dsh plugin --profile default add github:jwilson411/dsh-result-cap
```

The installer reads `dsh.bundle.patch` from the package manifest and appends this
package to the profile's ordered bundle list. Its `cordis.patch.yml` carries one
insert row, `id: result-cap`, with empty config — so the package default of 8192
bytes applies until a profile says otherwise.

Pin the tools package at **`0.1.1-rc.2`**; that is the release candidate this
plugin is developed and tested against.

## Configure

One key.

```yaml
- id: result-cap
  config:
    maxBytes: 32000
```

`maxBytes` is how many UTF-8 bytes of a result reach the conversation. It
defaults to **8192** — a few pages of text: large enough that an ordinary tool
result is never touched, small enough that a tool which fetched a whole page
cannot spend a context window by accident.

It must be an integer of at least **1**. A quoted `"8192"` is accepted, because
YAML quoting is an easy accident. A float, a negative, a zero, a boolean, or a
word is **rejected when the plugin applies** — with an
`InvalidResultCapConfigError` carrying `code: 'RESULT_CAP_CONFIG'` — rather than
quietly replaced with the default. So is an unknown key: `maxByte: 200` fails
loudly instead of meaning 8192 forever. A cap nobody can see is worse than a
profile that refuses to start.

Note that an id-targeted patch **replaces** the row's whole `config` block rather
than merging into it, so an override must restate every key it means to keep.

### Environment

`DSH_RESULT_CAP_MAX_BYTES` sets the cap for a deployment that never edited its
profile. Precedence is **config, then environment, then the default**: what a
profile author wrote down and reviewed wins over whatever some shell three layers
up happened to export. An unusable value in the variable is rejected the same way
an unusable one in the config is.

## Use it directly

The cap is a plain function, exported from the package root and from
`dsh-result-cap/cap`:

```js
import { capResult } from 'dsh-result-cap'

capResult('short enough', 8192)
// → 'short enough'   (the same string, unchanged)

capResult('x'.repeat(20000), 8192)
// → { text: 'xxxx…', truncated: true, omitted_bytes: 11808, sha256: '…' }
```

No context, no registry, no plugin — useful for testing, and for a host that
wants the cap somewhere other than the tool boundary.

## How it wires in

Two seams, so both ways a tool gets called are covered:

- **`ctx.tools.register`** is patched, so every definition registered for the
  lifetime of this fiber returns capped results. The registry's own disposer is
  passed straight back, so ownership and reload cleanup stay where they were.
- **`ctx.tools.execute`** is patched when the runtime exposes it, which catches a
  tool registered before this plugin started. Optional on purpose: a runtime
  without a public `execute` is covered by the register patch alone, and no
  private API is reached for.

A call passing through both is capped twice and shortened once — the inner
wrapper produces a value already under the cap, and capping a value that fits
returns it unchanged.

The cap runs **after** the tool body returns. A thrown error travels untouched: an
error is not a result, and swallowing one here would turn a tool failure into a
short success. A definition with no callable `execute` is registered untouched.
Both patches are undone on dispose when the context offers the hook.

No model-facing tool is registered. **v1 has no way to ask for the tail** — the
`sha256` is there so the omission is identifiable, not so it can be undone. If
the tail matters, raise the cap or ask the tool for less.

## Develop

```sh
npm install
npm test
```

`node:test`, no network, no API key, no weights, no fixtures to download.

## License

MIT © 2026 jwilson411. See [LICENSE](LICENSE).

[dsh]: https://github.com/deepseek-ai
[quota]: https://github.com/jwilson411/dsh-tool-quota
