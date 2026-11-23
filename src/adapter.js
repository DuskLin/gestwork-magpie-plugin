import fs from "node:fs"
import path from "node:path"
import { connectionEntries, decodeConfigScalar, modelIds, restorationEntries, safeError } from "./config.js"
import { discoverKeel } from "./keel-client.js"
import { findDatabase, syncModelArchive } from "./model-archive.js"

export function readConnection(file) {
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, model: "", gateway: null, models: [] }
    throw error
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("Magpie's GestaWorks connection file is invalid")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Magpie's GestaWorks connection file is invalid")
  }
  const enabled = value.enabled === true && typeof value.model === "string" && value.model.length > 0
  if (!enabled) return { enabled: false, model: "", gateway: null, models: [] }
  if (typeof value.gateway?.url !== "string" || typeof value.gateway?.key !== "string") {
    throw new Error("Magpie's GestaWorks connection is missing its gateway")
  }
  let baseUrl
  try {
    baseUrl = new URL(value.gateway.url)
  } catch {
    throw new Error("Magpie's GestaWorks gateway URL is invalid")
  }
  if (baseUrl.protocol !== "http:" || !/^\/v\d+\/?$/.test(baseUrl.pathname) ||
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("Magpie's GestaWorks gateway URL is invalid")
  }
  return {
    enabled: true,
    model: value.model,
    gateway: { url: value.gateway.url.replace(/\/$/, ""), key: value.gateway.key },
    models: modelIds(value.models),
  }
}

export class KeelAdapter {
  constructor({
    file,
    options,
    logger = () => {},
    discover = discoverKeel,
    read = readConnection,
    archive = syncModelArchive,
    locateArchive = findDatabase,
    readCatalog,
  }) {
    this.file = file
    this.options = options
    this.logger = logger
    this.discover = discover
    this.read = read
    this.archive = archive
    this.locateArchive = locateArchive
    this.readCatalog = readCatalog
    this.applied = ""
    this.backup = null
    this.providerId = null
    this.stateFile = `${file}.adapter-state.json`
    this.lastModel = null
    this.lastAppliedModel = null
    this.lastError = ""
    this.running = false
    this.dirty = false
    this.timer = null
    this.watcher = null
  }

  async tick() {
    if (this.running) {
      this.dirty = true
      return
    }
    this.running = true
    try {
      do {
        this.dirty = false
        await this.applyOnce()
      } while (this.dirty)
    } finally {
      this.running = false
    }
  }

  async applyOnce() {
    let desired
    try {
      desired = this.read(this.file)
      this.restoreBackup()
    } catch (error) {
      this.reportError(error)
      return
    }
    const fingerprint = JSON.stringify(desired)
    if (fingerprint === this.applied && (!this.backup || desired.enabled)) return
    try {
      if (!desired.enabled) {
        if (this.backup) {
          const keel = await this.discover({
            configuredUrl: this.options.keelUrl,
            timeoutMs: this.options.requestTimeoutMs,
          })
          const snapshot = await keel.getModelConfig()
          const activeProvider = decodeConfigScalar(snapshot["models:active-provider-id"])
          const activeModel = decodeConfigScalar(snapshot["models:active-model-id"])
          // A model the user picked in Keel after connecting is theirs. Only
          // roll back a selection that is still the one this adapter made.
          if (activeProvider !== this.providerId || activeModel !== this.lastAppliedModel) {
            this.backup = null
            this.providerId = null
            this.saveBackup()
            this.applied = fingerprint
            this.reportError("")
            return
          }
          const entries = restorationEntries(snapshot, this.backup)
          if (entries.length) await keel.setModelConfig(entries)
          this.backup = null
          this.providerId = null
          this.saveBackup()
        }
        this.applied = fingerprint
        this.reportError("")
        this.logger("info", "GestaWorks disconnected from Magpie; its previous model selection was restored")
        return
      }
      const keel = await this.discover({
        configuredUrl: this.options.keelUrl,
        timeoutMs: this.options.requestTimeoutMs,
      })
      const providerId = await keel.addMagpie(desired.gateway.url, desired.gateway.key)
      const catalog = this.readCatalog
        ? await this.readCatalog(desired.gateway)
        : await this.readMagpieCatalog(desired.gateway)
      const models = modelIds(catalog)
      if (!models.includes(desired.model)) {
        throw new Error(`The selected model ${desired.model} is not available in Magpie`)
      }
      const snapshot = await keel.getModelConfig()
      const archiveFile = this.locateArchive(keel.baseUrl, providerId)
      this.archive({ file: archiveFile, providerId, models: catalog })
      if (!this.backup) {
        this.backup = {
          "models:active-provider-id": snapshot["models:active-provider-id"] ?? null,
          "models:active-model-id": snapshot["models:active-model-id"] ?? null,
        }
        this.saveBackup()
      }
      const entries = connectionEntries(snapshot, providerId, models, desired.model)
      if (entries.length) await keel.setModelConfig(entries)
      this.providerId = providerId
      this.lastModel = desired.model
      this.lastAppliedModel = desired.model
      this.saveBackup()
      this.applied = fingerprint
      this.reportError("")
      this.logger("info", `GestaWorks is using Magpie model ${desired.model}`)
    } catch (error) {
      this.reportError(error)
    }
  }

  async readMagpieCatalog(gateway) {
    const response = await fetch(`${gateway.url}/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${gateway.key}` },
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(this.options.requestTimeoutMs, 15000)),
    })
    if (!response.ok) throw new Error(`Magpie's model catalog answered HTTP ${response.status}`)
    const payload = await response.json()
    if (!Array.isArray(payload?.data)) throw new Error("Magpie returned an invalid model catalog")
    return payload.data.filter((model) => model && typeof model.id === "string" && (!model.kind || model.kind === "chat"))
  }

  restoreBackup() {
    if (this.backup) return
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf8"))
      if (value && typeof value === "object" && !Array.isArray(value)) {
        this.backup = value.backup
        this.providerId = typeof value.providerId === "string" ? value.providerId : null
        this.lastModel = typeof value.model === "string" ? value.model : null
        this.lastAppliedModel = typeof value.appliedModel === "string" ? value.appliedModel : null
      }
    } catch { /* No previous connection, or an unreadable backup is not trusted. */ }
  }

  saveBackup() {
    if (!this.backup) {
      try { fs.unlinkSync(this.stateFile) } catch { /* Already absent. */ }
      return
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({
      backup: this.backup,
      providerId: this.providerId,
      model: this.lastModel,
      appliedModel: this.lastAppliedModel,
    }), { mode: 0o600 })
    fs.renameSync(temporary, this.stateFile)
  }

  reportError(error) {
    const message = error ? safeError(error) : ""
    if (message === this.lastError) return
    this.lastError = message
    if (message) this.logger("warn", message)
  }

  async start() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      this.watcher = fs.watch(path.dirname(this.file), { persistent: false }, (_event, name) => {
        if (!name || name.toString() === path.basename(this.file)) this.wake()
      })
      this.watcher.on("error", () => {})
    } catch { /* The poll below also covers filesystems without useful events. */ }
    await this.tick()
    this.timer = setInterval(() => this.wake(), this.options.pollMs)
    this.timer.unref?.()
  }

  wake() {
    void this.tick().catch((error) => this.reportError(error))
  }
}
