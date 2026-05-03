'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useReadContracts } from 'wagmi'
import { Bot, ListChecks, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Loader2, ShieldAlert, ExternalLink, ArrowDownToLine, ArrowUpFromLine, Power, Layers, Plus, Trash2 } from 'lucide-react'
import { Header } from '@/components/Header'
import { DeployAgentModal } from '@/components/DeployAgentModal'
import { AgentActionModal, type ActionMode } from '@/components/AgentActionModal'
import { ColonyModal, type ColonyModalMode } from '@/components/ColonyModal'
import { ConfirmModal } from '@/components/ConfirmModal'
import { CopyableId } from '@/components/ui/copyable-id'
import { cn, shortHash } from '@/lib/utils'
import { ERC20_ABI, CONTRACT_ADDRESSES } from '@/lib/contracts'
import { paymentChain } from '../../../../lib/wagmi'
import { apiRequest } from '../../../../lib/api'
import { ENV } from '../../../../lib/env'

// USDC fixed at 6 decimals (Circle Base Sepolia).
const USDC_DECIMALS = 6

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

interface UserTask {
  task_id: string
  spec: string
  budget: string
  source: 'web' | 'sdk'
  model: string | null
  submitted_at: string
  status: 'pending' | 'completed'
  node_count: number
  final_result: string | null
  /** Planner summary hydrated by /v1/me/tasks. `null` means we still
   *  haven't seen DAG_READY for this task (or its planner column was
   *  never written before the migration that started persisting it).
   *  When `slashed`, the user sees the slash reason inline so a deleted
   *  agent doesn't disappear without explanation. */
  planner: {
    agent_id: string
    slashed: boolean
    slash_reason: string | null
    slash_amount: string | null
  } | null
  /** Total slash records on this task (across all subtasks + planner).
   *  Drives the row-level "N slashes" badge — clicking the row still
   *  takes the user to the explorer for full details. */
  slash_count: number
}

interface NodeResult {
  node_id: string
  result: string
}

interface ColonySummary {
  id: string
  name: string
  description: string | null
  visibility: 'private' | 'public'
  owner: string
  created_at: string
  member_count: number
  task_stats: { total: number; completed: number; pending: number }
}

export default function ProfilePage() {
  const { address, isConnected } = useAccount()
  const usdcAddr = CONTRACT_ADDRESSES.usdc
  const [isDeployOpen, setIsDeployOpen] = useState(false)
  const [actionModal, setActionModal] = useState<{ mode: ActionMode; agent: AgentRecord } | null>(null)
  const [colonyModalMode, setColonyModalMode] = useState<ColonyModalMode | null>(null)
  const [colonies, setColonies] = useState<ColonySummary[]>([])
  const [coloniesLoaded, setColoniesLoaded] = useState(false)
  // When the user clicks "Deploy & add" inside a colony detail modal we
  // stash the colony id here, hide the colony modal, and open the deploy
  // modal. On deploy success we POST the new agentId into this colony, then
  // re-open the colony modal so the user immediately sees the new member.
  const [pendingDeployToColony, setPendingDeployToColony] = useState<string | null>(null)

  const usdcDecimals = USDC_DECIMALS

  // ---------- Agents — pulled from /agent/pool, filtered to owner ----------
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)

  const reloadAgents = useCallback(async () => {
    try {
      const res = await fetch(`${ENV.API_URL}/agent/pool`)
      if (!res.ok) throw new Error(`pool fetch failed (${res.status})`)
      const all = (await res.json()) as AgentRecord[]
      setAgents(all)
    } catch (err) {
      console.error('[profile] pool error:', err)
    } finally {
      setAgentsLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!isConnected) return
    reloadAgents()
    const t = setInterval(reloadAgents, 10_000)
    return () => clearInterval(t)
  }, [isConnected, reloadAgents])

  // Surface only RUNNING agents — pending ones are mid-deploy (the next
  // 10s poll will lift them once setStatus(RUNNING) confirms on-chain),
  // stopped/error are terminal states the user already finalised (via
  // the Stop button) or can't recover (orphan sweep). The pool view
  // applies the same rule. Trade-off: a brief gap after deploy before
  // the new card appears, instead of showing a transient pending placeholder.
  const myAgents = agents.filter(
    a =>
      address &&
      a.ownerAddress?.toLowerCase() === address.toLowerCase() &&
      a.status === 'running',
  )

  // Pagination state. Three independent indices because the three lists
  // refresh on different cadences and resetting them together would
  // surprise the user (e.g. a colony refresh shouldn't bounce them off
  // page 2 of agents). Each section's page is clamped further down so
  // a deletion that shrinks the list doesn't strand the user past the
  // last page.
  const AGENTS_PER_PAGE = 4
  const COLONIES_PER_PAGE = 4
  const TASKS_PER_PAGE = 8
  const [agentsPage, setAgentsPage] = useState(0)
  const [coloniesPage, setColoniesPage] = useState(0)
  const [tasksPage, setTasksPage] = useState(0)

  // Clamp page indices to the new last-page when a list shrinks (agent
  // stopped, colony archived, etc.). Without this, a delete-from-page-2
  // would render an empty grid until the user pages back manually.
  useEffect(() => {
    const last = Math.max(0, Math.ceil(myAgents.length / AGENTS_PER_PAGE) - 1)
    if (agentsPage > last) setAgentsPage(last)
  }, [myAgents.length, agentsPage])

  const agentsTotalPages = Math.max(1, Math.ceil(myAgents.length / AGENTS_PER_PAGE))
  const visibleAgents = myAgents.slice(
    agentsPage * AGENTS_PER_PAGE,
    (agentsPage + 1) * AGENTS_PER_PAGE,
  )

  useEffect(() => {
    const last = Math.max(0, Math.ceil(colonies.length / COLONIES_PER_PAGE) - 1)
    if (coloniesPage > last) setColoniesPage(last)
  }, [colonies.length, coloniesPage])

  const coloniesTotalPages = Math.max(1, Math.ceil(colonies.length / COLONIES_PER_PAGE))
  const visibleColonies = colonies.slice(
    coloniesPage * COLONIES_PER_PAGE,
    (coloniesPage + 1) * COLONIES_PER_PAGE,
  )

  // Per-agent USDC balances — batched into a single multicall via wagmi.
  // Same chainId pin as above: agent wallets hold real USDC on Base Sepolia,
  // not on whatever chain the user happens to have selected in MetaMask.
  const agentBalanceContracts = myAgents
    .filter(a => a.agentAddress)
    .map(a => ({
      abi: ERC20_ABI,
      address: usdcAddr,
      chainId: paymentChain.id,
      functionName: 'balanceOf' as const,
      args: [a.agentAddress as `0x${string}`] as const,
    }))
  const agentBalancesQ = useReadContracts({
    contracts: agentBalanceContracts,
    query: { enabled: !!usdcAddr && agentBalanceContracts.length > 0, refetchInterval: 15_000 },
  })

  const agentBalanceMap = new Map<string, bigint>()
  if (agentBalancesQ.data) {
    let i = 0
    for (const a of myAgents) {
      if (!a.agentAddress) continue
      const r = agentBalancesQ.data[i++]
      if (r?.status === 'success') agentBalanceMap.set(a.agentId, r.result as bigint)
    }
  }

  // ---------- Tasks ----------
  const [tasks, setTasks] = useState<UserTask[]>([])
  const [tasksLoaded, setTasksLoaded] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [resultCache, setResultCache] = useState<Record<string, NodeResult[] | null>>({})
  const [resultLoading, setResultLoading] = useState<Set<string>>(new Set())
  // Delete confirm flow. `null` = closed; the variant carries enough context
  // to render a tailored prompt (single-row preview vs. clear-all count) and
  // to know which DELETE endpoint to hit on confirm. `deleting` is a
  // separate flag so the spinner stays visible across the in-flight tx
  // even if the modal payload reference is reused.
  const [deletePrompt, setDeletePrompt] = useState<
    | { kind: 'single'; taskId: string; spec: string }
    | { kind: 'all'; count: number }
    | null
  >(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const last = Math.max(0, Math.ceil(tasks.length / TASKS_PER_PAGE) - 1)
    if (tasksPage > last) setTasksPage(last)
  }, [tasks.length, tasksPage])

  const tasksTotalPages = Math.max(1, Math.ceil(tasks.length / TASKS_PER_PAGE))
  const visibleTasks = tasks.slice(
    tasksPage * TASKS_PER_PAGE,
    (tasksPage + 1) * TASKS_PER_PAGE,
  )

  const reloadTasks = useCallback(async () => {
    try {
      const res = await apiRequest('/v1/me/tasks')
      if (!res.ok) throw new Error(`tasks fetch failed (${res.status})`)
      const data = (await res.json()) as { tasks: UserTask[] }
      setTasks(data.tasks)
      setTasksError(null)
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : String(err))
    } finally {
      setTasksLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!isConnected) return
    reloadTasks()
    const t = setInterval(reloadTasks, 8_000)
    return () => clearInterval(t)
  }, [isConnected, reloadTasks])

  const reloadColonies = useCallback(async () => {
    try {
      const res = await apiRequest('/v1/me/colonies')
      if (!res.ok) throw new Error(`colonies fetch failed (${res.status})`)
      const data = (await res.json()) as { colonies: ColonySummary[] }
      setColonies(data.colonies)
    } catch (err) {
      console.error('[profile] colonies error:', err)
    } finally {
      setColoniesLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!isConnected) return
    reloadColonies()
    // Slower refresh than agents/tasks — colonies change rarely (user
    // explicit edits), no need to spam the SQLite read every 8s.
    const t = setInterval(reloadColonies, 30_000)
    return () => clearInterval(t)
  }, [isConnected, reloadColonies])

  // Optimistic local removal lets the row disappear instantly on confirm —
  // the next reloadTasks() poll would catch up anyway, but waiting on it
  // makes the trash-icon click feel laggy. We also drop the cached result
  // so the memory footprint doesn't keep growing on a "clear-all" sweep.
  const handleDeleteConfirm = useCallback(async () => {
    if (!deletePrompt) return
    setDeleting(true)
    try {
      if (deletePrompt.kind === 'single') {
        const { taskId } = deletePrompt
        const res = await apiRequest(`/v1/me/tasks/${encodeURIComponent(taskId)}`, {
          method: 'DELETE',
        })
        if (!res.ok && res.status !== 404) {
          // 404 means the row was already gone (rapid double-click) — treat
          // as success so the UI converges either way.
          throw new Error(`delete failed (${res.status})`)
        }
        setTasks(prev => prev.filter(t => t.task_id !== taskId))
        setResultCache(prev => {
          const { [taskId]: _, ...rest } = prev
          return rest
        })
        if (expanded === taskId) setExpanded(null)
      } else {
        const res = await apiRequest('/v1/me/tasks', { method: 'DELETE' })
        if (!res.ok) throw new Error(`clear failed (${res.status})`)
        setTasks([])
        setResultCache({})
        setExpanded(null)
      }
      setDeletePrompt(null)
    } catch (err) {
      console.error('[profile] delete task failed:', err)
      setTasksError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }, [deletePrompt, expanded])

  const toggleExpand = async (taskId: string) => {
    if (expanded === taskId) {
      setExpanded(null)
      return
    }
    setExpanded(taskId)
    if (resultCache[taskId] !== undefined) return // already fetched
    setResultLoading(prev => new Set(prev).add(taskId))
    try {
      const res = await apiRequest(`/v1/me/tasks/${taskId}/result`)
      if (res.status === 404) {
        setResultCache(prev => ({ ...prev, [taskId]: null }))
        return
      }
      if (!res.ok) throw new Error(`result fetch failed (${res.status})`)
      const data = (await res.json()) as { node_results: NodeResult[] }
      setResultCache(prev => ({ ...prev, [taskId]: data.node_results }))
    } catch {
      setResultCache(prev => ({ ...prev, [taskId]: null }))
    } finally {
      setResultLoading(prev => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  if (!usdcAddr) {
    return (
      <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
        <Header onDeployClick={() => setIsDeployOpen(true)} />
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-3">
            <ShieldAlert className="w-10 h-10 mx-auto text-yellow-500" />
            <h2 className="text-lg font-bold">Contracts not configured</h2>
            <p className="text-sm text-muted-foreground">
              <code className="font-mono bg-muted px-1.5 py-0.5 rounded">NEXT_PUBLIC_USDC_ADDRESS</code> missing in frontend env.
            </p>
          </div>
        </div>
        <DeployAgentModal isOpen={isDeployOpen} onClose={() => setIsDeployOpen(false)} onSuccess={() => {}} />
      </div>
    )
  }

  const fmtUsdc = (n: bigint | undefined) => (n == null ? '—' : formatUnits(n, usdcDecimals))

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
          <header className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
            <p className="text-sm text-muted-foreground">
              Agents you&apos;ve deployed, colonies, and tasks you&apos;ve submitted.
            </p>
          </header>

          {/* Agents */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Bot className="w-4 h-4 text-muted-foreground" />
                My agents
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  ({myAgents.length})
                </span>
              </h2>
              <button
                onClick={() => setIsDeployOpen(true)}
                className="text-xs font-semibold px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors"
              >
                + Deploy new
              </button>
            </div>

            {!agentsLoaded ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="h-28 rounded-lg bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : myAgents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
                You haven&apos;t deployed any agents yet.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {visibleAgents.map(a => (
                  <article
                    key={a.containerId || a.agentId}
                    className="rounded-lg border border-border bg-card p-4 space-y-2"
                    style={{ borderLeftWidth: '4px', borderLeftColor: STATUS_DOT[a.status] }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-bold text-sm truncate">
                        {a.name ?? shortHash(a.agentId)}
                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border',
                          STATUS_PILL[a.status],
                        )}
                      >
                        {a.status}
                      </span>
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground space-y-1">
                      <div className="flex justify-between">
                        <span className="opacity-70">Model</span>
                        <span className="text-foreground/80 truncate max-w-[60%]" title={a.model}>{a.model}</span>
                      </div>
                      {a.agentAddress && (
                        <div className="flex justify-between items-center gap-2">
                          <span className="opacity-70">Wallet</span>
                          <CopyableId value={a.agentAddress} />
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="opacity-70">Bond</span>
                        <span className="text-foreground tabular-nums">{a.stakeAmount} USDC</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="opacity-70">Wallet balance</span>
                        <span className="text-foreground tabular-nums">
                          {fmtUsdc(agentBalanceMap.get(a.agentId))} USDC
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="opacity-70">Deployed</span>
                        <span className="text-foreground/70">{new Date(a.deployedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    {/* Per-agent actions: deposit / withdraw / stop. Stop is
                        only enabled while the container is alive — once it's
                        already stopped the backend has nothing to drain. */}
                    <div className="flex gap-1.5 pt-2 mt-2 border-t border-border/50">
                      <button
                        onClick={() => setActionModal({ mode: 'deposit', agent: a })}
                        disabled={!a.agentAddress}
                        className="flex-1 flex items-center justify-center gap-1 text-[10px] font-medium px-2 py-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40"
                        title="Send USDC to this agent"
                      >
                        <ArrowDownToLine className="w-3 h-3" />
                        Deposit
                      </button>
                      <button
                        onClick={() => setActionModal({ mode: 'withdraw', agent: a })}
                        className="flex-1 flex items-center justify-center gap-1 text-[10px] font-medium px-2 py-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors"
                        title="Pull USDC from this agent to your wallet"
                      >
                        <ArrowUpFromLine className="w-3 h-3" />
                        Withdraw
                      </button>
                      <button
                        onClick={() => setActionModal({ mode: 'stop', agent: a })}
                        disabled={a.status === 'stopped' || a.status === 'error'}
                        className="flex-1 flex items-center justify-center gap-1 text-[10px] font-medium px-2 py-1.5 rounded-md border border-red-500/30 bg-red-500/5 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Stop the agent and reclaim all balances"
                      >
                        <Power className="w-3 h-3" />
                        Stop
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <Pagination
              page={agentsPage}
              totalPages={agentsTotalPages}
              total={myAgents.length}
              onChange={setAgentsPage}
            />
          </section>

          {/* Colonies */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Layers className="w-4 h-4 text-muted-foreground" />
                My colonies
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  ({colonies.length})
                </span>
              </h2>
              <button
                onClick={() => setColonyModalMode({ kind: 'create' })}
                className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors"
              >
                <Plus className="w-3 h-3" />
                New colony
              </button>
            </div>

            {!coloniesLoaded ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="h-20 rounded-lg bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : colonies.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-8 text-center text-sm text-muted-foreground">
                No colonies yet. Create one to scope tasks to a curated subset of your agents.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {visibleColonies.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setColonyModalMode({ kind: 'detail', colonyId: c.id })}
                    className="rounded-lg border border-border bg-card p-4 space-y-2 text-left hover:border-foreground/20 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={cn(
                            'shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider border',
                            c.visibility === 'public'
                              ? 'bg-blue-500/10 text-blue-500 border-blue-500/20'
                              : 'bg-muted text-muted-foreground border-border',
                          )}
                          title={c.visibility === 'public' ? 'Anyone can submit tasks' : 'Only you can submit tasks'}
                        >
                          {c.visibility}
                        </span>
                        <div className="font-bold text-sm truncate">{c.name}</div>
                      </div>
                      <span className="shrink-0 text-[10px] font-mono text-muted-foreground tabular-nums">
                        {c.member_count} agent{c.member_count === 1 ? '' : 's'}
                      </span>
                    </div>
                    {c.description && (
                      <p className="text-[11px] text-muted-foreground leading-snug line-clamp-2">
                        {c.description}
                      </p>
                    )}
                    {/* Task stats — three counts in tight tabular layout. Hidden
                        when zero so brand-new colonies don't show "0 / 0 / 0". */}
                    {c.task_stats.total > 0 && (
                      <div className="flex items-center gap-2 text-[10px] font-mono pt-1 border-t border-border/40">
                        <span className="text-foreground/80 tabular-nums">
                          <span className="text-muted-foreground/70">total</span> {c.task_stats.total}
                        </span>
                        <span className="text-green-600 dark:text-green-500 tabular-nums">
                          <span className="opacity-70">✓</span> {c.task_stats.completed}
                        </span>
                        {c.task_stats.pending > 0 && (
                          <span className="text-yellow-600 dark:text-yellow-500 tabular-nums">
                            <span className="opacity-70">…</span> {c.task_stats.pending}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="text-[10px] font-mono text-muted-foreground/70">
                      {new Date(c.created_at).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <Pagination
              page={coloniesPage}
              totalPages={coloniesTotalPages}
              total={colonies.length}
              onChange={setColoniesPage}
            />
          </section>

          {/* Tasks */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <ListChecks className="w-4 h-4 text-muted-foreground" />
                My tasks
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  ({tasks.length})
                </span>
              </h2>
              {/* Clear-all is a destructive bulk action; gate it behind the
                  same ConfirmModal as single-row delete and only render the
                  button when there's something to clear. */}
              {tasks.length > 0 && (
                <button
                  onClick={() => setDeletePrompt({ kind: 'all', count: tasks.length })}
                  className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md border border-red-500/30 bg-red-500/5 text-red-500 hover:bg-red-500/10 transition-colors"
                  title="Remove every task from your history (does not refund spent USDC)"
                >
                  <Trash2 className="w-3 h-3" />
                  Clear all
                </button>
              )}
            </div>

            {!tasksLoaded ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-12 rounded-lg bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : tasksError ? (
              <div className="text-sm text-red-500">{tasksError}</div>
            ) : tasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
                No tasks submitted yet. Use the Tasks tab to send a swarm intent.
              </div>
            ) : (
              <ul className="space-y-2">
                {visibleTasks.map(t => {
                  const isOpen = expanded === t.task_id
                  const loading = resultLoading.has(t.task_id)
                  const cached = resultCache[t.task_id]
                  return (
                    <li key={t.task_id} className="rounded-lg border border-border bg-card overflow-hidden">
                      {/* Row container is a div, not a button — the trash icon
                          is its own button and React/HTML forbid nesting
                          interactive elements. The expand-area is the
                          flex-1 button; the trash sits as a sibling so the
                          two click targets stay independent. */}
                      <div className="w-full flex items-stretch group">
                        <button
                          onClick={() => toggleExpand(t.task_id)}
                          className="flex-1 min-w-0 px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium truncate">
                                {t.spec.length > 90 ? t.spec.slice(0, 87) + '…' : t.spec}
                              </span>
                              <span
                                className={cn(
                                  'text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider border shrink-0',
                                  t.status === 'completed'
                                    ? 'border-green-500/30 bg-green-500/10 text-green-500'
                                    : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-500',
                                )}
                              >
                                {t.status}
                              </span>
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-muted text-muted-foreground shrink-0">
                                {t.source}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono text-muted-foreground">
                              <span>{shortHash(t.task_id, 8, 6)}</span>
                              <span>{t.budget} USDC</span>
                              {t.model && <span>{t.model}</span>}
                              <span>{new Date(t.submitted_at).toLocaleString()}</span>
                              {t.node_count > 0 && <span>{t.node_count} nodes</span>}
                            </div>
                            {/* Planner footer. Three states matching the
                                explorer planner node:
                                  - missing       → "Planner pending — DAG not built yet"
                                  - clean         → "Planner: 0xab…cd"
                                  - slashed       → red badge + reason
                                Without this row the user can't tell who ran
                                their task, especially after the slashed
                                agent's record was removed from colonies. */}
                            {t.planner ? (
                              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-mono">
                                <span className="text-muted-foreground">Planner:</span>
                                {t.planner.slashed ? (
                                  <span
                                    className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
                                    title={`Slashed ${t.planner.slash_amount ?? '?'} USDC — ${t.planner.slash_reason ?? 'unknown reason'}`}
                                  >
                                    <ShieldAlert className="w-3 h-3" />
                                    {shortHash(t.planner.agent_id, 6, 4)} · slashed ({t.planner.slash_reason ?? 'reason unknown'})
                                  </span>
                                ) : (
                                  <span className="text-foreground/80">{shortHash(t.planner.agent_id, 6, 4)}</span>
                                )}
                                {t.slash_count > 0 && !t.planner.slashed && (
                                  <span className="ml-1 px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/30">
                                    {t.slash_count} slash{t.slash_count > 1 ? 'es' : ''}
                                  </span>
                                )}
                              </div>
                            ) : t.status === 'pending' ? (
                              <div className="mt-1.5 text-[10px] font-mono text-muted-foreground italic">
                                Planner pending — DAG not built yet
                              </div>
                            ) : null}
                            {t.final_result && (
                              <p className="mt-1.5 text-[11px] text-muted-foreground/80 italic line-clamp-1 border-l-2 border-primary/20 pl-2">
                                &ldquo;{t.final_result.length > 120 ? t.final_result.slice(0, 117) + '…' : t.final_result}&rdquo;
                              </p>
                            )}
                          </div>
                          {isOpen ? (
                            <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                          )}
                        </button>
                        {/* Trash icon — separate button, surfaces only on row
                            hover so it doesn't visually compete with the
                            content on resting state. Stops click propagation
                            so the row doesn't expand on icon-click. */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeletePrompt({ kind: 'single', taskId: t.task_id, spec: t.spec })
                          }}
                          className="px-3 flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors opacity-50 group-hover:opacity-100"
                          aria-label="Delete task"
                          title="Delete this task from your history"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      {isOpen && (
                        <div className="border-t border-border/60 bg-background/40 px-4 py-3 space-y-2">
                          {loading && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Loading result…
                            </div>
                          )}
                          {!loading && cached === null && (
                            <div className="text-xs text-muted-foreground italic">
                              Result not available yet — task is still running.
                            </div>
                          )}
                          {!loading && Array.isArray(cached) && cached.length > 0 && (
                            <div className="space-y-2">
                              {cached.map(r => (
                                <div key={r.node_id} className="rounded-md bg-muted/40 border border-border/60 p-2.5">
                                  <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                                    {r.node_id}
                                  </div>
                                  <div className="text-xs whitespace-pre-wrap break-words leading-relaxed">
                                    {r.result}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="pt-1">
                            <a
                              href={`/explorer?taskId=${t.task_id}`}
                              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              Open in Explorer
                            </a>
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            <Pagination
              page={tasksPage}
              totalPages={tasksTotalPages}
              total={tasks.length}
              onChange={setTasksPage}
            />
          </section>
        </div>
      </main>

      <DeployAgentModal
        isOpen={isDeployOpen}
        onClose={() => {
          setIsDeployOpen(false)
          // Cancel any pending colony auto-add — user closed without deploying.
          setPendingDeployToColony(null)
        }}
        onSuccess={async ({ agentId }) => {
          if (pendingDeployToColony) {
            // Auto-add the freshly-deployed agent to the colony the user
            // came from, then re-open ColonyModal so they see the new
            // member without re-navigating.
            const colonyId = pendingDeployToColony
            setPendingDeployToColony(null)
            try {
              await apiRequest(`/v1/me/colonies/${colonyId}/agents`, {
                method: 'POST',
                body: JSON.stringify({ agent_id: agentId }),
              })
            } catch (err) {
              console.error('[profile] auto-add to colony failed:', err)
            }
            await Promise.all([reloadAgents(), reloadColonies()])
            setColonyModalMode({ kind: 'detail', colonyId })
          } else {
            reloadAgents()
            reloadColonies()
          }
        }}
      />
      {actionModal && (
        <AgentActionModal
          mode={actionModal.mode}
          agent={{
            agentId: actionModal.agent.agentId,
            agentAddress: actionModal.agent.agentAddress,
            name: actionModal.agent.name,
            stakeAmount: actionModal.agent.stakeAmount,
          }}
          decimals={usdcDecimals}
          onClose={() => setActionModal(null)}
          onSuccess={() => {
            // Close modal but immediately refetch pool + balances so the
            // updated stake / status / balance shows without a manual reload.
            setActionModal(null)
            reloadAgents()
          }}
        />
      )}
      {colonyModalMode && (
        <ColonyModal
          mode={colonyModalMode}
          myAgents={myAgents.map(a => ({
            agentId: a.agentId,
            name: a.name,
            agentAddress: a.agentAddress,
            status: a.status,
          }))}
          onClose={() => setColonyModalMode(null)}
          onChanged={reloadColonies}
          onRequestDeployAndAdd={(colonyId) => {
            // Hand off to DeployAgentModal — its onSuccess handler reads
            // pendingDeployToColony and POSTs the new agentId into the
            // colony, then re-opens this modal in detail mode for the
            // same colony.
            setPendingDeployToColony(colonyId)
            setColonyModalMode(null)
            setIsDeployOpen(true)
          }}
        />
      )}
      <ConfirmModal
        isOpen={!!deletePrompt}
        isDestructive
        isLoading={deleting}
        title={deletePrompt?.kind === 'all' ? 'Clear all tasks?' : 'Delete task?'}
        message={
          deletePrompt?.kind === 'all'
            ? `Permanently remove ${deletePrompt.count} task${deletePrompt.count === 1 ? '' : 's'} from your history. The on-chain receipts and 0G Storage payloads stay intact — this only clears your dashboard view. USDC already spent is not refunded.`
            : deletePrompt?.kind === 'single'
              ? `Permanently remove this task from your history:\n\n"${deletePrompt.spec.length > 140 ? deletePrompt.spec.slice(0, 137) + '…' : deletePrompt.spec}"\n\nThe on-chain receipt stays intact; this only clears the dashboard row. USDC already spent is not refunded.`
              : ''
        }
        confirmText={deletePrompt?.kind === 'all' ? 'Clear all' : 'Delete'}
        onConfirm={handleDeleteConfirm}
        onClose={() => {
          if (deleting) return // can't dismiss mid-flight; avoids double-submit
          setDeletePrompt(null)
        }}
      />
    </div>
  )
}

// ============================================================
// Sub-components + helpers
// ============================================================

/**
 * Compact prev/next pager. Hidden entirely when totalPages <= 1 so an
 * unfilled list doesn't grow a useless "Page 1 of 1" footer.
 */
function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number
  totalPages: number
  /** Underlying item count — only used to render "n items" alongside the
   *  page indicator so the user can see at a glance whether more exist. */
  total: number
  onChange: (next: number) => void
}) {
  if (totalPages <= 1) return null
  const canPrev = page > 0
  const canNext = page < totalPages - 1
  return (
    <div className="flex items-center justify-end gap-2 pt-1 text-[11px] font-mono text-muted-foreground">
      <span className="tabular-nums">
        {page + 1} / {totalPages}
        <span className="opacity-60"> · {total} total</span>
      </span>
      <button
        onClick={() => canPrev && onChange(page - 1)}
        disabled={!canPrev}
        className="p-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        aria-label="Previous page"
      >
        <ChevronLeft className="w-3 h-3" />
      </button>
      <button
        onClick={() => canNext && onChange(page + 1)}
        disabled={!canNext}
        className="p-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        aria-label="Next page"
      >
        <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  )
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

function formatUnits(value: bigint, decimals: number): string {
  const denom = BigInt(10) ** BigInt(decimals)
  const whole = value / denom
  const frac = value % denom
  if (frac === BigInt(0)) return whole.toString()
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : whole.toString()
}
