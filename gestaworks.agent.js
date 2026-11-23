// Magpie owns this file while GestaWorks is connected on its Agents page.
// The Bun host applies it to Keel's running local backend; disconnecting the
// agent restores the previous values here, which the host then applies.
export const agent = {
  id: "gestaworks",
  name: "GestaWorks",
  config: "~/.config/magpie-gestaworks/connection.json",
  model: "model",
  bin: "keel",
  ua: ["gestaworks", "keel"],
  notice: "Start GestaWorks before connecting. The plugin applies changes to its running local backend.",
}

export function connect({ gateway, models }) {
  return {
    enabled: true,
    gateway: {
      url: gateway.v1,
      key: gateway.key,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
    })),
  }
}
