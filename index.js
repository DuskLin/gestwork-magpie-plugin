import path from "node:path"
import { normalizeOptions } from "./src/config.js"
import { KeelAdapter } from "./src/adapter.js"

const instance = Symbol.for("magpie.gestaworks.adapter.v1")

export async function server(input, rawOptions) {
  let options
  try {
    options = normalizeOptions(rawOptions)
  } catch (error) {
    await input?.client?.app?.log?.({
      body: { level: "error", service: "gestaworks", message: error.message },
    })
    options = normalizeOptions({})
  }
  const logger = (level, message) => {
    void input?.client?.app?.log?.({ body: { level, service: "gestaworks", message } })?.catch?.(() => {})
  }
  if (!globalThis[instance]) {
    const file = path.join(input.directory, "..", "magpie-gestaworks", "connection.json")
    const adapter = new KeelAdapter({ file, options, logger })
    globalThis[instance] = adapter
    await adapter.start()
  } else {
    globalThis[instance].options = options
  }
  return {}
}

export const _internal = { normalizeOptions }

export default { id: "gestaworks", server }
