import { keelCandidates, normalizeLoopbackUrl, safeError } from "./config.js"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export class KeelError extends Error {
  constructor(message, { code = "keel", status = 0, cause } = {}) {
    super(message, { cause })
    this.name = "KeelError"
    this.code = code
    this.status = status
  }
}

async function responseJson(response) {
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES) throw new KeelError("Keel's response was too large")
    return parseJson(text)
  }
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new KeelError("Keel's response was too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return parseJson(new TextDecoder().decode(bytes))
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new KeelError("Keel returned a non-JSON response", { code: "invalid_response" })
  }
}

export class KeelClient {
  constructor(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
    this.baseUrl = normalizeLoopbackUrl(baseUrl, "Keel address")
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async request(path, { method = "GET", body, timeoutMs = this.timeoutMs } = {}) {
    const target = new URL(path, this.baseUrl)
    if (target.origin !== this.baseUrl) throw new KeelError("Keel request left its loopback origin")
    let response
    try {
      response = await this.fetch(target, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": "gestwork-magpie-plugin/0.1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new KeelError(`Cannot reach Keel at ${this.baseUrl}: ${safeError(error)}`, {
        code: "unavailable",
        cause: error,
      })
    }
    const payload = await responseJson(response)
    if (!response.ok) {
      throw new KeelError(`Keel answered HTTP ${response.status}`, {
        code: "http",
        status: response.status,
      })
    }
    return payload
  }

  async health() {
    const result = await this.request("/healthz")
    if (result?.status !== "ok") throw new KeelError("The service is not Keel", { code: "not_keel" })
    return result
  }

  async call(procedure, input, { query = false, timeoutMs } = {}) {
    const envelope = input === undefined ? { json: null } : { json: input }
    const path = query
      ? `/${procedure}?input=${encodeURIComponent(JSON.stringify(envelope))}`
      : `/${procedure}`
    const payload = await this.request(path, {
      method: query ? "GET" : "POST",
      body: query ? undefined : envelope,
      timeoutMs,
    })
    const replies = Array.isArray(payload) ? payload : [payload]
    const reply = replies[0]
    if (reply?.error) {
      const message = reply.error.json?.message ?? reply.error.message ?? "Keel rejected the request"
      throw new KeelError(String(message), { code: "trpc" })
    }
    if (!reply?.result?.data || !("json" in reply.result.data)) {
      throw new KeelError(`Keel returned an invalid ${procedure} response`, { code: "invalid_response" })
    }
    return reply.result.data.json
  }

  async listProviders() {
    const providers = await this.call("providers.list", undefined, { query: true })
    if (!Array.isArray(providers)) throw new KeelError("The service is not Keel", { code: "not_keel" })
    return providers
  }

  async addMagpie(baseUrl, apiKey) {
    const result = await this.call("providers.addCustom", {
      name: "Magpie",
      baseUrl,
      apiKey,
      skipValidation: false,
      protocol: "openai-completions",
      authStyle: "bearer",
    }, { timeoutMs: Math.max(this.timeoutMs, 15000) })
    if (!result?.success || typeof result.id !== "string" || !result.id) {
      throw new KeelError(result?.error || "Keel could not add the Magpie provider", { code: "add_failed" })
    }
    return result.id
  }

  async getModelCatalog(providerId, forceRefresh = true) {
    const result = await this.call("providers.getModels", { providerId, forceRefresh }, {
      query: true,
      timeoutMs: Math.max(this.timeoutMs, 15000),
    })
    if (!result || !Array.isArray(result.models)) {
      throw new KeelError("Keel returned an invalid model list", { code: "invalid_response" })
    }
    if (result.error && result.models.length === 0) {
      throw new KeelError(String(result.error), { code: "models_failed" })
    }
    return result.models
  }

  async getModels(providerId, forceRefresh = true) {
    return this.getModelCatalog(providerId, forceRefresh)
  }

  async getModelConfig() {
    return this.call("providers.getModelConfig", undefined, { query: true })
  }

  async setModelConfig(entries) {
    if (!entries.length) return { success: true, changed: false }
    const result = await this.call("providers.setModelConfig", { entries })
    if (!result?.success) throw new KeelError("Keel did not save the model configuration")
    return { success: true, changed: true }
  }
}

export async function discoverKeel({
  configuredUrl = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
} = {}) {
  let lastError
  for (const candidate of keelCandidates(configuredUrl)) {
    const client = new KeelClient(candidate, { fetchImpl, timeoutMs })
    try {
      await client.health()
      await client.listProviders()
      return client
    } catch (error) {
      lastError = error
      if (configuredUrl) break
    }
  }
  throw new KeelError(
    configuredUrl
      ? `Keel is not available at ${configuredUrl}: ${safeError(lastError)}`
      : "Keel is not running. Start Keel/GestaWorks; the plugin will retry automatically.",
    { code: "unavailable", cause: lastError },
  )
}
