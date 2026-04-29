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

// Failed/errored agents are hidden from the pool view by default. Two ways
// to surface them again (both useful when debugging or testing failure paths):
//
//   1. Build-time:  NEXT_PUBLIC_SHOW_FAILED_AGENTS=true in frontend/.env.local
//                   (requires `npm run dev` restart — Next.js inlines
//                   NEXT_PUBLIC_* at build time)
//   2. Runtime:     ?showFailed=1  on the URL  (no restart, overrides #1)
//                   ?showFailed=0  forces hidden even if the env says true
//
// The runtime URL form additionally swaps the live API for the mock pool
// below — useful for design reviews and screenshots without a backend.
const ENV_SHOW_FAILED = process.env.NEXT_PUBLIC_SHOW_FAILED_AGENTS === 'true'

// Six-agent showcase. Mixed statuses so every visual state (running, error,
// pending, stopped) appears at least once. NOW is captured at module load,
// so a refresh keeps the deployed-at offsets sensible.
const NOW = Date.now()
const MOCK_AGENTS: AgentRecord[] = [
  {
    agentId: '0xa1b2c3d4e5f60011223344556677889900aabbcc',
    name: 'Enes',
    agentAddress: '0xa1b2c3d4e5f60011223344556677889900aabbcc',
    containerId: 'mock-1',
    model: 'gpt-4o-mini',
    stakeAmount: '25',
    status: 'running',
    deployedAt: NOW - 1000 * 60 * 32,
    ownerAddress: '0x0001020304050607080900112233445566778899',
  },
  {
    agentId: '0xb2c3d4e5f6a700112233445566778899aabbccdd',
    name: 'Süleyman',
    agentAddress: '0xb2c3d4e5f6a700112233445566778899aabbccdd',
    containerId: 'mock-2',
    model: 'claude-3-5-sonnet',
    stakeAmount: '50',
    status: 'running',
    deployedAt: NOW - 1000 * 60 * 124,
    ownerAddress: '0x0102030405060708091011121314151617181920',
  },
  {
    agentId: '0xc3d4e5f6a1b200112233445566778899aabbccee',
    name: 'Hulusi',
    agentAddress: '0xc3d4e5f6a1b200112233445566778899aabbccee',
    containerId: 'mock-3',
    model: 'llama-3.1-70b',
    stakeAmount: '15',
    status: 'error',
    deployedAt: NOW - 1000 * 60 * 7,
    ownerAddress: '0x0203040506070809101112131415161718192021',
  },
  {
    agentId: '0xd4e5f6a1b2c300112233445566778899aabbccff',
    name: 'Mehmet',
    agentAddress: '0xd4e5f6a1b2c300112233445566778899aabbccff',
    containerId: 'mock-4',
    model: 'mistral-large',
    stakeAmount: '20',
    status: 'pending',
    deployedAt: NOW - 1000 * 35,
    ownerAddress: '0x0304050607080910111213141516171819202122',
  },
  {
    agentId: '0xe5f6a1b2c3d400112233445566778899aabbcc11',
    name: 'Ayşe',
    agentAddress: '0xe5f6a1b2c3d400112233445566778899aabbcc11',
    containerId: 'mock-5',
    model: 'gpt-4o',
    stakeAmount: '40',
    status: 'error',
    deployedAt: NOW - 1000 * 60 * 58,
    ownerAddress: '0x0405060708091011121314151617181920212223',
  },
  {
    agentId: '0xf6a1b2c3d4e500112233445566778899aabbcc22',
    name: 'Fatma',
    agentAddress: '0xf6a1b2c3d4e500112233445566778899aabbcc22',
    containerId: 'mock-6',
    model: 'claude-3-haiku',
    stakeAmount: '10',
    status: 'stopped',
    deployedAt: NOW - 1000 * 60 * 60 * 5,
    ownerAddress: '0x0506070809101112131415161718192021222324',
  },
]

export default function PoolPage() {
  const [fetchedAgents, setFetchedAgents] = useState<AgentRecord[]>([])
  const [fetchedLoaded, setFetchedLoaded] = useState(false)
  // Track the selected agent by id; derive the full record below so it always
  // reflects the latest poll without a sync-effect.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isDeployOpen, setIsDeployOpen] = useState(false)
  const [search, setSearch] = useState('')
  // Mobile: collapse sidebar by default; toggle to view
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // URL override for the env flag — read once on mount via window.location to
  // avoid a Suspense boundary just for one query param. If absent, fall back
  // to the build-time env default.
  const [showFailedAgents, setShowFailedAgents] = useState(ENV_SHOW_FAILED)
  // The same URL flag also short-circuits the live API and shows the mock
  // showcase pool, so design/UI work needs no backend running.
  const [useMock, setUseMock] = useState(false)
  // One-shot URL → state hop. The second setState trips set-state-in-effect
  // because the rule treats the pair as a cascade; we can't read window
  // during render without breaking SSR, and the effect runs exactly once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('showFailed')
    if (q == null) return
    const on = q === '1' || q === 'true'
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowFailedAgents(on)
    setUseMock(on)
  }, [])

  // Mock mode swaps in the showcase pool as a derived value — no setState
  // dance, so the fetch effect can stay quiet and lint stays clean.
  const agents = useMock ? MOCK_AGENTS : fetchedAgents
  const loaded = useMock || fetchedLoaded

  useEffect(() => {
    if (useMock) return
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/agent/pool`
        )
        const data = await res.json()
        if (!cancelled) setFetchedAgents(data)
      } catch (err) {
        console.error('Failed to load agent pool:', err)
      } finally {
        if (!cancelled) setFetchedLoaded(true)
      }
    }
    load()
    const interval = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [useMock])

  // Drop errored agents up-front (unless the toggle opts back in). Every
  // downstream view (topology, counts, sidebar list, selection) reads from
  // this set so the toggle is honored everywhere at once.
  const visibleAgents = useMemo(
    () => (showFailedAgents ? agents : agents.filter(a => a.status !== 'error')),
    [agents, showFailedAgents]
  )

  const selected = useMemo(
    () => (selectedId ? visibleAgents.find(a => a.agentId === selectedId) ?? null : null),
    [visibleAgents, selectedId]
  )

  const runningCount = useMemo(
    () => visibleAgents.filter(a => a.status === 'running').length,
    [visibleAgents]
  )

  const errorCount = useMemo(
    () => visibleAgents.filter(a => a.status === 'error').length,
    [visibleAgents]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return visibleAgents
    return visibleAgents.filter(a => {
      return (
        (a.name ?? '').toLowerCase().includes(q) ||
        a.agentId.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q) ||
        (a.agentAddress ?? '').toLowerCase().includes(q)
      )
    })
  }, [visibleAgents, search])

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
            <span><span className="opacity-60">Nodes</span> {visibleAgents.length}</span>
            <span className="opacity-30">·</span>
            <span><span className="opacity-60">Running</span> {runningCount}</span>
            {showFailedAgents && errorCount > 0 && (
              <>
                <span className="opacity-30">·</span>
                <span className="text-red-500"><span className="opacity-60">Errored</span> {errorCount}</span>
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
            <TopologyMap agents={visibleAgents} onSelect={handleSelect} selectedAgentId={selected?.agentId ?? null} />

            {/* Empty state overlay */}
            {loaded && visibleAgents.length === 0 && (
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
            {visibleAgents.length > 0 && (
              <div className="absolute bottom-4 left-4 z-20 flex items-center gap-3 bg-background/80 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-border/50 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />Running</span>
                <span className="opacity-30">·</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />Idle</span>
                {showFailedAgents && (
                  <>
                    <span className="opacity-30">·</span>
                    <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />Error</span>
                  </>
                )}
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
            <div className="relative flex items-center">
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
            ) : visibleAgents.length === 0 ? (
              <div className="py-12 px-4 text-center rounded-xl border border-dashed border-border text-muted-foreground text-sm bg-muted/20">
                No agents yet. Deploy one to get started.
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 px-4 text-center rounded-xl border border-dashed border-border text-muted-foreground text-xs bg-muted/20">
                No agents match your search.
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
