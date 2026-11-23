import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { databaseCandidates, findDatabase, syncModelArchive } from "../src/model-archive.js"

const model = {
  id: "kimi-code-cn/k3.1-pro",
  display_name: "K3.1 Pro",
  context_window: 1048576,
  max_input_tokens: 1048576,
  max_output_tokens: 32768,
  modalities: { input: ["text", "image"] },
  reasoning: true,
}

function archive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gestaworks-archive-"))
  const file = path.join(dir, "agents.db")
  const db = new Database(file)
  db.exec(`CREATE TABLE model_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL);
    CREATE TABLE cached_models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      name TEXT NOT NULL, category TEXT DEFAULT 'llm' NOT NULL, metadata TEXT, cached_at INTEGER);
    CREATE TABLE user_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);`)
  db.query("INSERT INTO model_providers VALUES ('magpie-id', 'Magpie', 'http://127.0.0.1:3425/v1')").run()
  db.query("INSERT INTO cached_models VALUES ('old', 'magpie-id', ?, ?, 'llm', NULL, 1)").run(model.id, model.id)
  db.query("INSERT INTO user_preferences VALUES ('other', 'keep', 1)").run()
  db.close()
  return file
}

describe("Keel model archive", () => {
  test("maps the running desktop port to its own channel archive", () => {
    expect(databaseCandidates("http://127.0.0.1:22342", { home: "/home/test", platform: "darwin" })).toEqual([
      "/home/test/Library/Application Support/Keel-开发版/data/agents.db",
      "/home/test/Library/Application Support/Keel-Test/data/agents.db",
      "/home/test/Library/Application Support/Cowork-开发版/data/agents.db",
      "/home/test/Library/Application Support/Hong Cowork-开发版/data/agents.db",
      "/home/test/Library/Application Support/Hong/data/agents.db",
    ])
    expect(databaseCandidates("http://127.0.0.1:22340", { home: "/home/test", platform: "darwin" })[0])
      .toBe("/home/test/Library/Application Support/Keel/data/agents.db")
    expect(databaseCandidates("http://127.0.0.1:21342", { home: "/home/test", platform: "darwin" })[0])
      .toBe("/home/test/Library/Application Support/Hong Cowork-开发版/data/agents.db")
    expect(databaseCandidates("http://127.0.0.1:21341", { home: "/home/test", platform: "darwin" })[0])
      .toBe("/home/test/.hong/headless/data/agents.db")
  })

  test("backs up and transactionally updates names, metadata and registry", () => {
    const file = archive()
    const result = syncModelArchive({ file, providerId: "magpie-id", models: [model], now: new Date("2026-11-23T10:00:00Z") })
    expect(fs.existsSync(result.backupFile)).toBe(true)
    const db = new Database(file, { readonly: true })
    const cached = db.query("SELECT * FROM cached_models WHERE provider_id='magpie-id'").get()
    expect(cached.name).toBe("K3.1 Pro")
    expect(JSON.parse(cached.metadata).contextWindow).toBe(1048576)
    const overlay = JSON.parse(db.query("SELECT value FROM user_preferences WHERE key='model-registry-overlay'").get().value)
    expect(overlay.payload.models[model.id].displayName).toBe("K3.1 Pro")
    expect(overlay.payload.models[model.id].capabilities.contextWindow).toBe(1048576)
    expect(db.query("SELECT value FROM user_preferences WHERE key='other'").get().value).toBe("keep")
    db.close()
  })

  test("refuses to modify an archive that does not own the Magpie Provider", () => {
    const file = archive()
    expect(() => syncModelArchive({ file, providerId: "another", models: [model], createBackup: false }))
      .toThrow(/not in this Keel archive/)
  })

  test("accepts the lowercase provider name created in Hong Cowork", () => {
    const file = archive()
    const db = new Database(file)
    db.query("UPDATE model_providers SET name = 'magpie'").run()
    db.close()
    expect(() => syncModelArchive({ file, providerId: "magpie-id", models: [model], createBackup: false })).not.toThrow()
  })
})
