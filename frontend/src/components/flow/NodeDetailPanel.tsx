'use client'

import React from 'react'
import { Wrench, CheckCircle2, Clock4, XCircle } from 'lucide-react'
import { cn, shortHash } from '@/lib/utils'
import type { NodeData } from './task-node'

interface NodeDetailPanelProps {
  data: NodeData
}

const stopReasonMeta: Record<NonNullable<NodeData['stopReason']>, { label: string; tone: string; Icon: typeof CheckCircle2 }> = {
  final:       { label: 'Final answer reached',      tone: 'text-green-600 dark:text-green-400',  Icon: CheckCircle2 },
  max_iter:    { label: 'Max iterations',            tone: 'text-yellow-600 dark:text-yellow-400', Icon: Clock4       },
  deadline:    { label: 'Deadline',                  tone: 'text-yellow-600 dark:text-yellow-400', Icon: Clock4       },
  parse_error: { label: 'Parse error',               tone: 'text-red-600 dark:text-red-400',       Icon: XCircle      },
  no_chat:     { label: 'No compute available',      tone: 'text-red-600 dark:text-red-400',       Icon: XCircle      },
}

/**
 * Side panel that opens beside a DAG node when the user clicks it. Shows
 * the agent's reasoning trace (tool calls, observations) and the final
 * output captured from the SUBTASK_DONE broadcast.
 *
 * Rendered inside ReactFlow's <NodeToolbar>, so positioning relative to
 * the node + auto-close on deselect are free; this component only owns
 * the panel chrome and content layout.
 */
export const NodeDetailPanel = ({ data }: NodeDetailPanelProps) => {
  const transcript = data.transcript ?? []
  const finalStep = [...transcript].reverse().find((s): s is Extract<typeof s, { kind: 'final' }> => s.kind === 'final')
  const finalText = finalStep?.text ?? data.result

  // Planner / "Active Task" header nodes don't carry a final answer;
  // show a placeholder so the panel still feels intentional.
  const hasFinal = !!finalText

  const stopMeta = data.stopReason ? stopReasonMeta[data.stopReason] : null

  return (
    <div
      className="w-[360px] max-h-[480px] overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl flex flex-col"
      // Keep clicks from bubbling up to ReactFlow (would deselect the node
      // and snap the panel shut mid-scroll).
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/60 shrink-0">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
          Subtask
        </div>
        <div className="text-sm font-semibold leading-snug break-words">
          {data.label}
        </div>

        {/* Summary row — agent, iterations, stop reason */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-muted-foreground">
          {data.agent && (
            <span className="flex items-center gap-1">
              <span className="opacity-70">Agent</span>
              <span className="text-foreground">
                {data.agent.length > 16 ? shortHash(data.agent, 6, 4) : data.agent}
              </span>
            </span>
          )}
          {typeof data.iterations === 'number' && (
            <span>
              <span className="opacity-70">Iter</span>{' '}
              <span className="text-foreground tabular-nums">{data.iterations}</span>
            </span>
          )}
          {stopMeta && (
            <span className={cn('flex items-center gap-1', stopMeta.tone)}>
              <stopMeta.Icon className="w-3 h-3" />
              {stopMeta.label}
            </span>
          )}
        </div>

        {data.toolsUsed && data.toolsUsed.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {data.toolsUsed.map((tool, i) => (
              <span
                key={`${tool}-${i}`}
                className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-muted text-foreground/80"
              >
                <Wrench className="w-2.5 h-2.5" />
                {tool}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Body — final answer only. Tool-call traces and per-step error
          surfaces were removed by request: the panel now shows the model's
          final answer and nothing else, so users aren't shown intermediate
          tool failures (some retries succeed and the final answer is fine
          regardless). */}
      <div className="overflow-y-auto px-4 py-3 flex-1 flex flex-col gap-4">
        {!hasFinal ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">
            No output yet. The final answer will appear here once the agent finishes.
          </div>
        ) : (
          <section className="flex flex-col gap-1.5">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Final answer
            </div>
            <div className="text-xs leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-muted/40 border border-border/60 px-3 py-2.5">
              {finalText}
            </div>
          </section>
        )}
      </div>

      {/* Footer — outputHash if present */}
      {data.outputHash && (
        <div className="px-4 py-2 border-t border-border/60 shrink-0 text-[10px] font-mono text-muted-foreground flex items-center justify-between gap-2">
          <span className="opacity-70">0G hash</span>
          <span className="truncate text-foreground/70" title={data.outputHash}>
            {shortHash(data.outputHash, 8, 6)}
          </span>
        </div>
      )}
    </div>
  )
}
