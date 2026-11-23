import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeelAdapter, readConnection } from "../src/adapter.js"
import { normalizeOptions } from "../src/config.js"
import { agent, connect } from "../gestaworks.agent.js"

const connected = (model = "openai/gpt-5") => ({
  enabled: true,
  model,
  gateway: { url: "http://127.0.0.1:3425/v1", key: "magpie-gestaworks" },
  models: [{ id: "openai/gpt-5", name: "GPT-5" }, { id: "anthropic/claude", name: "Claude" }],
})

const testFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gestaworks-agent-")), "connection.json")
const testArchive = () => ({
  archive: () => {},
  locateArchive: () => "/tmp/test-agents.db",
  readCatalog: async () => [
    { id: "openai/gpt-5", display_name: "GPT-5", context_window: 400000 },
    { id: "anthropic/claude", display_name: "Claude", context_window: 200000 },
  ],
})

function fakeKeel() {
  const keel = {    baseUrl: "http://127.0.0.1:22343",
    addMagpie: mock(async () => "magpie-provider"),
    getModels: mock(async () => [{ id: "openai/gpt-5" }, { id: "anthropic/claude" }]),
    getModelConfig: mock(async () => ({ ...keel.snapshot })),
    setModelConfig: mock(async (entries) => {
      for (const entry of entries) {
        if (entry.key === "models:active-provider-id" || entry.key === "models:active-model-id") {
          keel.snapshot[entry.key] = entry.value
        }
      }
    }),
    snapshot: {
      "models:enabled-provider-ids": "[]",
      "models:disabled-provider-ids": "[]",
      "models:enabled-models-per-provider": "{}",
      "models:active-provider-id": "old-provider",
      "models:active-model-id": "old-model",
    },
  }
  return keel
}

describe("Magpie Agent declaration", () => {
  test("adds GestaWorks to the Agents page with a model field", () => {
    expect(agent).toMatchObject({ id: "gestaworks", name: "GestaWorks", model: "model", dir: "~/.keel" })
    expect(agent.config.endsWith("connection.json")).toBe(true)
  })

  test("connect writes the gateway, catalog and per-agent key", () => {
    expect(connect({
      gateway: { v1: "http://127.0.0.1:3425/v1", key: "magpie-gestaworks" },
      models: [{ id: "openai/gpt-5", name: "GPT-5", context: 1000 }],
    })).toEqual({
      enabled: true,
      gateway: { url: "http://127.0.0.1:3425/v1", key: "magpie-gestaworks" },
      models: [{ id: "openai/gpt-5", name: "GPT-5" }],
    })
  })
})

describe("connection file", () => {
  test("reads Magpie's selected model and handles a disconnected/missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gestaworks-agent-"))
    const file = path.join(dir, "connection.json")
    expect(readConnection(file).enabled).toBe(false)
    fs.writeFileSync(file, JSON.stringify(connected()))
    expect(readConnection(file)).toMatchObject({ enabled: true, model: "openai/gpt-5" })
    fs.writeFileSync(file, JSON.stringify({ enabled: false, model: "" }))
    expect(readConnection(file).enabled).toBe(false)
  })

  test("rejects malformed enabled connections", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gestaworks-agent-"))
    const file = path.join(dir, "connection.json")
    fs.writeFileSync(file, JSON.stringify({ enabled: true, model: "m", gateway: { url: "bad", key: "k" } }))
    expect(() => readConnection(file)).toThrow(/invalid/)
  })
})

describe("Keel adapter", () => {
  test("applies the Agent row's model to Keel", async () => {
    const keel = fakeKeel()
    const adapter = new KeelAdapter({
      file: testFile(), options: normalizeOptions(), read: () => connected(), discover: async () => keel, ...testArchive(),
    })
    await adapter.tick()
    expect(keel.addMagpie).toHaveBeenCalledWith("http://127.0.0.1:3425/v1", "magpie-gestaworks")
    expect(keel.setModelConfig).toHaveBeenCalledTimes(1)
    const entries = keel.setModelConfig.mock.calls[0][0]
    expect(entries).toContainEqual({ key: "models:active-provider-id", value: "magpie-provider" })
    expect(entries).toContainEqual({ key: "models:active-model-id", value: "openai/gpt-5" })
  })

  test("does not rewrite unchanged state and applies a model switch", async () => {
    const keel = fakeKeel()
    let desired = connected()
    const adapter = new KeelAdapter({
      file: testFile(), options: normalizeOptions(), read: () => desired, discover: async () => keel, ...testArchive(),
    })
    await adapter.tick()
    await adapter.tick()
    expect(keel.addMagpie).toHaveBeenCalledTimes(1)
    desired = connected("anthropic/claude")
    await adapter.tick()
    expect(keel.addMagpie).toHaveBeenCalledTimes(2)
    expect(keel.setModelConfig).toHaveBeenCalledTimes(2)
  })

  test("disconnect restores Keel's previous default Provider and model", async () => {
    const keel = fakeKeel()
    let desired = connected()
    const adapter = new KeelAdapter({
      file: testFile(), options: normalizeOptions(), read: () => desired, discover: async () => keel, ...testArchive(),
    })
    await adapter.tick()
    desired = { enabled: false, model: "", gateway: null, models: [] }
    await adapter.tick()
    expect(keel.addMagpie).toHaveBeenCalledTimes(1)
    expect(keel.setModelConfig).toHaveBeenCalledTimes(2)
    expect(keel.setModelConfig.mock.calls[1][0]).toEqual([
      { key: "models:active-provider-id", value: "old-provider" },
      { key: "models:active-model-id", value: "old-model" },
    ])
  })

  test("retries restoration after Keel becomes available", async () => {
    const keel = fakeKeel()
    let desired = connected()
    let offline = false
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gestaworks-agent-"))
    const adapter = new KeelAdapter({
      file: path.join(dir, "connection.json"), options: normalizeOptions(), read: () => desired, ...testArchive(),
      discover: async () => { if (offline) throw new Error("offline"); return keel },
    })
    await adapter.tick()
    desired = { enabled: false, model: "", gateway: null, models: [] }
    offline = true
    await adapter.tick()
    expect(adapter.backup).not.toBeNull()
    offline = false
    await adapter.tick()
    expect(adapter.backup).toBeNull()
    expect(keel.setModelConfig).toHaveBeenCalledTimes(2)
  })

  test("persists restoration state across adapter restarts", async () => {
    const keel = fakeKeel()
    let desired = connected()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gestaworks-agent-"))
    const file = path.join(dir, "connection.json")
    const first = new KeelAdapter({ file, options: normalizeOptions(), read: () => desired, discover: async () => keel, ...testArchive() })
    await first.tick()
    desired = { enabled: false, model: "", gateway: null, models: [] }
    const second = new KeelAdapter({ file, options: normalizeOptions(), read: () => desired, discover: async () => keel })
    await second.tick()
    expect(second.backup).toBeNull()
    expect(keel.setModelConfig).toHaveBeenCalledTimes(2)
  })

  test("retries after Keel becomes available", async () => {
    const keel = fakeKeel()
    let offline = true
    const adapter = new KeelAdapter({
      file: testFile(), options: normalizeOptions(), read: () => connected(), ...testArchive(),
      discover: async () => { if (offline) throw new Error("offline"); return keel },
    })
    await adapter.tick()
    expect(adapter.lastError).toBe("offline")
    offline = false
    await adapter.tick()
    expect(adapter.lastError).toBe("")
    expect(keel.addMagpie).toHaveBeenCalledTimes(1)
  })
})
