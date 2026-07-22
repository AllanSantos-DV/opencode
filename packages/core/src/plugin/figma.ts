export * as FigmaPlugin from "./figma"

import { ConfigMCP } from "../config/mcp"

const CLIENT_ID = "3zVHNs9kINDDrk8loekLZV"

export function apply(server: typeof ConfigMCP.Server.Type) {
  if (server.type !== "remote" || server.oauth === false) return server
  if (!URL.canParse(server.url) || new URL(server.url).hostname !== "mcp.figma.com") return server
  if (server.oauth?.client_id) return server
  if (server.oauth) {
    Object.assign(server.oauth, { client_id: CLIENT_ID })
    return server
  }
  Object.assign(server, { oauth: { client_id: CLIENT_ID } })
  return server
}
