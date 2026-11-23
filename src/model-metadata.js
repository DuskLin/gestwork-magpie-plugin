import { createHash } from "node:crypto"

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]

const integer = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
const perMillion = (value) => Math.round(Number(value) * 1e12) / 1e6

export function modelFamily(id) {
  const value = id.toLowerCase()
  if (/claude.*opus/.test(value)) return "claude-opus"
  if (/claude.*sonnet/.test(value)) return "claude-sonnet"
  if (/claude.*haiku/.test(value)) return "claude-haiku"
  if (/kimi|k2\.|k3\./.test(value)) return "kimi"
  if (/deepseek/.test(value)) return "deepseek-chat"
  if (/grok/.test(value)) return "grok"
  if (/gemini.*flash/.test(value)) return "gemini-flash"
  if (/gemini/.test(value)) return "gemini-pro"
  if (/qwen/.test(value)) return "qwen"
  if (/glm/.test(value)) return "glm"
  if (/minimax/.test(value)) return "minimax"
  if (/gpt-6/.test(value)) return "gpt-6"
  if (/gpt-5.*mini/.test(value)) return "gpt-5-mini"
  if (/gpt-5/.test(value)) return "gpt-5"
  if (/gpt-4.*mini/.test(value)) return "gpt-4-mini"
  if (/gpt-4/.test(value)) return "gpt-4"
  return "unknown"
}

export function modelVendor(model) {
  const owner = String(model.owned_by || "").toLowerCase()
  const id = String(model.id || "").toLowerCase()
  const value = `${owner}/${id}`
  if (/anthropic|claude/.test(value)) return "anthropic"
  if (/openai|codex|gpt-|(?:^|\/)o[134](?:-|$)/.test(value)) return "openai"
  if (/google|gemini/.test(value)) return "google"
  if (/deepseek/.test(value)) return "deepseek"
  if (/moonshot|kimi/.test(value)) return "moonshot"
  if (/minimax/.test(value)) return "minimax"
  if (/alibaba|qwen/.test(value)) return "alibaba"
  if (/zhipu|glm/.test(value)) return "zhipu"
  if (/xai|grok/.test(value)) return "xai"
  return "unknown"
}

export function reasoningEffort(model) {
  const raw = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map((level) => level?.effort)
    : Array.isArray(model.reasoning_levels) ? model.reasoning_levels : []
  const levels = EFFORTS.filter((effort) => raw.includes(effort))
  if (levels.length < 2) return undefined
  const defaultLevel = levels.includes("medium") ? "medium" : levels.includes("high") ? "high" : levels[0]
  return { levels, defaultLevel }
}

export function registryEntry(model) {
  if (!model || typeof model.id !== "string" || !model.id) throw new Error("A Magpie model has no id")
  const contextWindow = integer(model.context_window ?? model.context_length, 200000)
  const maxOutputTokens = Math.min(integer(model.max_output_tokens, 32768), contextWindow)
  const declaredInput = integer(model.max_input_tokens, contextWindow)
  const inputs = Array.isArray(model.modalities?.input) ? model.modalities.input : []
  const supportsReasoning = model.reasoning === true
  const definition = {
    family: modelFamily(model.id),
    vendor: modelVendor(model),
    tier: "flagship",
    categories: supportsReasoning ? ["chat", "reasoning"] : ["chat"],
    displayName: typeof model.display_name === "string" && model.display_name.trim()
      ? model.display_name.trim()
      : model.id.split("/").at(-1),
    capabilities: {
      contextWindow,
      ...(declaredInput < contextWindow ? { maxInputTokens: declaredInput } : {}),
      autoCompactContextPercentage: 80,
      maxOutputTokens,
      supportsVision: inputs.includes("image") || inputs.includes("video"),
      supportsAudioInput: inputs.includes("audio"),
      supportsToolUse: model.tool_call !== false,
      supportsExtendedThinking: supportsReasoning,
      supportsAdaptiveThinking: supportsReasoning,
      supportsStreaming: true,
      supportsImageGeneration: false,
      supportsVideoGeneration: false,
      supportsStructuredOutput: true,
      ...(reasoningEffort(model) ? { reasoningEffort: reasoningEffort(model) } : {}),
    },
    status: "available",
  }
  const pricing = model.pricing
  if (pricing && Number.isFinite(Number(pricing.prompt)) && Number.isFinite(Number(pricing.completion))) {
    definition.pricing = {
      inputPerMillion: perMillion(pricing.prompt),
      outputPerMillion: perMillion(pricing.completion),
      ...(Number.isFinite(Number(pricing.input_cache_write))
        ? { cacheWritePerMillion: perMillion(pricing.input_cache_write) } : {}),
      ...(Number.isFinite(Number(pricing.input_cache_read))
        ? { cacheReadPerMillion: perMillion(pricing.input_cache_read) } : {}),
    }
  }
  return definition
}

export function registryPayload(models) {
  const entries = {}
  for (const model of models) {
    if (!model || typeof model.id !== "string" || !model.id || model.kind && model.kind !== "chat") continue
    entries[model.id] = registryEntry(model)
  }
  if (!Object.keys(entries).length) throw new Error("Magpie returned no usable model metadata")
  const canonical = JSON.stringify(entries)
  return {
    version: `magpie-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`,
    models: entries,
  }
}

export function mergeRegistryOverlay(existingValue, models, now = Date.now()) {
  let existing = {}
  if (existingValue) {
    try {
      const stored = JSON.parse(existingValue)
      existing = stored.payload && typeof stored.payload === "object" ? stored.payload : stored
    } catch { /* Replace only an unreadable overlay; valid entries are preserved below. */ }
  }
  const payload = registryPayload(models)
  const merged = {
    ...existing,
    ...payload,
    models: { ...(existing.models || {}), ...payload.models },
    fetchedAt: now,
  }
  delete merged.patches
  return JSON.stringify({ payload: merged, fetchedAt: now })
}
