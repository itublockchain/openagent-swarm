import { IComputePort } from '../../../shared/ports'
import { Tool } from './tools/Tool'
import { getTool } from './tools/definitions'
import { AgentFormat, ChatMessage, TranscriptStep } from './agentFormat'

// 2-iter / 30s was too tight for tool-heavy flows (web_search → fetch_url →
// execute_code → final easily exceeds 2 turns), forcing the loop into a
// 'max_iter' degrade where the raw partial response — not the final answer —
// gets persisted and judged. 5 iterations covers realistic tool chains;
// 60s deadline absorbs one 0G Compute rate-limit retry plus one tool round.
const MAX_ITERATIONS = 5
const OVERALL_DEADLINE_MS = 60_000

export interface AgentLoopResult {
  /** Plain-text answer for downstream agents to use as context. */
  finalAnswer: string
  /** Full JSON-serializable record of what happened — written to 0G Storage. */
  transcript: TranscriptStep[]
  toolsUsed: string[]
  iterations: number
  stopReason: 'final' | 'max_iter' | 'deadline' | 'parse_error' | 'no_chat'
}

export interface RunAgentLoopArgs {
  compute: IComputePort
  tools: Tool[]
  format: AgentFormat
  systemPrompt: string | undefined
  subtask: string
  context: string | null
  agentId: string
}

/**
 * Iterative agent loop. The model decides at each step: call a tool, or
 * return a final answer. We feed observations back as user-role messages.
 *
 * Bail conditions:
 *   - Final answer parsed → return it
 *   - MAX_ITERATIONS hit → wrap the last raw response as a degraded final
 *   - OVERALL_DEADLINE_MS hit → same
 *   - Repeated parse error → degrade
 *   - compute.chat unavailable (mock without override) → fail-closed with
 *     a stub result so the calling SwarmAgent can still settle the task
 */
export async function runAgentLoop(args: RunAgentLoopArgs): Promise<AgentLoopResult> {
  const { compute, tools, format, systemPrompt, subtask, context, agentId } = args

  if (typeof compute.chat !== 'function') {
    // Adapter doesn't support multi-turn chat (e.g. legacy mock). Fall back
    // to single-shot complete() and wrap as final.
    const answer = await compute.complete(subtask, context)
    return {
      finalAnswer: answer,
      transcript: [{ kind: 'final', text: answer }],
      toolsUsed: [],
      iterations: 0,
      stopReason: 'no_chat',
    }
  }

  const transcript: TranscriptStep[] = []
  const toolsUsed: string[] = []
  const startedAt = Date.now()
  let parseErrors = 0
  let lastRaw = ''

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    if (Date.now() - startedAt > OVERALL_DEADLINE_MS) {
      console.warn(`[agentLoop ${agentId}] deadline hit at iter ${iter}`)
      return finalize(transcript, toolsUsed, iter - 1, lastRaw, 'deadline')
    }

    const messages: ChatMessage[] = format.buildPrompt({
      systemPrompt, subtask, context, tools, transcript,
    })

    let raw: string
    try {
      raw = await compute.chat!(messages, 512)
    } catch (err) {
      console.error(`[agentLoop ${agentId}] chat error iter ${iter}:`, err)
      return finalize(transcript, toolsUsed, iter - 1, lastRaw || `chat error: ${(err as Error).message}`, 'deadline')
    }
    lastRaw = raw

    const parsed = format.parseResponse(raw)
    console.log(`[agentLoop ${agentId}] iter ${iter} parsed:`, parsed.kind)

    if (parsed.kind === 'parse_error') {
      parseErrors++
      if (parseErrors >= 2) {
        console.warn(`[agentLoop ${agentId}] giving up after ${parseErrors} parse errors`)
        return finalize(transcript, toolsUsed, iter, raw, 'parse_error')
      }
      // Inject a corrective hint and retry.
      transcript.push({
        kind: 'tool_call',
        tool: '__system__',
        args: {},
        output: `Your last response was not valid JSON. Reply ONLY with {"action":"tool",...} or {"action":"final","answer":"..."}.`,
        ok: false,
      })
      continue
    }

    if (parsed.kind === 'final') {
      transcript.push({ kind: 'final', text: parsed.text })
      return {
        finalAnswer: parsed.text,
        transcript,
        toolsUsed,
        iterations: iter,
        stopReason: 'final',
      }
    }

    // parsed.kind === 'tool'
    const tool = getTool(parsed.tool)
    if (!tool) {
      transcript.push({
        kind: 'tool_call',
        tool: parsed.tool,
        args: parsed.args,
        output: `Error: tool "${parsed.tool}" does not exist. Available: ${tools.map(t => t.name).join(', ')}`,
        ok: false,
      })
      continue
    }

    console.log(`[agentLoop ${agentId}] calling ${tool.name}`)
    let result
    try {
      result = await tool.execute(parsed.args)
    } catch (err: any) {
      result = { ok: false, output: `tool threw: ${err?.message ?? err}`, error: String(err?.message ?? err) }
    }
    transcript.push({
      kind: 'tool_call',
      tool: tool.name,
      args: parsed.args,
      output: result.output,
      ok: result.ok,
    })
    toolsUsed.push(tool.name)
  }

  // Loop exhausted without final.
  console.warn(`[agentLoop ${agentId}] max iterations reached`)
  return finalize(transcript, toolsUsed, MAX_ITERATIONS, lastRaw, 'max_iter')
}

function finalize(
  transcript: TranscriptStep[],
  toolsUsed: string[],
  iterations: number,
  lastRaw: string,
  stopReason: AgentLoopResult['stopReason'],
): AgentLoopResult {
  const fallback = lastRaw.trim() || `(agent stopped: ${stopReason})`
  transcript.push({ kind: 'final', text: fallback })
  return { finalAnswer: fallback, transcript, toolsUsed, iterations, stopReason }
}
