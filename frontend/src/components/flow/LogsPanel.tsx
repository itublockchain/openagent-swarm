'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal as TerminalIcon, Search, X, Trash2, ArrowDownToLine } from 'lucide-react'
import { cn } from '@/lib/utils'

export function LogsPanel({ logs, onClear }: { logs: string[]; onClear: () => void }) {
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return logs
    return logs.filter(l => l.toLowerCase().includes(q))
  }, [logs, search])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !follow) return
    el.scrollTop = el.scrollHeight
  }, [filtered, follow])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    // Disengage follow when the user scrolls up; re-engage at the bottom
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
          <span className="text-[10px] tabular-nums text-muted-foreground/60">{logs.length}</span>
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
          className="absolute inset-0 p-4 font-mono text-[11px] overflow-y-auto space-y-1.5 bg-background/30"
        >
          {filtered.length === 0 ? (
            <div className="text-muted-foreground/60 italic">
              {logs.length === 0 ? 'No logs yet.' : 'No logs match your search.'}
            </div>
          ) : (
            filtered.map((log, i) => (
              <div
                key={i}
                className={cn(
                  'border-l-2 pl-2 transition-all',
                  log.includes('[ERROR]')  ? 'border-red-500 text-red-400 bg-red-500/5' :
                  log.includes('[SYSTEM]') ? 'border-blue-500 text-blue-400' :
                  log.includes('[USER]')   ? 'border-green-500 text-foreground font-bold' :
                  'border-muted text-muted-foreground',
                )}
              >
                {log}
              </div>
            ))
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
