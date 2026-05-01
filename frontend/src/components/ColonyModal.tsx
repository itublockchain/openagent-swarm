'use client'

import { useEffect, useState } from 'react'
import { Globe, Layers, Loader2, Lock, Plus, Send, Trash2, X } from 'lucide-react'
import { apiRequest } from '../../lib/api'
import { cn, shortHash } from '@/lib/utils'
import { ConfirmModal } from './ConfirmModal'
import { useTaskSubmit } from '@/hooks/useTaskSubmit'

export type ColonyVisibility = 'private' | 'public'

interface ColonySummary {
  id: string
  name: string
  description: string | null
  created_at: string
  member_count: number
}

interface ColonyMember {
  agent_id: string
  added_at: string
  name: string | null
  status: string
  agent_address: string | null
}

interface ColonyDetail {
  id: string
  name: string
  description: string | null
  visibility: ColonyVisibility
  owner: string
  created_at: string
  members: ColonyMember[]
}

interface AgentRecord {
  agentId: string
  name?: string
  agentAddress?: string
  status: string
}

export type ColonyModalMode =
  | { kind: 'create' }
  | { kind: 'detail'; colonyId: string }

interface Props {
  mode: ColonyModalMode
  /** All agents owned by the current user — used to populate the
   *  "add member" dropdown in detail view. */
  myAgents: AgentRecord[]
  onClose: () => void
  /** Fired after any successful mutation so the parent can refetch the
   *  colony list. */
  onChanged: () => void
  /** Fired when the user clicks "Deploy & add" inside detail view. The
   *  parent owns DeployAgentModal mounting; on a successful deploy it
   *  should call the auto-add flow, then re-open this modal in detail
   *  mode for the same colony so the user sees the new member. */
  onRequestDeployAndAdd?: (colonyId: string) => void
}

/**
 * Combined create/detail/manage modal for colonies. Two flows behind one
 * shell so the parent only needs to track a single "active modal" state:
 *   - create  → name + optional description; POST /v1/me/colonies
 *   - detail  → list members, add/remove agents, archive colony
 *
 * Every action goes through /v1/me/colonies (SIWE-JWT). The same endpoints
 * are mounted under /v1/colonies (API key) for SDK consumers — handlers are
 * shared, just behind a different auth resolver.
 */
export function ColonyModal({ mode, myAgents, onClose, onChanged, onRequestDeployAndAdd }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // create-mode state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<ColonyVisibility>('private')

  // detail-mode state
  const [detail, setDetail] = useState<ColonyDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pickedAgent, setPickedAgent] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Per-colony task submit form state. The hook owns the multi-stage tx
  // flow (prepare → approve → createTask → /task) so this component only
  // tracks the input fields and the latest "task dispatched" id for the
  // success affordance.
  const [taskSpec, setTaskSpec] = useState('')
  const [taskBudget, setTaskBudget] = useState<number>(10)
  const [lastTaskId, setLastTaskId] = useState<string | null>(null)
  const taskSubmit = useTaskSubmit()

  useEffect(() => {
    setError(null)
    setName('')
    setDescription('')
    setVisibility('private')
    setDetail(null)
    setPickedAgent('')
    setTaskSpec('')
    setTaskBudget(10)
    setLastTaskId(null)
    taskSubmit.reset()

    if (mode.kind === 'detail') {
      void loadDetail(mode.colonyId)
    }
    // mode.kind / colonyId switch resets everything; intentional dependencies
    // are the discriminator + colonyId only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind, mode.kind === 'detail' ? mode.colonyId : null])

  const loadDetail = async (id: string) => {
    setDetailLoading(true)
    setError(null)
    try {
      const res = await apiRequest(`/v1/me/colonies/${id}`)
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `failed (${res.status})`)
      }
      const data = (await res.json()) as ColonyDetail
      setDetail(data)
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setDetailLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Colony name is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await apiRequest('/v1/me/colonies', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          visibility,
        }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `create failed (${res.status})`)
      }
      onChanged()
      onClose()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleAddMember = async () => {
    if (!detail || !pickedAgent) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiRequest(`/v1/me/colonies/${detail.id}/agents`, {
        method: 'POST',
        body: JSON.stringify({ agent_id: pickedAgent }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `add failed (${res.status})`)
      }
      setPickedAgent('')
      await loadDetail(detail.id)
      onChanged()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRemoveMember = async (agentId: string) => {
    if (!detail) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiRequest(
        `/v1/me/colonies/${detail.id}/agents/${agentId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `remove failed (${res.status})`)
      }
      await loadDetail(detail.id)
      onChanged()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleVisibility = async () => {
    if (!detail) return
    const next: ColonyVisibility = detail.visibility === 'public' ? 'private' : 'public'
    setBusy(true)
    setError(null)
    try {
      const res = await apiRequest(`/v1/me/colonies/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility: next }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `update failed (${res.status})`)
      }
      await loadDetail(detail.id)
      onChanged()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSubmitTask = async () => {
    if (!detail || !taskSpec.trim()) return
    const result = await taskSubmit.submit({
      spec: taskSpec.trim(),
      budget: String(taskBudget),
      colonyId: detail.id,
    })
    if (result) {
      setLastTaskId(result.taskId)
      setTaskSpec('')
      onChanged()
    }
  }

  const handleArchive = async () => {
    setShowDeleteConfirm(true)
  }

  const handleActualArchive = async () => {
    if (!detail) return
    setShowDeleteConfirm(false)
    setBusy(true)
    setError(null)
    try {
      const res = await apiRequest(`/v1/me/colonies/${detail.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `archive failed (${res.status})`)
      }
      onChanged()
      onClose()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  // Build the "agents available to add" list — exclude already-member agents.
  const memberIds = new Set(detail?.members.map(m => m.agent_id) ?? [])
  const addableAgents = myAgents.filter(a => !memberIds.has(a.agentId))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-200 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <Layers className="w-4 h-4" />
            {mode.kind === 'create' ? 'Create colony' : detail?.name ?? 'Colony'}
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-full p-1 hover:bg-accent text-muted-foreground transition-colors disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {mode.kind === 'create' && (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground leading-snug">
              Curated agent group. Tasks tagged with this colony only run on
              member agents; tasks without a colony stay public.
            </p>
            <div>
              <label className="text-xs font-medium text-foreground">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. research-team"
                maxLength={60}
                disabled={busy}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground">
                Description <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What is this colony for?"
                rows={2}
                maxLength={500}
                disabled={busy}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none disabled:opacity-60"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground mb-1 block">Visibility</label>
              <div className="grid grid-cols-2 gap-1.5">
                {(['private', 'public'] as ColonyVisibility[]).map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVisibility(v)}
                    disabled={busy}
                    className={cn(
                      'flex flex-col items-center gap-1 px-3 py-2 rounded-md border text-xs transition-colors disabled:opacity-60',
                      visibility === v
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted',
                    )}
                  >
                    <div className="flex items-center gap-1 font-semibold">
                      {v === 'private' ? <Lock className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                      {v === 'private' ? 'Private' : 'Public'}
                    </div>
                    <span className="text-[9px] leading-tight text-muted-foreground/80">
                      {v === 'private' ? 'Only you submit tasks' : 'Anyone can submit tasks'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={handleCreate}
              disabled={busy || !name.trim()}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? 'Creating…' : 'Create colony'}
            </button>
          </div>
        )}

        {mode.kind === 'detail' && (
          <div className="space-y-4">
            {detailLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading colony…
              </div>
            )}
            {detail && (
              <>
                {detail.description && (
                  <p className="text-[11px] text-muted-foreground italic">
                    {detail.description}
                  </p>
                )}

                {/* Visibility row — current state + flip button. Public means
                    other users can dispatch tasks here; private locks it to
                    the owner. Membership management is owner-only either way. */}
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-muted/40 border border-border/50">
                  <div className="flex items-center gap-1.5">
                    {detail.visibility === 'public' ? (
                      <Globe className="w-3.5 h-3.5 text-blue-500" />
                    ) : (
                      <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                    <div className="text-[11px]">
                      <div className="font-semibold">
                        {detail.visibility === 'public' ? 'Public colony' : 'Private colony'}
                      </div>
                      <div className="text-muted-foreground text-[10px]">
                        {detail.visibility === 'public'
                          ? 'Any user can submit tasks here'
                          : 'Only you can submit tasks'}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={handleToggleVisibility}
                    disabled={busy}
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40 whitespace-nowrap"
                  >
                    Make {detail.visibility === 'public' ? 'private' : 'public'}
                  </button>
                </div>

                {/* Per-colony task submit. Drives useTaskSubmit which signs
                    USDC.approve + createTask via the connected wallet, then
                    POSTs /task with colonyId so only this colony's agents
                    pick it up. Empty colonies still expose the form — the
                    backend will accept the task but no agent will claim it
                    (the warning above flags zero-member). */}
                <div className="space-y-2 pt-1 pb-3 border-b border-border/50">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center justify-between">
                    <span>Submit task to this colony</span>
                    {lastTaskId && (
                      <a
                        href={`/explorer?taskId=${lastTaskId}`}
                        className="text-[9px] text-primary hover:underline normal-case tracking-normal"
                        title="View latest dispatch in explorer"
                      >
                        last → {lastTaskId.slice(0, 8)}…
                      </a>
                    )}
                  </div>
                  <textarea
                    value={taskSpec}
                    onChange={e => setTaskSpec(e.target.value)}
                    placeholder="Describe the intent for this colony's agents…"
                    rows={2}
                    disabled={taskSubmit.step !== 'idle' && taskSubmit.step !== 'done' && taskSubmit.step !== 'error'}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none disabled:opacity-60"
                  />
                  <div className="flex items-center gap-2">
                    <div className="inline-flex items-center h-7 rounded border border-border bg-muted focus-within:border-foreground/30">
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        step={1}
                        value={taskBudget}
                        onChange={e => {
                          const n = Number(e.target.value)
                          if (Number.isFinite(n)) setTaskBudget(Math.max(1, Math.min(1000, Math.floor(n))))
                        }}
                        disabled={taskSubmit.step !== 'idle' && taskSubmit.step !== 'done' && taskSubmit.step !== 'error'}
                        className="w-12 h-full bg-transparent px-1.5 text-[11px] leading-none text-right text-foreground/80 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:opacity-60"
                      />
                      <span className="pr-1.5 text-[10px] leading-none text-muted-foreground">USDC</span>
                    </div>
                    <button
                      onClick={handleSubmitTask}
                      disabled={!taskSpec.trim() || (taskSubmit.step !== 'idle' && taskSubmit.step !== 'done' && taskSubmit.step !== 'error')}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {taskSubmit.step === 'preparing' && <><Loader2 className="w-3 h-3 animate-spin" /> Preparing…</>}
                      {taskSubmit.step === 'approving' && <><Loader2 className="w-3 h-3 animate-spin" /> Approve USDC…</>}
                      {taskSubmit.step === 'creating' && <><Loader2 className="w-3 h-3 animate-spin" /> Creating…</>}
                      {taskSubmit.step === 'submitting' && <><Loader2 className="w-3 h-3 animate-spin" /> Dispatching…</>}
                      {(taskSubmit.step === 'idle' || taskSubmit.step === 'done' || taskSubmit.step === 'error') && (
                        <><Send className="w-3 h-3" /> Dispatch</>
                      )}
                    </button>
                  </div>
                  {detail.members.length === 0 && (
                    <p className="text-[10px] text-yellow-600 dark:text-yellow-500 italic">
                      ⚠ Colony has no members — tasks dispatched here will hang until you add an agent.
                    </p>
                  )}
                  {taskSubmit.error && (
                    <p className="text-[10px] text-red-500 italic">{taskSubmit.error}</p>
                  )}
                </div>

                {/* Members */}
                <div className="space-y-1.5">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Members ({detail.members.length})
                  </div>
                  {detail.members.length === 0 ? (
                    <div className="text-xs italic text-muted-foreground py-2">
                      No agents yet — tasks routed here will hang. Add at least one below.
                    </div>
                  ) : (
                    <ul className="space-y-1">
                      {detail.members.map(m => (
                        <li
                          key={m.agent_id}
                          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-muted/40 border border-border/50"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium truncate">
                              {m.name ?? shortHash(m.agent_id)}
                            </div>
                            <div className="text-[10px] font-mono text-muted-foreground">
                              {m.status}
                            </div>
                          </div>
                          <button
                            onClick={() => handleRemoveMember(m.agent_id)}
                            disabled={busy}
                            className="text-muted-foreground hover:text-red-500 disabled:opacity-30"
                            title="Remove from colony"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Add member */}
                {addableAgents.length > 0 && (
                  <div className="space-y-1.5 pt-2 border-t border-border/50">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Add agent
                    </div>
                    <div className="flex gap-1.5">
                      <select
                        value={pickedAgent}
                        onChange={e => setPickedAgent(e.target.value)}
                        disabled={busy}
                        className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                      >
                        <option value="">— choose an agent —</option>
                        {addableAgents.map(a => (
                          <option key={a.agentId} value={a.agentId}>
                            {a.name ?? shortHash(a.agentId)} ({a.status})
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={handleAddMember}
                        disabled={busy || !pickedAgent}
                        className="px-2 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-40"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )}
                {addableAgents.length === 0 && memberIds.size > 0 && (
                  <p className="text-[10px] text-muted-foreground italic">
                    All your agents are already members.
                  </p>
                )}

                {/* Deploy a fresh agent directly into this colony. The parent
                    handles DeployAgentModal mounting; on success it calls the
                    add-member endpoint and re-opens this modal so the user
                    sees the new member without manually re-navigating. */}
                {onRequestDeployAndAdd && (
                  <div className="pt-2 border-t border-border/50">
                    <button
                      onClick={() => onRequestDeployAndAdd(detail.id)}
                      disabled={busy}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-primary/30 bg-primary/5 text-foreground text-xs font-medium hover:bg-primary/10 transition-colors disabled:opacity-40"
                    >
                      <Plus className="w-3 h-3" />
                      Deploy new agent into this colony
                    </button>
                  </div>
                )}

                <div className="pt-3 border-t border-border/50">
                  <button
                    onClick={handleArchive}
                    disabled={busy}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/5 text-red-500 text-xs font-medium hover:bg-red-500/10 transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete colony
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {error && (
          <div className={cn(
            'mt-4 text-[11px] px-3 py-2 rounded-md border',
            'border-red-500/30 bg-red-500/10 text-red-500',
          )}>
            {error}
          </div>
        )}

        <ConfirmModal
          isOpen={showDeleteConfirm}
          title="Delete Colony"
          message={`Are you sure you want to delete "${detail?.name}"? Members are preserved for audit but the colony will stop routing tasks immediately.`}
          confirmText="Delete Colony"
          isDestructive={true}
          isLoading={busy}
          onConfirm={handleActualArchive}
          onClose={() => setShowDeleteConfirm(false)}
        />
      </div>
    </div>
  )
}
