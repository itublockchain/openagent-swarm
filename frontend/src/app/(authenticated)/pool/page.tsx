'use client'

import { useEffect, useMemo, useState } from 'react'
import { Search, X, Rocket, PanelRightOpen, PanelRightClose } from 'lucide-react'
import { TopologyMap } from '@/components/TopologyMap'
import { Header } from '@/components/Header'
import { DeployAgentModal } from '@/components/DeployAgentModal'
import { CopyableId } from '@/components/ui/copyable-id'
import { cn, shortHash } from '@/lib/utils'

interface AgentRecord {
  agentId: string
  name?: string
  agentAddress?: string
  containerId: string
  model: string
  stakeAmount: string
  status: 'pending' | 'running' | 'stopped' | 'error'
  deployedAt: number
  ownerAddress?: string
}

const STATUS_PILL: Record<AgentRecord['status'], string> = {
  running: 'bg-green-500/10 text-green-500 border-green-500/20',
  error: 'bg-red-500/10 text-red-500 border-red-500/20',
  stopped: 'bg-muted text-muted-foreground border-border',
  pending: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
}

const STATUS_DOT: Record<AgentRecord['status'], string> = {
  running: '#22c55e',
  error: '#ef4444',
  pending: '#eab308',
  stopped: '#64748b',
}

type StatusFilter = 'all' | 'running' | 'error'

export default function PoolPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [loaded, setLoaded] = useState(false)
  // Track the selected agent by id; derive the full record below so it always
  // reflects the latest poll without a sync-effect.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isDeployOpen, setIsDeployOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  // Mobile: collapse sidebar by default; toggle to view
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/agent/pool`
        )
        const data = await res.json()
        setAgents(data)
      } catch (err) {
        console.error('Failed to load agent pool:', err)
      } finally {
        setLoaded(true)
      }
    }
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [])

  const selected = useMemo(
    () => (selectedId ? agents.find(a => a.agentId === selectedId) ?? null : null),
    [agents, selectedId]
  )

  const counts = useMemo(() => ({
    all: agents.length,
    running: agents.filter(a => a.status === 'running').length,
    error: agents.filter(a => a.status === 'error').length,
  }), [agents])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return agents
      .filter(a => filter === 'all' ? true : a.status === filter)
      .filter(a => {
        if (!q) return true
        return (
          (a.name ?? '').toLowerCase().includes(q) ||
          a.agentId.toLowerCase().includes(q) ||
          a.model.toLowerCase().includes(q) ||
          (a.agentAddress ?? '').toLowerCase().includes(q)
        )
      })
      // Errored agents bubble to the top so they're actionable
      .sort((a, b) => (a.status === 'error' ? -1 : 0) - (b.status === 'error' ? -1 : 0))
  }, [agents, filter, search])

  const handleSelect = (agentId: string) => {
    setSelectedId(agentId)
    setSidebarOpen(true)
  }

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Canvas */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-9 px-4 border-b border-border bg-background/85 backdrop-blur flex items-center gap-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-foreground/85 font-semibold">P2P Mesh Live</span>
            </div>
            <span className="opacity-30">·</span>
            <span><span className="opacity-60">Nodes</span> {agents.length}</span>
            <span className="opacity-30">·</span>
            <span><span className="opacity-60">Running</span> {counts.running}</span>
            {counts.error > 0 && (
              <>
                <span className="opacity-30">·</span>
                <span className="text-red-500"><span className="opacity-60">Errored</span> {counts.error}</span>
              </>
            )}
            {/* Mobile sidebar toggle */}
            <button
              onClick={() => setSidebarOpen(s => !s)}
              className="md:hidden ml-auto p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              aria-label={sidebarOpen ? 'Close pool panel' : 'Open pool panel'}
            >
              {sidebarOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
            </button>
          </div>

          <div className="relative flex-1 min-h-0">
            <TopologyMap agents={agents} onSelect={handleSelect} selectedAgentId={selected?.agentId ?? null} />

            {/* Empty state overlay */}
            {loaded && agents.length === 0 && (
              <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                <div className="pointer-events-auto text-center max-w-sm px-6 py-8 rounded-2xl border border-dashed border-border/70 bg-background/85 backdrop-blur-md">
                  <div className="mx-auto mb-4 w-10 h-10 rounded-lg bg-muted/60 flex items-center justify-center">
                    <Rocket className="w-5 h-5 text-foreground" />
                  </div>
                  <h3 className="text-base font-bold tracking-tight mb-1">No agents in the swarm yet</h3>
                  <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
                    Deploy your first agent to start claiming subtasks. Bond USDC, pick a model — it joins the mesh in seconds.
                  </p>
                  <button
                    onClick={() => setIsDeployOpen(true)}
                    className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-primary/90 transition-colors shadow-sm"
                  >
                    <Rocket className="w-3.5 h-3.5" />
                    Deploy Agent
                  </button>
                </div>
              </div>
            )}

            {/* Color legend */}
            {agents.length > 0 && (
              <div className="absolute bottom-4 left-4 z-20 flex items-center gap-3 bg-background/80 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-border/50 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />Running</span>
                <span className="opacity-30">·</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />Error</span>
                <span className="opacity-30">·</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />Idle</span>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar — desktop static, mobile slides in */}
        <aside
          className={cn(
            'bg-card text-card-foreground border-l border-border shrink-0 overflow-hidden flex flex-col',
            'md:static md:w-80 md:translate-x-0',
            'absolute inset-y-0 right-0 z-30 w-[88%] max-w-sm transition-transform duration-300',
            sidebarOpen ? 'translate-x-0 shadow-2xl' : 'translate-x-full md:translate-x-0',
          )}
        >
          <div className="p-6 pb-3 shrink-0 border-b border-border/50">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold tracking-tight">Agent Pool</h2>
              <button
                onClick={() => setSidebarOpen(false)}
                className="md:hidden p-1 rounded hover:bg-muted text-muted-foreground"
                aria-label="Close pool panel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search */}
            <div className="relative flex items-center mb-3">
              <Search className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, model, address…"
                className="w-full pl-8 pr-7 py-1.5 text-xs bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-1.5 p-0.5 rounded hover:bg-muted text-muted-foreground"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Status tabs */}
            <div className="flex items-center gap-1 p-0.5 rounded-md bg-muted/40 border border-border/50 text-[11px]">
              {(['all', 'running', 'error'] as const).map(key => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    'flex-1 px-2 py-1 rounded-[5px] capitalize font-medium transition-colors flex items-center justify-center gap-1.5',
                    filter === key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span>{key}</span>
                  <span className="text-[10px] tabular-nums opacity-60">{counts[key]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 pt-4">
            {selected && (
              <div className="mb-6 p-4 rounded-xl bg-accent/30 border border-border/50 overflow-hidden">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className="text-base font-bold text-primary leading-tight truncate">
                    {selected.name ?? shortHash(selected.agentId)}
                  </h3>
                  <span
                    className={cn(
                      'shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border',
                      STATUS_PILL[selected.status]
                    )}
                  >
                    {selected.status}
                  </span>
                </div>
                <div className="mb-4">
                  <CopyableId value={selected.agentId} />
                </div>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between items-center gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0">Model</span>
                    <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded truncate" title={selected.model}>
                      {selected.model}
                    </span>
                  </div>
                  {selected.agentAddress && (
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-muted-foreground shrink-0">Wallet</span>
                      <CopyableId value={selected.agentAddress} />
                    </div>
                  )}
                  {selected.ownerAddress && (
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-muted-foreground shrink-0">Owner</span>
                      <CopyableId value={selected.ownerAddress} />
                    </div>
                  )}
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Bond</span>
                    <span className="font-semibold text-foreground tabular-nums">{selected.stakeAmount} USDC</span>
                  </div>
                  <div className="pt-4 mt-4 border-t border-border/50 text-[10px] text-muted-foreground uppercase tracking-widest font-medium">
                    Deployed: {new Date(selected.deployedAt).toLocaleString()}
                  </div>
                </div>
              </div>
            )}

            {/* List */}
            {!loaded ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-14 rounded-lg border border-border/40 bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : agents.length === 0 ? (
              <div className="py-12 px-4 text-center rounded-xl border border-dashed border-border text-muted-foreground text-sm bg-muted/20">
                No agents yet. Deploy one to get started.
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 px-4 text-center rounded-xl border border-dashed border-border text-muted-foreground text-xs bg-muted/20">
                No agents match this filter.
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {filtered.map(agent => (
                  <button
                    key={agent.containerId}
                    onClick={() => handleSelect(agent.agentId)}
                    className={cn(
                      'text-left p-3 rounded-lg cursor-pointer transition-all border min-w-0',
                      selected?.agentId === agent.agentId
                        ? 'bg-accent border-primary/30 shadow-sm'
                        : 'bg-background/50 border-border/50 hover:border-border hover:bg-accent/50',
                    )}
                    style={{
                      borderLeftWidth: '4px',
                      borderLeftColor: STATUS_DOT[agent.status],
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="font-bold text-sm truncate">{agent.name ?? shortHash(agent.agentId)}</div>
                      <span
                        className={cn(
                          'shrink-0 text-[9px] font-bold px-1.5 py-px rounded-full uppercase tracking-wider border',
                          STATUS_PILL[agent.status]
                        )}
                      >
                        {agent.status}
                      </span>
                    </div>
                    <div className="text-muted-foreground text-[10px] mt-1 font-mono truncate" title={agent.model}>
                      {agent.model}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Mobile scrim */}
        {sidebarOpen && (
          <div
            className="md:hidden absolute inset-0 z-20 bg-background/60 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </div>

      <DeployAgentModal
        isOpen={isDeployOpen}
        onClose={() => setIsDeployOpen(false)}
        onSuccess={() => {}}
      />
    </div>
  )
}
