import { zodToJsonSchema } from 'zod-to-json-schema'
import type { AssistantTool } from '../../contracts/tools'

export class ToolRegistry {
  private tools = new Map<string, AssistantTool>()
  register<T, R>(tool: AssistantTool<T, R>): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool as AssistantTool)
    return this
  }
  get(name: string): AssistantTool | undefined { return this.tools.get(name) }
  descriptors(capabilities: Set<string>, planning = false) {
    return [...this.tools.values()].filter(tool => (!planning || tool.effect === 'read') && tool.requiredCapabilities.every(capability => capabilities.has(capability))).map(tool => ({ name: tool.name, description: tool.description, group: tool.group, effect: tool.effect, parameters: tool.jsonSchema ?? zodToJsonSchema(tool.parameters, { $refStrategy: 'none' }) }))
  }
}
