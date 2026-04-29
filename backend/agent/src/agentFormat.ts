import { Tool } from './tools/Tool'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * One step in an agent's transcript. Either a tool round-trip or the final
 * answer. The transcript is what gets persisted to 0G Storage as the node's
 * canonical output and what `judge()` reviews.
 */
export type TranscriptStep =
  | { kind: 'tool_call'; tool: string; args: Record<string, unknown>; output: string; ok: boolean }
  | { kind: 'final'; text: string }

export type ParsedResponse =
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'final'; text: string }
  | { kind: 'parse_error'; raw: string; reason: string }

/**
 * Strategy for how the agent talks to the model. Tarz A (JSON) is the
 * baseline; future ReActAgentFormat (Tarz B) plugs in here without
 * touching the loop or storage.
 */
export interface AgentFormat {
  buildPrompt(args: {
    systemPrompt: string | undefined
    subtask: string
    context: string | null
    tools: Tool[]
    transcript: TranscriptStep[]
  }): ChatMessage[]
  parseResponse(text: string): ParsedResponse
}

// ============================================================================
// Tarz A — JSON action prompting
// ============================================================================

export class JsonAgentFormat implements AgentFormat {
  buildPrompt(args: {
    systemPrompt: string | undefined
    subtask: string
    context: string | null
    tools: Tool[]
    transcript: TranscriptStep[]
  }): ChatMessage[] {
    const toolsList = args.tools
      .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`)
      .join('\n')

    const defaultPrompt = `You are an autonomous worker in a decentralized swarm. When given a subtask, produce the CONCRETE deliverable directly:
- For code tasks, return runnable code in the answer field (full source, not pseudocode).
- For research, return findings with citations or links.
- For analysis, return structured conclusions.
Avoid meta-commentary like "I would do X" or "to implement this you would..." — just produce X.
Use the available tools when external info or computation is genuinely needed; for self-contained code/text tasks, answer directly.`

    const system = `${args.systemPrompt?.trim() ?? defaultPrompt}

You have access to the following tools:
${toolsList}

To call a tool, respond with EXACTLY this JSON and nothing else (no markdown, no commentary):
{"action":"tool","tool":"<tool_name>","args":{...}}

When you have the final answer for the user, respond with EXACTLY:
{"action":"final","answer":"<your answer as plain text — INCLUDE the deliverable in full>"}

Rules:
- Output a SINGLE JSON object per turn, no surrounding prose.
- Use a tool only when it helps. If you already know the answer, return final immediately.
- Tool args must match the parameters schema.
- After a tool runs, you'll see its output as a "user" message starting with "Observation:". Read it, then decide your next action.
- Maximum 5 tool calls per task. Stop earlier when you have enough info.`

    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          `Subtask: ${args.subtask}` +
          (args.context ? `\n\nContext from previous step:\n${args.context}` : ''),
      },
    ]

    // Replay transcript so the model has its prior reasoning.
    for (const step of args.transcript) {
      if (step.kind === 'tool_call') {
        messages.push({
          role: 'assistant',
          content: JSON.stringify({ action: 'tool', tool: step.tool, args: step.args }),
        })
        messages.push({
          role: 'user',
          content: `Observation: ${step.output}`,
        })
      } else {
        messages.push({
          role: 'assistant',
          content: JSON.stringify({ action: 'final', answer: step.text }),
        })
      }
    }

    return messages
  }

  parseResponse(text: string): ParsedResponse {
    const trimmed = text.trim()

    // Try strict JSON first.
    const candidates: string[] = []
    candidates.push(trimmed)

    // Strip ```json fences.
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fence?.[1]) candidates.push(fence[1].trim())

    // Find first top-level { ... } block.
    const brace = trimmed.match(/\{[\s\S]*\}/)
    if (brace?.[0]) candidates.push(brace[0])

    for (const c of candidates) {
      try {
        const obj = JSON.parse(c)
        if (obj?.action === 'tool' && typeof obj.tool === 'string') {
          return { kind: 'tool', tool: obj.tool, args: obj.args && typeof obj.args === 'object' ? obj.args : {} }
        }
        if (obj?.action === 'final' && typeof obj.answer === 'string') {
          return { kind: 'final', text: obj.answer }
        }
      } catch {
        // try next candidate
      }
    }

    return { kind: 'parse_error', raw: text, reason: 'Could not parse JSON action' }
  }
}
