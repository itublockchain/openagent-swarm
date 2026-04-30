/**
 * Tool interface — MCP-aligned shape so a future MCP discovery layer can
 * register dynamically-found tools alongside hardcoded ones with no refactor.
 *
 * `parameters` is JSON Schema (the same shape OpenAI / Anthropic / MCP all
 * agree on). The agent loop renders this verbatim into the prompt so the LLM
 * knows what arguments to produce.
 */
export interface Tool {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, JsonSchemaProp>
    required?: string[]
  }
  execute(args: Record<string, unknown>): Promise<ToolResult>
}

export interface JsonSchemaProp {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  items?: JsonSchemaProp
}

export interface ToolResult {
  ok: boolean
  /** Human-readable string fed back to the LLM as the next observation. */
  output: string
  /** Structured payload retained in the transcript for storage / judge. */
  data?: unknown
  error?: string
}
