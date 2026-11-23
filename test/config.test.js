import { describe, expect, test } from "bun:test"
import {
  DEFAULT_OPTIONS,
  connectionEntries,
  keelCandidates,
  modelIds,
  normalizeLoopbackUrl,
  normalizeOptions,
  safeError,
} from "../src/config.js"

describe("configuration", () => {
  test("uses defaults and validates numeric options", () => {
    expect(normalizeOptions()).toMatchObject(DEFAULT_OPTIONS)
    expect(normalizeOptions({ pollMs: 500, requestTimeoutMs: 2000 })).toMatchObject({
      pollMs: 500, requestTimeoutMs: 2000,
    })
    expect(normalizeOptions({ pollMs: -1, requestTimeoutMs: 1.5 })).toMatchObject({
      pollMs: 1000, requestTimeoutMs: 4000,
    })
  })

  test("accepts only loopback HTTP endpoints without paths or credentials", () => {
    expect(normalizeLoopbackUrl("http://127.0.0.1:22343/")).toBe("http://127.0.0.1:22343")
    expect(normalizeLoopbackUrl("http://[::1]:22343")).toBe("http://[::1]:22343")
    for (const value of [
      "https://127.0.0.1:22343", "http://example.com", "http://192.168.1.2:22343",
      "http://127.999.1.1", "http://user@127.0.0.1:22343", "http://127.0.0.1:22343/api",
      "http://127.0.0.1:22343?x=1", "not a URL",
    ]) expect(() => normalizeLoopbackUrl(value)).toThrow()
  })

  test("uses the current Hong Cowork port order, then legacy Keel ports", () => {
    expect(keelCandidates("")).toEqual([
      "http://127.0.0.1:21343", "http://127.0.0.1:21342",
      "http://127.0.0.1:21340", "http://127.0.0.1:21341",
      "http://127.0.0.1:22343", "http://127.0.0.1:22342",
      "http://127.0.0.1:22340", "http://127.0.0.1:22341",
    ])
  })
})

describe("Agent connection", () => {
  const snapshot = {
    "models:enabled-provider-ids": '["existing"]',
    "models:disabled-provider-ids": '["magpie-id","other-off"]',
    "models:enabled-models-per-provider": '{"existing":["one"]}',
    "models:active-provider-id": "existing",
    "models:active-model-id": "one",
  }

  test("enables Magpie and selects the model picked on Magpie's Agent row", () => {
    const entries = connectionEntries(snapshot, "magpie-id", ["openai/gpt-5"], "openai/gpt-5")
    expect(entries).toEqual([
      { key: "models:enabled-provider-ids", value: '["existing","magpie-id"]' },
      { key: "models:disabled-provider-ids", value: '["other-off"]' },
      { key: "models:enabled-models-per-provider", value: '{"existing":["one"],"magpie-id":["openai/gpt-5"]}' },
      { key: "models:active-provider-id", value: JSON.stringify("magpie-id") },
      { key: "models:active-model-id", value: JSON.stringify("openai/gpt-5") },
    ])
  })

  test("is idempotent and preserves an existing model allowlist", () => {
    expect(connectionEntries({
      "models:enabled-provider-ids": '["magpie-id"]',
      "models:disabled-provider-ids": "[]",
      "models:enabled-models-per-provider": '{"magpie-id":["chosen"]}',
      "models:active-provider-id": "magpie-id",
      "models:active-model-id": "chosen",
    }, "magpie-id", ["chosen", "new-model"], "chosen")).toEqual([])
  })

  test("adds a newly selected model to a restrictive allowlist", () => {
    const entries = connectionEntries({
      "models:enabled-provider-ids": '["magpie-id"]',
      "models:disabled-provider-ids": "[]",
      "models:enabled-models-per-provider": '{"magpie-id":["chosen"]}',
      "models:active-provider-id": "magpie-id",
      "models:active-model-id": "chosen",
    }, "magpie-id", ["chosen", "new-model"], "new-model")
    expect(entries).toEqual([
      { key: "models:enabled-models-per-provider", value: '{"magpie-id":["chosen","new-model"]}' },
      { key: "models:active-model-id", value: JSON.stringify("new-model") },
    ])
  })

  test("accepts missing optional keys in an existing Keel configuration", () => {
    const entries = connectionEntries({
      "models:enabled-provider-ids": '["old-provider"]',
      "models:enabled-models-per-provider": '{"old-provider":["old-model"]}',
    }, "magpie-id", ["kimi-code-cn/k3.1-pro"], "kimi-code-cn/k3.1-pro")
    expect(entries).toContainEqual({ key: "models:active-provider-id", value: JSON.stringify("magpie-id") })
    expect(entries).toContainEqual({ key: "models:active-model-id", value: JSON.stringify("kimi-code-cn/k3.1-pro") })
  })

  test("treats JSON-encoded active values from Hong Cowork 0.146 as already applied", () => {
    expect(connectionEntries({
      "models:enabled-provider-ids": '["magpie-id"]',
      "models:disabled-provider-ids": "[]",
      "models:enabled-models-per-provider": '{"magpie-id":["chosen"]}',
      "models:active-provider-id": JSON.stringify("magpie-id"),
      "models:active-model-id": JSON.stringify("chosen"),
    }, "magpie-id", ["chosen"], "chosen")).toEqual([])
  })

  test("fails closed on malformed configuration", () => {
    expect(() => connectionEntries({ "models:enabled-provider-ids": "bad" }, "id", ["m"], "m")).toThrow(/malformed/)
  })
})

test("model IDs exclude non-chat entries and errors hide credentials", () => {
  expect(modelIds([{ id: "chat" }, { id: "image", kind: "image" }, { id: "chat" }])).toEqual(["chat"])
  const error = safeError(new Error("Authorization: Bearer secret-token user@example.com"))
  expect(error).not.toContain("secret-token")
  expect(error).not.toContain("user@example.com")
})
