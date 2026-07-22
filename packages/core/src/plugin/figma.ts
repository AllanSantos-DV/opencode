export * as FigmaPlugin from "./figma"

import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import { Effect } from "effect"
import { Config } from "../config"

const CLIENT_ID = "3zVHNs9kINDDrk8loekLZV"

export const Plugin = define({
  id: "opencode.figma",
  effect: Effect.fn(function* () {
    const config = yield* Config.Service
    const entries = yield* config.entries()
    entries
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((entry) => Object.values(entry.info.mcp?.servers ?? {}))
      .forEach((server) => {
        if (server.type !== "remote" || server.oauth === false) return
        if (!URL.canParse(server.url) || new URL(server.url).hostname !== "mcp.figma.com") return
        if (server.oauth?.client_id) return
        if (server.oauth) {
          Object.assign(server.oauth, { client_id: CLIENT_ID })
          return
        }
        Object.assign(server, { oauth: { client_id: CLIENT_ID } })
      })
  }),
})
