import { ToolResult } from './Tool'

const DEFAULT_API = process.env.API_INTERNAL_URL ?? 'http://api:3001'
const TIMEOUT_MS = 35_000

/**
 * Code is executed in an ephemeral sandbox container. Agent itself does not
 * hold Docker privileges — the API container is the only one with access to
 * docker-proxy, so this tool just POSTs to a privileged internal endpoint
 * (`/internal/execute`) which runs the actual sandbox spawn.
 *
 * The sandbox container is started with NetworkMode: none and a 30s wall
 * timeout, so even an LLM-generated infinite loop or exfiltration attempt is
 * harmless.
 */
export async function executeCode(
  code: string,
  language: 'python' | 'javascript',
): Promise<ToolResult> {
  if (!code.trim()) {
    return { ok: false, output: 'execute_code: empty code', error: 'empty_code' }
  }
  if (language !== 'python' && language !== 'javascript') {
    return {
      ok: false,
      output: `execute_code: unsupported language "${language}". Use "python" or "javascript".`,
      error: 'bad_language',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`${DEFAULT_API}/internal/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // agentId lets the API rate-limit per-agent. process.env.AGENT_ID is
      // always set inside agent containers (start.sh enforces).
      body: JSON.stringify({ code, language, agentId: process.env.AGENT_ID ?? 'unknown' }),
      signal: controller.signal,
    })
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after')
      return {
        ok: false,
        output: `execute_code: rate-limited (${retryAfter ? `retry after ${retryAfter}s` : 'too many concurrent executions'})`,
        error: 'rate_limited',
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        output: `execute_code failed: HTTP ${res.status} ${text}`,
        error: `http_${res.status}`,
      }
    }
    const data = (await res.json()) as { stdout: string; stderr: string; exitCode: number; timedOut?: boolean }
    const lines = [
      `exitCode: ${data.exitCode}${data.timedOut ? ' (TIMEOUT)' : ''}`,
      data.stdout ? `--- stdout ---\n${data.stdout}` : '',
      data.stderr ? `--- stderr ---\n${data.stderr}` : '',
    ].filter(Boolean)
    return {
      ok: data.exitCode === 0,
      output: lines.join('\n'),
      data,
    }
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'client-side timeout' : (err?.message ?? String(err))
    return { ok: false, output: `execute_code failed: ${msg}`, error: msg }
  } finally {
    clearTimeout(timer)
  }
}
