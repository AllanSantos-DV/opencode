import type { PluginApi } from "@opencode-ai/client/effect/api"
import type { Effect, Scope } from "effect"
import { instanceSafeTool } from "./tool-schema.js"
import type { PluginOptions } from "../options.js"
import type { App } from "../app.js"
import type { AgentDomain } from "./agent.js"
import type { AISDKDomain } from "./aisdk.js"
import type { CatalogDomain } from "./catalog.js"
import type { CommandDomain } from "./command.js"
import type { EventDomain } from "./event.js"
import type { IntegrationDomain } from "./integration.js"
import type { MCPDomain } from "./mcp.js"
import type { ReferenceDomain } from "./reference.js"
import type { SessionDomain } from "./session.js"
import type { ShellDomain } from "./shell.js"
import type { SkillDomain } from "./skill.js"
import type { ToolDomain } from "./tool.js"
import type { WebSearchDomain } from "./websearch.js"

export interface Context {
  readonly app: App
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly catalog: CatalogDomain
  readonly command: CommandDomain
  readonly event: EventDomain
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly plugin: PluginApi<unknown>
  readonly reference: ReferenceDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly tool: ToolDomain
  readonly websearch: WebSearchDomain
}

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly tui?: boolean
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>): Plugin<R> {
  return {
    ...plugin,
    effect: (context) => plugin.effect(instanceSafeContext(context)),
  }
}

// Tool schemas cross from the plugin's module world into the host at `draft.add`;
// convert them while authoring-instance code is still on the stack so the host never
// interprets a foreign Effect schema. See `instanceSafeTool`.
function instanceSafeContext(context: Context): Context {
  return {
    ...context,
    tool: {
      ...context.tool,
      transform: (callback) =>
        context.tool.transform((draft) => callback({ add: (tool) => draft.add(instanceSafeTool(tool)) })),
    },
  }
}
