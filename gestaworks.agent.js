// Magpie owns this file while GestaWorks is connected on its Agents page.
// The Bun host applies it to Keel's running local backend; disconnecting the
// agent restores the previous values here, which the host then applies.
export const agent = {
  id: "gestaworks",
  name: "GestaWorks",
  config: "~/.config/magpie-gestaworks/connection.json",
  // Legacy Hong's stable desktop data directory. Current Keel releases keep
  // a ~/.hong symlink to ~/.keel, so this detects both old and new installs.
  dir: "~/.hong",
  model: "model",
  ua: ["gestaworks", "keel"],
  notice: "Start GestaWorks before connecting. Restart it after the first sync to load Magpie's display names and model capabilities.",
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
