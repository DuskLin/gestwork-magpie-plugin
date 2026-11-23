import { describe, expect, test } from "bun:test"
import { mergeRegistryOverlay, registryEntry, registryPayload } from "../src/model-metadata.js"

const kimi = {
  id: "kimi-code-cn/k3.1-pro",
  display_name: "K3.1 Pro",
  owned_by: "kimi-code-cn",
  context_window: 1048576,
  max_input_tokens: 1048576,
  max_output_tokens: 32768,
  modalities: { input: ["text", "image", "video"] },
  reasoning: true,
  supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
  tool_call: true,
}

describe("Magpie model metadata", () => {
  test("preserves display name, exact context and capabilities", () => {
    const entry = registryEntry(kimi)
    expect(entry.displayName).toBe("K3.1 Pro")
    expect(entry.vendor).toBe("moonshot")
    expect(entry.family).toBe("kimi")
    expect(entry.capabilities).toMatchObject({
      contextWindow: 1048576,
      maxOutputTokens: 32768,
      supportsVision: true,
      supportsExtendedThinking: true,
      supportsToolUse: true,
    })
    expect(entry.capabilities.maxInputTokens).toBeUndefined()
    expect(entry.capabilities.reasoningEffort).toEqual({
      levels: ["low", "high", "max"], defaultLevel: "high",
    })
  })

  test("uses each provider's context rather than a builtin model fallback", () => {
    const entry = registryEntry({
      ...kimi,
      id: "sub2api/gpt-6.2-sol",
      display_name: "GPT-6.2 Sol",
      owned_by: "sub2api",
      context_window: 500000,
      max_input_tokens: 500000,
      max_output_tokens: 128000,
    })
    expect(entry.displayName).toBe("GPT-6.2 Sol")
    expect(entry.capabilities.contextWindow).toBe(500000)
    expect(entry.capabilities.maxOutputTokens).toBe(128000)
  })

  test("maps Magpie token prices to Keel per-million prices", () => {
    const entry = registryEntry({
      ...kimi,
      pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" },
    })
    expect(entry.pricing).toEqual({
      inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2,
    })
  })

  test("merges with existing registry entries instead of replacing them", () => {
    const existing = JSON.stringify({
      payload: { version: "vendor", models: { "vendor/model": { displayName: "Vendor" } } },
      fetchedAt: 1,
    })
    const stored = JSON.parse(mergeRegistryOverlay(existing, [kimi], 1234))
    expect(stored.payload.version).toMatch(/^magpie-/)
    expect(stored.payload.models["vendor/model"]).toEqual({ displayName: "Vendor" })
    expect(stored.payload.models[kimi.id].displayName).toBe("K3.1 Pro")
    expect(stored.fetchedAt).toBe(1234)
  })

  test("creates deterministic versions for identical catalogs", () => {
    expect(registryPayload([kimi]).version).toBe(registryPayload([{ ...kimi }]).version)
    expect(registryPayload([kimi]).version).not.toBe(registryPayload([{ ...kimi, context_window: 500000 }]).version)
  })
})
