import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mergeRegistryOverlay } from "./model-metadata.js"

const APP_NAMES = {
  22343: "Keel-本地开发",
  22342: "Keel-开发版",
  22340: "Keel",
  22341: "Keel",
  22350: "Keel-公开版",
}

// Hong Cowork 0.146 listens on 213xx. The directory is the app's userData name.
const CURRENT_APP_NAMES = {
  21343: ["Hong Cowork-本地开发", "Keel-本地开发", "Cowork-本地开发", "Hong Cowork-开发版"],
  21342: ["Hong Cowork-开发版", "Hong Cowork-Test", "Keel-开发版", "Keel-Test", "Cowork-开发版", "Hong"],
  21340: ["Hong Cowork", "Hong", "Hong Cowork-公开版", "Keel", "Keel-公开版", "Cowork", "Cowork-公开版"],
  21341: ["Hong Cowork", "Hong", "Keel"],
}

export function databaseCandidates(keelUrl, {
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const port = Number(new URL(keelUrl).port || 80)
  const currentNames = CURRENT_APP_NAMES[port]
  const appName = APP_NAMES[port]
  if (!currentNames && !appName) return []
  let base
  if (platform === "darwin") base = path.join(home, "Library", "Application Support")
  else if (platform === "win32") base = env.APPDATA
  else base = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  if (!base) return []
  if (currentNames) {
    const files = currentNames.map((name) => path.join(base, name, "data", "agents.db"))
    if (port === 21341) files.unshift(path.join(home, ".hong", "headless", "data", "agents.db"))
    return files
  }
  const legacyNames = {
    "Keel-本地开发": ["Cowork-本地开发", "Hong Cowork-开发版"],
    "Keel-开发版": ["Keel-Test", "Cowork-开发版", "Hong Cowork-开发版", "Hong"],
    "Keel": ["Keel-公开版", "Cowork", "Cowork-公开版", "Hong Cowork-公开版", "Hong"],
    "Keel-公开版": ["Cowork-公开版", "Hong Cowork-公开版"],
  }
  const names = [appName, ...(legacyNames[appName] || [])]
  return names.map((name) => path.join(base, name, "data", "agents.db"))
}

export function findDatabase(keelUrl, providerId, options) {
  for (const file of databaseCandidates(keelUrl, options)) {
    if (!fs.existsSync(file)) continue
    const db = new Database(file, { readonly: true })
    try {
      const row = db.query("SELECT id FROM model_providers WHERE id = ? AND base_url LIKE 'http://127.0.0.1:%/v1'").get(providerId)
      if (row) return file
    } catch { /* Try the next channel's archive. */ } finally {
      db.close()
    }
  }
  throw new Error("Could not find the Keel model archive for the running desktop app")
}

function backup(file, now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  const destination = `${file}.magpie-backup-${stamp}`
  const db = new Database(file, { readonly: true })
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  return destination
}

export function syncModelArchive({
  file,
  providerId,
  models,
  now = new Date(),
  createBackup = true,
}) {
  if (!file || !fs.existsSync(file)) throw new Error("Keel's model archive does not exist")
  const backupFile = createBackup ? backup(file, now) : null
  const db = new Database(file)
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const provider = db.query("SELECT id, name FROM model_providers WHERE id = ?").get(providerId)
    if (!provider || String(provider.name || "").trim().toLowerCase() !== "magpie") {
      throw new Error("The Magpie Provider is not in this Keel archive")
    }
    const previous = db.query("SELECT value FROM user_preferences WHERE key = 'model-registry-overlay'").get()
    const overlay = mergeRegistryOverlay(previous?.value, models, now.getTime())
    const timestamp = now.getTime()
    db.transaction(() => {
      db.query(`INSERT INTO user_preferences (key, value, updated_at) VALUES ('model-registry-overlay', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(overlay, timestamp)
      const update = db.query(`UPDATE cached_models SET name = ?, metadata = ?, cached_at = ?
        WHERE provider_id = ? AND model_id = ?`)
      const insert = db.query(`INSERT INTO cached_models
        (id, provider_id, model_id, name, category, metadata, cached_at) VALUES (?, ?, ?, ?, 'llm', ?, ?)`)
      for (const model of models) {
        if (!model || typeof model.id !== "string" || !model.id) continue
        const name = typeof model.display_name === "string" && model.display_name.trim()
          ? model.display_name.trim() : model.id.split("/").at(-1)
        const metadata = JSON.stringify({
          contextWindow: model.context_window ?? model.context_length,
          maxInputTokens: model.max_input_tokens,
          maxOutputTokens: model.max_output_tokens,
          modalities: model.modalities,
          reasoning: model.reasoning,
          supportedReasoningLevels: model.supported_reasoning_levels ?? model.reasoning_levels,
          toolCall: model.tool_call,
        })
        const result = update.run(name, metadata, timestamp, providerId, model.id)
        if (!result.changes) {
          insert.run(`magpie-${createId(model.id)}`, providerId, model.id, name, metadata, timestamp)
        }
      }
    })()
    return { backupFile, modelCount: models.length }
  } finally {
    db.close()
  }
}

function createId(value) {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 20)
  return `magpie-${digest}`
}
