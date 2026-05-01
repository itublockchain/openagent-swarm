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
      'PRIMARY tool for ANY internet research, current information, recent facts, news, prices, or external knowledge lookup. Returns top 3 results (title, URL, content snippet). USE THIS FIRST for any web lookup — it handles search providers, anti-bot bypass, and result summarization for you. For platform-specific queries (e.g. tweets on x.com / twitter.com, posts on reddit, GitHub repos), include the domain in the query (e.g. "ai trends site:x.com" or "trending AI twitter april 2026"). Do NOT try to scrape websites with execute_code — execute_code has no network access.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query in natural language. Add `site:domain.com` to restrict.' },
      },
      required: ['query'],
    },
    execute: async (args) => webSearch(String(args.query ?? '')),
  },
  {
    name: 'execute_code',
    description:
      'Run a short Python or JavaScript snippet in an isolated sandbox. STRICT LIMITS: (1) NO NETWORK ACCESS — http/https/socket/dns are all blocked, so libraries like requests, urllib, fetch, axios will fail. (2) STDLIB ONLY — third-party packages (requests, bs4, numpy, pandas, lodash, etc.) are NOT installed and pip/npm install do not work (no network). (3) 30s wall timeout, 256MB RAM. Use this ONLY for: math, string/JSON parsing of inline data, algorithm implementations, encoding/decoding, regex, datetime calculations. For any internet research, use web_search instead — never try to scrape via this tool.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Source code to run. STDLIB ONLY, NO NETWORK.' },
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
      'Fetch the visible text of a SPECIFIC public URL you already know (HTML stripped, capped at 5000 chars). Use AFTER web_search when you need full content of one of the result pages. Not a search tool. Avoid login-walled or JS-heavy SPAs (twitter/x.com, instagram, facebook) — they return empty body; use web_search with a site: filter for those.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch (http/https), typically from web_search results' },
      },
      required: ['url'],
    },
    execute: async (args) => fetchURL(String(args.url ?? '')),
  },
]

export function getTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}
