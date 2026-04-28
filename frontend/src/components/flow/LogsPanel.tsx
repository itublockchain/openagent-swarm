'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal as TerminalIcon, Search, X, Trash2 } from 'lucide-react'
import { cn } from '@/components/flow/task-node'

export function LogsPanel({ logs, onClear }: { logs: string[]; onClear: () => void }) {
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // Stick-to-bottom flag: true while the user is at the bottom; we suspend auto-scroll
  // when they scroll up, and resume once they scroll back down.
  const stickyRef = useRef(true)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return logs
    return logs.filter(l => l.toLowerCase().includes(q))
  }, [logs, search])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickyRef.current) return
    el.scrollTop = el.scrollHeight
  }, [filtered])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyRef.current = dist < 24
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="h-9 px-4 border-b border-border flex items-center justify-between bg-muted/20 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Orchestration Logs
          </span>
        </div>
        <button
          onClick={onClear}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Clear logs"
          aria-label="Clear logs"
        >
          <Trash2 className="w-3 h-3" />
        </button>
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

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 p-4 font-mono text-[11px] overflow-y-auto space-y-1.5 bg-background/30 min-h-0"
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
    </div>
  )
}
