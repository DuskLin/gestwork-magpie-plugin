export const DEFAULT_OPTIONS = Object.freeze({
  keelUrl: "",
  pollMs: 1000,
  requestTimeoutMs: 4000,
})

// Current Hong Cowork CLI order, then the legacy Keel 223xx ports.
export const KEEL_PORTS = Object.freeze([21343, 21342, 21340, 21341, 22343, 22342, 22340, 22341])

const integer = (value, fallback, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback

export function normalizeOptions(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  return {
    keelUrl: input.keelUrl ? normalizeLoopbackUrl(input.keelUrl, "Keel address") : "",
    pollMs: integer(input.pollMs, DEFAULT_OPTIONS.pollMs, 250, 10000),
    requestTimeoutMs: integer(input.requestTimeoutMs, DEFAULT_OPTIONS.requestTimeoutMs, 500, 15000),
  }
}

export function normalizeLoopbackUrl(value, label = "Address") {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTP URL`)
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new Error(`${label} must use HTTP on localhost or a loopback IP`)
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must contain only a scheme, host and optional port`)
  }
  return url.origin
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
    (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255))
}

export function keelCandidates(configuredUrl) {
  if (configuredUrl) return [normalizeLoopbackUrl(configuredUrl, "Keel address")]
  return KEEL_PORTS.map((port) => `http://127.0.0.1:${port}`)
}

export function modelIds(models) {
  if (!Array.isArray(models)) return []
  return [...new Set(models.map((model) => {
    if (typeof model === "string") return model.trim()
    if (!model || typeof model !== "object") return ""
    if (model.kind && model.kind !== "chat") return ""
    return typeof model.id === "string" ? model.id.trim() : ""
  }).filter(Boolean))]
}

export function parseStringArray(value) {
  if (value === undefined || value === null || value === "") return undefined
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return undefined
    return [...new Set(parsed)]
  } catch {
    return undefined
  }
}

export function parseModelMap(value) {
  if (value === undefined || value === null || value === "") return undefined
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const result = {}
    for (const [provider, models] of Object.entries(parsed)) {
      if (Array.isArray(models) && models.every((model) => typeof model === "string")) {
        result[provider] = [...new Set(models)]
      }
    }
    return result
  } catch {
    return undefined
  }
}

export function modelMapEntry(modelMap, providerId) {
  const wanted = String(providerId).trim().toLowerCase()
  const key = Object.keys(modelMap).find((candidate) => candidate.trim().toLowerCase() === wanted)
  return key === undefined ? undefined : modelMap[key]
}

export function connectionEntries(snapshot, providerId, models, selectedModel) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Keel returned an invalid model configuration")
  }
  const enabled = parseStringArray(snapshot["models:enabled-provider-ids"]) ?? []
  const disabled = parseStringArray(snapshot["models:disabled-provider-ids"]) ?? []
  const modelMap = parseModelMap(snapshot["models:enabled-models-per-provider"]) ?? {}
  for (const [key, value, valid] of [
    ["models:enabled-provider-ids", snapshot["models:enabled-provider-ids"], parseStringArray(snapshot["models:enabled-provider-ids"])],
    ["models:disabled-provider-ids", snapshot["models:disabled-provider-ids"], parseStringArray(snapshot["models:disabled-provider-ids"])],
    ["models:enabled-models-per-provider", snapshot["models:enabled-models-per-provider"], parseModelMap(snapshot["models:enabled-models-per-provider"])],
  ]) {
    if (value !== undefined && value !== null && value !== "" && valid === undefined) {
      throw new Error(`Keel's ${key} configuration is malformed; nothing was changed`)
    }
  }
  const entries = []
  const put = (key, value) => entries.push({ key, value: JSON.stringify(value) })
  if (!enabled.includes(providerId)) put("models:enabled-provider-ids", [...enabled, providerId])
  if (disabled.includes(providerId)) {
    put("models:disabled-provider-ids", disabled.filter((id) => id !== providerId))
  }
  const currentModels = modelMapEntry(modelMap, providerId)
  if (currentModels === undefined) {
    put("models:enabled-models-per-provider", { ...modelMap, [providerId]: models })
  } else if (currentModels.length > 0 && !currentModels.includes(selectedModel)) {
    const next = { ...modelMap }
    const key = Object.keys(next).find((id) => id.trim().toLowerCase() === providerId.toLowerCase())
    next[key] = [...currentModels, selectedModel]
    put("models:enabled-models-per-provider", next)
  }
  if (decodeConfigScalar(snapshot["models:active-provider-id"]) !== providerId) {
    entries.push({ key: "models:active-provider-id", value: encodeConfigScalar(providerId) })
  }
  if (decodeConfigScalar(snapshot["models:active-model-id"]) !== selectedModel) {
    entries.push({ key: "models:active-model-id", value: encodeConfigScalar(selectedModel) })
  }
  return entries
}

// Hong Cowork 0.146 stores every model-config value as JSON text. Older
// builds stored a bare provider or model id, which JSON.parse rejects.
export function decodeConfigScalar(value) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") return null
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed === "string") return parsed
  } catch { /* Legacy raw id. */ }
  return value
}

export function encodeConfigScalar(value) {
  return value === null ? null : JSON.stringify(value)
}

export function restorationEntries(snapshot, backup) {
  if (!backup || typeof backup !== "object") return []
  const entries = []
  for (const key of ["models:active-provider-id", "models:active-model-id"]) {
    if (!Object.hasOwn(backup, key)) continue
    const value = backup[key]
    if (value !== null && typeof value !== "string") continue
    if ((snapshot[key] ?? null) !== value) entries.push({ key, value })
  }
  return entries
}

export function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(authorization|api[-_ ]?key|token)(["'\s:=]+)[^\s,"'}]+/gi, "$1$2[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[redacted]")
    .slice(0, 500)
}
