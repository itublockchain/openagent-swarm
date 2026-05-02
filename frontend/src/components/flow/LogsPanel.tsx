'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Terminal as TerminalIcon,
  Search,
  X,
  Trash2,
  ArrowDownToLine,
  Send,
  UserCheck,
  GitBranch,
  Hand,
  Hourglass,
  CheckCircle2,
  CheckCheck,
  MinusCircle,
  Lock,
  Vote,
  AlertTriangle,
  Zap,
  RotateCcw,
  Flag,
  Trophy,
  Users,
  Info,
  AlertCircle,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { EventType } from '../../../../shared/types'
import type { LogEntry } from './logEntry'

interface VisualSpec {
  /** Icon component shown to the left of the message. */
  icon: LucideIcon
  /** Tailwind text + border color tokens for the row's left rail / icon. */
  accent: string
  /** Optional one-word category label shown in the row's hover tooltip. */
  label: string
}

/** Per-event-type visual spec. Adding a new EventType without updating
 *  this map is fine — it falls through to a neutral default. Keep colors
 *  consistent with the canvas legend (subtask boxes) so users don't have
 *  to learn two palettes. */
const EVENT_VISUALS: Partial<Record<EventType, VisualSpec>> = {
  [EventType.TASK_SUBMITTED]:        { icon: Send,        accent: 'text-blue-400 border-blue-500',     label: 'Submit' },
  [EventType.PLANNER_SELECTED]:      { icon: UserCheck,   accent: 'text-purple-400 border-purple-500', label: 'Planner' },
  [EventType.DAG_READY]:             { icon: GitBranch,   accent: 'text-purple-400 border-purple-500', label: 'Plan' },
  [EventType.SUBTASK_CLAIMED]:       { icon: Hand,        accent: 'text-cyan-400 border-cyan-500',     label: 'Claim' },
  [EventType.SUBTASK_DONE]:          { icon: Hourglass,   accent: 'text-yellow-400 border-yellow-500', label: 'Pending' },
  [EventType.SUBTASK_VALIDATED]:     { icon: CheckCircle2,accent: 'text-green-400 border-green-500',   label: 'Validated' },
  [EventType.SUBTASK_PEER_VALIDATED]:{ icon: CheckCheck,  accent: 'text-green-400 border-green-500',   label: 'Peer OK' },
  [EventType.AGENT_PASSED]:          { icon: MinusCircle, accent: 'text-muted-foreground border-muted',label: 'Pass' },
  [EventType.JUROR_COMMITTED]:       { icon: Lock,        accent: 'text-amber-400 border-amber-500',   label: 'Commit' },
  [EventType.JUROR_VOTED]:           { icon: Vote,        accent: 'text-amber-400 border-amber-500',   label: 'Vote' },
  [EventType.CHALLENGE]:             { icon: AlertTriangle,accent:'text-red-400 border-red-500',       label: 'Challenge' },
  [EventType.SLASH_EXECUTED]:        { icon: Zap,         accent: 'text-red-400 border-red-500',       label: 'Slash' },
  [EventType.TASK_REOPENED]:         { icon: RotateCcw,   accent: 'text-orange-400 border-orange-500', label: 'Reopen' },
  [EventType.DAG_VALIDATING]:        { icon: Loader2,     accent: 'text-yellow-400 border-yellow-500', label: 'Validating' },
  [EventType.DAG_COMPLETED]:         { icon: Trophy,      accent: 'text-green-400 border-green-500',   label: 'Settled' },
  [EventType.TASK_FINALIZED]:        { icon: Flag,        accent: 'text-green-400 border-green-500',   label: 'Final' },
  [EventType.COLONY_MEMBERSHIP_CHANGED]: { icon: Users,   accent: 'text-blue-400 border-blue-500',     label: 'Colony' },
}

const KIND_DEFAULT_VISUAL: Record<LogEntry['kind'], VisualSpec> = {
  user:   { icon: Send,        accent: 'text-foreground border-green-500 font-bold', label: 'You' },
  api:    { icon: Info,        accent: 'text-blue-300 border-blue-500',              label: 'API' },
  system: { icon: Info,        accent: 'text-blue-400 border-blue-500',              label: 'System' },
  error:  { icon: AlertCircle, accent: 'text-red-400 border-red-500',                label: 'Error' },
  event:  { icon: Info,        accent: 'text-muted-foreground border-muted',         label: 'Event' },
}

function visualFor(entry: LogEntry): VisualSpec {
  if (entry.kind === 'event' && entry.eventType) {
    return EVENT_VISUALS[entry.eventType] ?? KIND_DEFAULT_VISUAL.event
  }
  return KIND_DEFAULT_VISUAL[entry.kind]
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}

export function LogsPanel({
  entries,
  onClear,
}: {
  entries: LogEntry[]
  onClear: () => void
}) {
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    // Errors are intentionally suppressed from the orchestration log —
    // dynamic budget cap + Treasury-aware UI mean the only surfaceable
    // failure left is a transient backend hiccup, and a red banner
    // mid-run reads as scarier than the underlying issue is. Errors
    // still go to console / network tab for debugging.
    const visible = entries.filter(e => e.kind !== 'error')
    const q = search.trim().toLowerCase()
    if (!q) return visible
    return visible.filter(e =>
      e.message.toLowerCase().includes(q) ||
      (e.eventType?.toLowerCase().includes(q) ?? false),
    )
  }, [entries, search])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !follow) return
    el.scrollTop = el.scrollHeight
  }, [filtered, follow])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    if (dist > 32 && follow) setFollow(false)
    else if (dist < 24 && !follow) setFollow(true)
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setFollow(true)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="h-9 px-4 border-b border-border flex items-center justify-between bg-muted/20 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Orchestration Logs
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground/60">{entries.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFollow(f => !f)}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-colors',
              follow
                ? 'text-green-500 bg-green-500/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
            title={follow ? 'Auto-scroll on' : 'Auto-scroll off'}
            aria-label="Toggle auto-scroll"
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', follow ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/40')} />
            Live
          </button>
          <button
            onClick={onClear}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Clear logs"
            aria-label="Clear logs"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-border bg-muted/10 shrink-0">
        <div className="relative flex items-center">
          <Search className="absolute left-2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search logs…"
            className="w-full pl-6 pr-6 py-1 text-[11px] bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-1 p-0.5 rounded hover:bg-muted text-muted-foreground"
              aria-label="Clear search"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="absolute inset-0 p-3 font-mono text-[11px] overflow-y-auto space-y-1 bg-background/30"
        >
          {filtered.length === 0 ? (
            <div className="text-muted-foreground/60 italic px-2">
              {entries.length === 0 ? 'No logs yet.' : 'No logs match your search.'}
            </div>
          ) : (
            filtered.map((entry) => {
              const v = visualFor(entry)
              const Icon = v.icon
              const spinning = entry.eventType === EventType.DAG_VALIDATING
              return (
                <div
                  key={entry.id}
                  title={v.label}
                  className={cn(
                    'group flex items-start gap-2 border-l-2 pl-2 py-1 rounded-r-sm hover:bg-muted/30 transition-colors',
                    v.accent,
                  )}
                >
                  <Icon className={cn('w-3.5 h-3.5 shrink-0 mt-[1px]', spinning && 'animate-spin')} />
                  <div className="min-w-0 flex-1 leading-snug">
                    <div className="flex items-baseline gap-2">
                      <span className="text-muted-foreground/60 tabular-nums text-[10px] shrink-0">
                        {fmtTime(entry.timestamp)}
                      </span>
                      <span className="break-words">{entry.message}</span>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
        {!follow && filtered.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 flex items-center gap-1 bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md shadow-md hover:bg-primary/90 transition-colors"
            aria-label="Jump to bottom"
          >
            <ArrowDownToLine className="w-3 h-3" />
            New
          </button>
        )}
      </div>
    </div>
  )
}
