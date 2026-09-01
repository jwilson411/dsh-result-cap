/**
 * Shared stubs. Everything here is offline and synchronous.
 *
 * The context stub exposes only `tools.register` — the minimum the plugin is
 * allowed to assume — so the suite proves the mandatory path works on a registry
 * that offers nothing else. A second stub adds `tools.execute` for the tests
 * that exercise the optional seam, and the two are deliberately separate: if the
 * plugin ever grew a dependency on `execute` being present, the first stub would
 * fail rather than the suite quietly covering only the rich shape.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * A context stub exposing only what `apply` is required to work against.
 * @returns The stub context, the definitions it recorded, and its disposers.
 */
export function stubContext() {
  const registered = []
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    on(event, listener) {
      disposers.push({ event, listener })
      return () => {}
    },
  }
  return { ctx, registered, disposers }
}

/**
 * A richer stub that also dispatches: `tools.execute` looks a registered
 * definition up by name and calls it, the way the real runtime does.
 * @returns The stub context, its definition map, and a body-call counter.
 */
export function dispatchingContext() {
  const definitions = new Map()
  const calls = { body: 0 }
  const ctx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
      async execute(input) {
        const definition = definitions.get(input.name)
        if (definition === undefined) throw new Error(`unknown tool ${input.name}`)
        calls.body += 1
        return definition.execute(input.arguments, { ...input })
      },
    },
  }
  return { ctx, definitions, calls }
}

/** The execution context the registry passes to `execute`; these tools ignore it. */
export const exec = { signal: new AbortController().signal }

/**
 * A tool whose body returns whatever the test tells it to.
 *
 * The payload is a thunk rather than a value so a test can return a fresh object
 * per call and prove the cap did not mutate a shared one, and so a test can make
 * the body throw.
 * @param name - The tool name to register under.
 * @param payload - Called per invocation; its return value is the tool result.
 * @returns The definition and its live call count.
 */
export function stubTool(name = 'search', payload = () => 'ok') {
  const calls = { count: 0, lastArgs: null }

  const definition = defineTool({
    name,
    description: 'A tool that returns what the test chose, for tests.',
    parameters: {
      // No `required` key: the RC only accepts `required: true` when the field
      // is present at all, and these tests drive `execute` directly rather than
      // through the registry's argument validation.
      q: { type: 'string', description: 'Anything at all.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Whatever came back.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    execute(args) {
      calls.count += 1
      calls.lastArgs = args
      return Promise.resolve(payload(calls.count))
    },
  })

  return { definition, calls }
}
