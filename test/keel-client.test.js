import { describe, expect, mock, test } from "bun:test"
import { discoverKeel, KeelClient, KeelError } from "../src/keel-client.js"

const reply = (value) => Response.json({ result: { data: { json: value } } })

describe("Keel tRPC wire protocol", () => {
  test("uses superjson envelopes for queries and mutations", async () => {
    const calls = []
    const fetchImpl = mock(async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes("getModelConfig")) return reply({ key: "value" })
      return reply({ success: true })
    })
    const client = new KeelClient("http://127.0.0.1:22343", { fetchImpl })
    expect(await client.getModelConfig()).toEqual({ key: "value" })
    await client.setModelConfig([{ key: "models:enabled-provider-ids", value: '["p"]' }])
    const query = new URL(calls[0].url)
    expect(query.pathname).toBe("/providers.getModelConfig")
    expect(JSON.parse(query.searchParams.get("input"))).toEqual({ json: null })
    expect(calls[0].init.method).toBe("GET")
    expect(calls[1].url).toBe("http://127.0.0.1:22343/providers.setModelConfig")
    expect(JSON.parse(calls[1].init.body)).toEqual({
      json: { entries: [{ key: "models:enabled-provider-ids", value: '["p"]' }] },
    })
    expect(calls[1].init.redirect).toBe("error")
  })

  test("sends the complete Magpie custom-provider configuration", async () => {
    let body
    const client = new KeelClient("http://127.0.0.1:22343", {
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body).json
        return reply({ success: true, id: "provider-1" })
      },
    })
    expect(await client.addMagpie("http://127.0.0.1:3425/v1", "magpie-gestaworks")).toBe("provider-1")
    expect(body).toEqual({
      name: "Magpie", baseUrl: "http://127.0.0.1:3425/v1", apiKey: "magpie-gestaworks",
      skipValidation: false, protocol: "openai-completions", authStyle: "bearer",
    })
    expect(body.manualModels).toBeUndefined()
  })

  test("honors addCustom's returned failure", async () => {
    const client = new KeelClient("http://127.0.0.1:22343", {
      fetchImpl: async () => reply({ success: false, error: "Gateway host not allowed" }),
    })
    expect(client.addMagpie("http://127.0.0.1:3425/v1", "magpie-gestaworks")).rejects.toThrow("Gateway host not allowed")
  })

  test("decodes tRPC errors and rejects malformed responses", async () => {
    const errorClient = new KeelClient("http://127.0.0.1:22343", {
      fetchImpl: async () => Response.json({ error: { json: { message: "Unknown model-config key" } } }),
    })
    expect(errorClient.getModelConfig()).rejects.toThrow("Unknown model-config key")
    const htmlClient = new KeelClient("http://127.0.0.1:22343", {
      fetchImpl: async () => new Response("<html>not Keel</html>"),
    })
    expect(htmlClient.getModelConfig()).rejects.toThrow("non-JSON")
  })

  test("bounds response size", async () => {
    const client = new KeelClient("http://127.0.0.1:22343", {
      fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    })
    expect(client.getModelConfig()).rejects.toThrow("too large")
  })
})

describe("Keel discovery", () => {
  test("checks health and providers before selecting a port", async () => {
    const visited = []
    const client = await discoverKeel({
      fetchImpl: async (url) => {
        const target = new URL(url)
        visited.push(target.port + target.pathname)
        if (target.port === "22343") throw new Error("offline")
        if (target.pathname === "/healthz") return Response.json({ status: "ok" })
        return reply([])
      },
    })
    expect(client.baseUrl).toBe("http://127.0.0.1:22342")
    expect(visited).toEqual(["22343/healthz", "22342/healthz", "22342/providers.list"])
  })

  test("does not fall through an explicitly configured endpoint", async () => {
    let calls = 0
    expect(discoverKeel({
      configuredUrl: "http://127.0.0.1:23000",
      fetchImpl: async () => { calls++; throw new Error("offline") },
    })).rejects.toThrow("not available")
    expect(calls).toBe(1)
  })
})
