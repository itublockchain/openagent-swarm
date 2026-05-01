'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useBalance, useReadContract, useReadContracts } from 'wagmi'
import { Wallet, Bot, ListChecks, ChevronDown, ChevronUp, Loader2, ShieldAlert, ExternalLink, ArrowDownToLine, ArrowUpFromLine, Power } from 'lucide-react'
import { Header } from '@/components/Header'
import { DeployAgentModal } from '@/components/DeployAgentModal'
import { AgentActionModal, type ActionMode } from '@/components/AgentActionModal'
import { CopyableId } from '@/components/ui/copyable-id'
import { cn, shortHash } from '@/lib/utils'
import { ERC20_ABI, CONTRACT_ADDRESSES } from '@/lib/contracts'
import { ogTestnet } from '../../../../lib/wagmi'
import { apiRequest } from '../../../../lib/api'

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
}

interface NodeResult {
  node_id: string
  result: string
}

export default function ProfilePage() {
  const { address, isConnected } = useAccount()
  const usdcAddr = CONTRACT_ADDRESSES.usdc
  const [isDeployOpen, setIsDeployOpen] = useState(false)
  const [actionModal, setActionModal] = useState<{ mode: ActionMode; agent: AgentRecord } | null>(null)

  // ---------- Wallet stats ----------
  const nativeBalanceQ = useBalance({
    address: address as `0x${string}` | undefined,
    chainId: ogTestnet.id,
    query: { enabled: !!address },
  })
  const usdcBalanceQ = useReadContract({
    abi: ERC20_ABI,
    address: usdcAddr,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!usdcAddr, refetchInterval: 10_000 },
  })
  const usdcDecimalsQ = useReadContract({
    abi: ERC20_ABI,
    address: usdcAddr,
    functionName: 'decimals',
    query: { enabled: !!usdcAddr },
  })
  const usdcDecimals = usdcDecimalsQ.data ?? 18

  // ---------- Agents — pulled from /agent/pool, filtered to owner ----------
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)

  const reloadAgents = useCallback(async () => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/agent/pool`)
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

  const myAgents = agents.filter(
    a => address && a.ownerAddress?.toLowerCase() === address.toLowerCase(),
  )

  // Per-agent USDC balances — batched into a single multicall via wagmi.
  const agentBalanceContracts = myAgents
    .filter(a => a.agentAddress)
    .map(a => ({
      abi: ERC20_ABI,
      address: usdcAddr,
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
              Your wallet, agents you&apos;ve deployed, and tasks you&apos;ve submitted.
            </p>
          </header>

          {/* Wallet card */}
          <section className="rounded-xl border border-border bg-card p-5 space-y-3">
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              <Wallet className="w-3 h-3" />
              Connected wallet
            </div>
            {address ? (
              <>
                <div className="font-mono text-sm break-all">
                  <CopyableId value={address} head={10} tail={8} />
                </div>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <Stat
                    label="Native (gas)"
                    value={
                      nativeBalanceQ.data
                        ? `${formatUnits(nativeBalanceQ.data.value, nativeBalanceQ.data.decimals)} ${nativeBalanceQ.data.symbol}`
                        : '—'
                    }
                  />
                  <Stat label="mUSDC" value={`${fmtUsdc(usdcBalanceQ.data as bigint | undefined)} USDC`} />
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">No wallet connected.</div>
            )}
          </section>

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
                {myAgents.map(a => (
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
          </section>

          {/* Tasks */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-muted-foreground" />
              My tasks
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                ({tasks.length})
              </span>
            </h2>

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
                {tasks.map(t => {
                  const isOpen = expanded === t.task_id
                  const loading = resultLoading.has(t.task_id)
                  const cached = resultCache[t.task_id]
                  return (
                    <li key={t.task_id} className="rounded-lg border border-border bg-card overflow-hidden">
                      <button
                        onClick={() => toggleExpand(t.task_id)}
                        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/50 transition-colors"
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
                        </div>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                        )}
                      </button>

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
          </section>
        </div>
      </main>

      <DeployAgentModal isOpen={isDeployOpen} onClose={() => setIsDeployOpen(false)} onSuccess={() => {}} />
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
    </div>
  )
}

// ============================================================
// Sub-components + helpers
// ============================================================

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 border border-border/60 px-3 py-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums mt-0.5">{value}</div>
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
