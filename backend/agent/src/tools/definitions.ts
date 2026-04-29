import { Tool } from './Tool'
import { webSearch } from './WebSearch'
import { fetchURL } from './FetchURL'
import { executeCode } from './CodeExecutor'

/**
 * Hardcoded tool registry. Order matters only for prompt rendering — the
 * LLM picks by name, not position. Future MCP-discovered tools append here
 * via `registerMcpTools()` (Faz 5).
 */
export const TOOLS: Tool[] = [
  {
    name: 'web_search',
    description:
      'Search the web for current information. Returns the top 3 results with title, URL, and a content snippet. Use this for recent facts, news, prices, or anything not in the model\'s training data.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query in natural language' },
      },
      required: ['query'],
    },
    execute: async (args) => webSearch(String(args.query ?? '')),
  },
  {
    name: 'execute_code',
    description:
      'Execute a short Python or JavaScript snippet in an isolated sandbox (no network, 30s timeout). Use this for math, data manipulation, or quick scripts. Returns stdout/stderr/exitCode.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Source code to run' },
        language: { type: 'string', enum: ['python', 'javascript'], description: 'Runtime language' },
      },
      required: ['code', 'language'],
    },
    execute: async (args) =>
      executeCode(
        String(args.code ?? ''),
        (String(args.language ?? '').toLowerCase() === 'python' ? 'python' : 'javascript'),
      ),
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a URL and return its visible text content (HTML stripped). Capped at 5000 chars. Use this after web_search to dive deeper into a specific page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch (http/https)' },
      },
      required: ['url'],
    },
    execute: async (args) => fetchURL(String(args.url ?? '')),
  },
]

export function getTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}
