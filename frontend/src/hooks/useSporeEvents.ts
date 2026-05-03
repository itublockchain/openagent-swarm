'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { wsClient, WSEvent } from '../lib/ws'
import { EventType, TranscriptStep } from '../../../shared/types'
import { ENV } from '../../lib/env'
import { apiRequest } from '../../lib/api'
import { useAuth } from '../context/AuthContext'

export type SubtaskStatus = 'idle' | 'claimed' | 'pending' | 'done' | 'failed'

export interface JuryTally {
  guilty: number
  innocent: number
  voters: string[] // agentIds that have revealed (commit-reveal phase 2)
  /** agentIds that have committed but not yet revealed (commit-reveal
   *  phase 1). During the 20s commit window this fills before voters
   *  does — UI surfaces the pending count so the dispute doesn't look
   *  silent until reveals burst in. */
  committed: string[]
}

/** Slash overlay attached to a node and/or the planner. Carries enough
 *  context for the UI to render a tooltip ("Slashed: validation_failed —
 *  0.50 USDC") without a follow-up fetch. Reason is the SwarmAgent
 *  CHALLENGE-event reason when a challenge preceded the slash, otherwise
 *  the SlashWatcher fallback string ('on_chain_slash'). */
export interface SlashInfo {
  agentId: string | null
  agentAddress: string
  amount: string
  reason: string
  slashedAt?: string
}

export interface SubtaskBox {
  nodeId: string
  subtask: string
  /** Lifecycle:
   *    idle      → planner just registered the DAG, no one has claimed
   *    claimed   → an agent locked stake + raced FCFS
   *    pending   → output written to 0G Storage + on-chain hash submitted,
   *                awaiting validation
   *    done      → on-chain markValidated landed (green / final)
   *    failed    → challenge raised, awaiting / completed slash; also used
   *                while a node is being re-auctioned after a successful slash */
  status: SubtaskStatus
  agentId?: string
  outputHash?: string
  /** Agents whose self-selection assess() returned NO. Surfaced as small
   *  badges so viewers see the skill filter at work. */
  passes: string[]
  /** Live jury tally while a CHALLENGE is open. Updated by JUROR_VOTED. */
  jury?: JuryTally
  /** Final answer text from the agent, captured from SUBTASK_DONE. Used
   *  by the explorer's per-node detail panel. */
  result?: string
  /** Names of tools the agent invoked while solving the subtask. */
  toolsUsed?: string[]
  /** Step-by-step reasoning trace (tool calls + final). Tool outputs are
   *  truncated server-side to ~2KB; the canonical untruncated trace lives
   *  at `outputHash` in 0G Storage. */
  transcript?: TranscriptStep[]
  /** Loop iteration count + termination reason — surfaced in the panel's
   *  summary row. */
  iterations?: number
  stopReason?: 'final' | 'max_iter' | 'deadline' | 'parse_error' | 'no_chat'
  /** Set when SlashWatcher recorded a slash for the agent that claimed
   *  this subtask. Drives the per-node red overlay + tooltip. */
  slash?: SlashInfo
}

export interface DAGState {
  taskId: string
  plannerId?: string
  /** Set when the planner agent itself was slashed. The explorer renders
   *  the planner node red + shows a banner with the reason instead of
   *  the "Awaiting…" placeholder. */
  plannerSlash?: SlashInfo
  finalResult?: string
  /** True after DAG_VALIDATING fires (last subtask submitted on-chain,
   *  keeper still has to judge + markValidatedBatch + settle). Cleared
   *  when DAG_COMPLETED arrives. UI uses this to show "waiting keeper
   *  approval" instead of "done" during the in-between window. */
  validating?: boolean
  boxes: SubtaskBox[]
}

export function useSporeEvents() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { jwt, address } = useAuth()

  // URL'den taskId al
  const taskIdFromUrl = searchParams.get('taskId')

  const [dag, setDag] = useState<DAGState | null>(null)
  const [events, setEvents] = useState<WSEvent[]>([])
  // True when the deep-linked taskId belongs to someone else (or doesn't
  // exist). Surfaced by the explorer page as a "you don't have access"
  // empty state instead of leaving the canvas blank as if loading.
  const [accessDenied, setAccessDenied] = useState(false)

  // taskId URL'e yaz
  const setTaskId = useCallback((taskId: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('taskId', taskId)
    router.replace(`?${params.toString()}`)
  }, [router, searchParams])

  // --- Initial State Fetch ---
  useEffect(() => {
    if (!taskIdFromUrl) {
      setAccessDenied(false)
      return
    }
    if (dag) return
    // /task/:id is owner-gated server-side; apiRequest stamps the JWT
    // automatically so the backend can verify the caller. 401/403/404
    // all collapse to "no access for this viewer" — the explorer paints
    // an unauthorized empty state and waits for the user to navigate
    // away (or sign in as the owner).
    const fetchState = async () => {
      try {
        const res = await apiRequest(`/task/${taskIdFromUrl}`)
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          setAccessDenied(true)
          setDag(null)
          return
        }
        if (!res.ok) {
          console.error('[useSporeEvents] task fetch non-OK:', res.status)
          return
        }
        const data = await res.json()
        if (data && data.dag) {
          setAccessDenied(false)

          // Backend hydrates `slashes: [{ node_id, agent_id, amount,
          // reason, agent_address, slashed_at }]` and `planner: { agent_id,
          // slashed, slash_reason, slash_amount }`. Project them into
          // per-node SlashInfo + a single plannerSlash so the UI can
          // render the red overlays without replaying the SLASH_EXECUTED
          // event timeline.
          const slashByNode = new Map<string, SlashInfo>()
          if (Array.isArray(data.slashes)) {
            for (const s of data.slashes) {
              if (!s.node_id) continue
              slashByNode.set(s.node_id, {
                agentId: s.agent_id ?? null,
                agentAddress: s.agent_address,
                amount: s.amount,
                reason: s.reason,
                slashedAt: s.slashed_at,
              })
            }
          }
          const plannerSlash: SlashInfo | undefined =
            data.planner?.slashed && data.planner?.slash_reason
              ? {
                  agentId: data.planner.agent_id ?? null,
                  agentAddress: '',
                  amount: data.planner.slash_amount ?? '0',
                  reason: data.planner.slash_reason,
                }
              : undefined

          setDag({
            taskId: taskIdFromUrl,
            plannerId:
              data.planner?.agent_id || data.plannerId || data.dag.plannerAgentId,
            plannerSlash,
            boxes: data.dag.nodes.map((n: any) => ({
              nodeId: n.id,
              subtask: n.subtask,
              status: n.status || 'idle',
              agentId: n.agentId,
              outputHash: n.outputHash,
              passes: [],
              // Reasoning payload from the API's persisted SUBTASK_DONE row.
              // Lets the per-node detail panel repaint after refresh
              // instead of waiting for a (never-coming) live event.
              result: n.result,
              toolsUsed: n.toolsUsed,
              transcript: n.transcript,
              iterations: n.iterations,
              stopReason: n.stopReason,
              slash: slashByNode.get(n.id),
            }))
          })
        }
        if (Array.isArray(data.events)) {
          // Replay history into the local events state. LogsPanel/explorer
          // will pick these up and format them into terminal rows.
          // Reverse so latest is index 0 for the UI's .reverse().map() logic.
          setEvents(data.events.reverse())
        }
      } catch (err) {
        console.error('[useSporeEvents] Failed to fetch task state:', err)
      }
    }
    fetchState()
  }, [taskIdFromUrl, dag])

  useEffect(() => {
    const apiUrl = ENV.WS_URL
    wsClient.connect(apiUrl, { token: jwt })
    // Subscribing to a deep-linked taskId is required when the viewer
    // doesn't own it (anonymous browser, or a different wallet). Owners
    // get their own task events automatically via the JWT-scoped channel.
    if (taskIdFromUrl) {
      wsClient.subscribe(taskIdFromUrl)
    }

    const handleAll = (event: WSEvent) => {
      console.log('[useSporeEvents] Incoming event:', event.type, event.payload);
      setEvents(prev => [event, ...prev].slice(0, 50))
    }

    // Server says we're not allowed to watch this task. Mirrors the REST
    // 403 path so a user who landed via deep link sees the same "no
    // access" state regardless of whether they had a stale fetch result
    // cached or not.
    const handleSubscribeRejected = (event: WSEvent) => {
      const { taskId } = event.payload as any
      if (taskId === taskIdFromUrl) {
        setAccessDenied(true)
        setDag(null)
      }
    }

    // Backend already scopes per-user / per-subscription, so any taskId
    // we receive is one we're entitled to see. We still gate updates to
    // the local `dag` state on "is this the task currently displayed in
    // this tab" so multi-tab usage (own task in tab A, watching another
    // in tab B) doesn't clobber B's box state with A's events.
    const matchesActiveTask = (taskId: string): boolean => {
      if (!taskIdFromUrl) return true
      return taskId === taskIdFromUrl
    }

    const updateBox = (nodeId: string, taskId: string, patch: (b: SubtaskBox) => SubtaskBox) => {
      if (!matchesActiveTask(taskId)) return
      setDag(prev => prev ? {
        ...prev,
        boxes: prev.boxes.map(b => b.nodeId === nodeId ? patch(b) : b),
      } : null)
    }

    const handleDAGReady = (event: WSEvent) => {
      const { nodes, taskId, plannerAgentId, submittedBy } = event.payload as any
      console.log('[useSporeEvents] DAG_READY received for task:', taskId);

      // Replace the dag in two cases:
      //   1. This tab is already pinned to that taskId (URL match).
      //   2. URL is empty AND the connected wallet submitted this task
      //      — the user just kicked one off and the URL hasn't been
      //      stamped yet; auto-pin to it.
      // Ownership is checked client-side too (defense in depth — the
      // backend already filters, but with subscribe(), other tasks can
      // arrive on this socket; without this guard a deep-link viewer
      // would also have its empty-state replaced by the watched task).
      const isCurrent = taskIdFromUrl && taskId === taskIdFromUrl
      const isOwnFreshTask =
        !taskIdFromUrl &&
        typeof submittedBy === 'string' &&
        address &&
        submittedBy.toLowerCase() === address.toLowerCase()

      if (!isCurrent && !isOwnFreshTask) return

      setDag({
        taskId,
        plannerId: plannerAgentId,
        boxes: nodes.map((n: any) => ({
          nodeId: n.id,
          subtask: n.subtask,
          status: 'idle',
          passes: [],
        })),
      });
      if (!taskIdFromUrl) setTaskId(taskId);
    }

    // Last subtask submitted on-chain but keeper hasn't validated/settled
    // yet. Flip the dag into "validating" so the UI shows "waiting keeper
    // approval" until DAG_COMPLETED arrives.
    const handleDAGValidating = (event: WSEvent) => {
      const { taskId } = event.payload as any
      if (!matchesActiveTask(taskId)) return
      setDag(prev => prev ? { ...prev, validating: true } : null)
    }

    const handleDAGCompleted = (event: WSEvent) => {
      const { taskId, result } = event.payload as any
      if (!matchesActiveTask(taskId)) return
      setDag(prev => prev ? { ...prev, validating: false, finalResult: result } : null)
    }

    const handleSubtaskClaimed = (event: WSEvent) => {
      const { nodeId, agentId, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => ({ ...b, status: 'claimed', agentId }))
    }

    // Worker submitted output → on-chain hash recorded → awaiting batch
    // validation. The userflow's "yellow / pending validation" state.
    // Also captures the reasoning payload (result / transcript / tools)
    // so the explorer's detail panel has it without a second round-trip.
    const handleSubtaskDone = (event: WSEvent) => {
      const { nodeId, outputHash, taskId, result, toolsUsed, transcript, iterations, stopReason } = event.payload as any
      updateBox(nodeId, taskId, b => ({
        ...b,
        status: 'pending',
        outputHash,
        result,
        toolsUsed,
        transcript,
        iterations,
        stopReason,
      }))
    }

    // Planner / keeper batch-validated this node on-chain. Promote to green.
    const handleSubtaskValidated = (event: WSEvent) => {
      const { nodeId, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => ({ ...b, status: 'done' }))
    }

    // Next worker's LLM-Judge accepted this output and is using it as context.
    // Optimistic green ahead of the planner's on-chain finality at DAG end.
    const handleSubtaskPeerValidated = (event: WSEvent) => {
      const { nodeId, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => b.status === 'done' ? b : { ...b, status: 'done' })
    }

    // Self-selection said NO. Track agents that passed for the badge UI.
    const handleAgentPassed = (event: WSEvent) => {
      const { nodeId, agentId, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => (
        b.passes.includes(agentId) ? b : { ...b, passes: [...b.passes, agentId] }
      ))
    }

    // Commit phase (~20s): a juror has sealed their verdict but hasn't
    // revealed it yet. We bump `committed` so the UI shows "X jurors
    // committed" instead of staying silent until the reveal burst.
    const handleJurorCommitted = (event: WSEvent) => {
      const { nodeId, agentId, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => {
        const tally = b.jury ?? { guilty: 0, innocent: 0, voters: [], committed: [] }
        if (tally.committed.includes(agentId)) return b
        return {
          ...b,
          jury: {
            ...tally,
            committed: [...tally.committed, agentId],
          },
        }
      })
    }

    // Live jury tally for an open CHALLENGE — reveal phase only. Commits
    // come in via JUROR_COMMITTED above; the same agentId then shows up
    // here when it reveals. We don't double-count: committed list keeps
    // the agent listed too (so "pending = committed.length - voters.length"
    // gives the still-to-reveal count).
    const handleJurorVoted = (event: WSEvent) => {
      const { nodeId, agentId, accusedGuilty, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => {
        const tally = b.jury ?? { guilty: 0, innocent: 0, voters: [], committed: [] }
        if (tally.voters.includes(agentId)) return b
        return {
          ...b,
          jury: {
            guilty: tally.guilty + (accusedGuilty ? 1 : 0),
            innocent: tally.innocent + (accusedGuilty ? 0 : 1),
            voters: [...tally.voters, agentId],
            // Defensive: if reveal arrives without a prior commit (network
            // dropped the event), still mark committed so accounting holds.
            committed: tally.committed.includes(agentId) ? tally.committed : [...tally.committed, agentId],
          },
        }
      })
    }

    const handleChallenge = (event: WSEvent) => {
      const { nodeId, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => ({
        ...b,
        status: 'failed',
        // Reset tally for a fresh dispute window — both phases zeroed.
        jury: { guilty: 0, innocent: 0, voters: [], committed: [] },
      }))
    }

    const handleTaskReopened = (event: WSEvent) => {
      const { nodeId, taskId } = event.payload as any
      updateBox(nodeId, taskId, b => ({
        ...b,
        status: 'idle',
        agentId: undefined,
        outputHash: undefined,
        jury: undefined,
      }))
    }

    // SLASH_EXECUTED is the post-on-chain confirmation that an agent's
    // stake was actually burned. CHALLENGE flips the status earlier, but
    // (a) some slash paths skip CHALLENGE (peer-validation reject + direct
    // vault execute), and (b) the per-node tooltip needs the reason +
    // amount, which only this event carries. We update the affected node
    // OR the planner-slash banner depending on which agent was hit.
    const handleSlashExecuted = (event: WSEvent) => {
      const { nodeId, taskId, agentId, agentAddress, amount, reason } =
        event.payload as any
      if (!matchesActiveTask(taskId)) return
      const slash: SlashInfo = {
        agentId: agentId ?? null,
        agentAddress: agentAddress ?? '',
        amount: amount ?? '0',
        reason: reason ?? 'on_chain_slash',
      }
      setDag(prev => {
        if (!prev) return prev
        let nextBoxes = prev.boxes
        if (nodeId) {
          // Per-subtask slash. Flip status to failed AND attach the
          // tooltip payload. Status flip is idempotent — if CHALLENGE
          // already moved us there, we just enrich with the slash data.
          nextBoxes = prev.boxes.map(b =>
            b.nodeId === nodeId
              ? { ...b, status: 'failed' as SubtaskStatus, slash }
              : b,
          )
        }
        // Planner-slash detection: when the slashed agentId matches the
        // planner, surface a top-level banner so the UI can show "Planner
        // X was slashed: <reason>" even if no specific node was tagged
        // (legacy task-level slash, or planner that didn't claim a node).
        const plannerSlashed = !!agentId && agentId === prev.plannerId
        return {
          ...prev,
          boxes: nextBoxes,
          plannerSlash: plannerSlashed ? slash : prev.plannerSlash,
        }
      })
    }

    wsClient.on('*', handleAll)
    wsClient.on('subscribe_rejected', handleSubscribeRejected)
    wsClient.on(EventType.DAG_READY, handleDAGReady)
    wsClient.on(EventType.DAG_VALIDATING, handleDAGValidating)
    wsClient.on(EventType.DAG_COMPLETED, handleDAGCompleted)
    wsClient.on(EventType.SUBTASK_CLAIMED, handleSubtaskClaimed)
    wsClient.on(EventType.SUBTASK_DONE, handleSubtaskDone)
    wsClient.on(EventType.SUBTASK_VALIDATED, handleSubtaskValidated)
    wsClient.on(EventType.SUBTASK_PEER_VALIDATED, handleSubtaskPeerValidated)
    wsClient.on(EventType.AGENT_PASSED, handleAgentPassed)
    wsClient.on(EventType.JUROR_COMMITTED, handleJurorCommitted)
    wsClient.on(EventType.JUROR_VOTED, handleJurorVoted)
    wsClient.on(EventType.CHALLENGE, handleChallenge)
    wsClient.on(EventType.TASK_REOPENED, handleTaskReopened)
    wsClient.on(EventType.SLASH_EXECUTED, handleSlashExecuted)

    return () => {
      wsClient.off('*', handleAll)
      wsClient.off('subscribe_rejected', handleSubscribeRejected)
      wsClient.off(EventType.DAG_READY, handleDAGReady)
      wsClient.off(EventType.DAG_VALIDATING, handleDAGValidating)
      wsClient.off(EventType.DAG_COMPLETED, handleDAGCompleted)
      wsClient.off(EventType.SUBTASK_CLAIMED, handleSubtaskClaimed)
      wsClient.off(EventType.SUBTASK_DONE, handleSubtaskDone)
      wsClient.off(EventType.SUBTASK_VALIDATED, handleSubtaskValidated)
      wsClient.off(EventType.SUBTASK_PEER_VALIDATED, handleSubtaskPeerValidated)
      wsClient.off(EventType.AGENT_PASSED, handleAgentPassed)
      wsClient.off(EventType.JUROR_COMMITTED, handleJurorCommitted)
      wsClient.off(EventType.JUROR_VOTED, handleJurorVoted)
      wsClient.off(EventType.CHALLENGE, handleChallenge)
      wsClient.off(EventType.TASK_REOPENED, handleTaskReopened)
      wsClient.off(EventType.SLASH_EXECUTED, handleSlashExecuted)
      // Drop the watch when navigating away from a deep-linked task so
      // the backend stops streaming us events we no longer care about.
      // Owner-routed events (no explicit subscribe) keep flowing — they
      // depend on the JWT, not on this set.
      if (taskIdFromUrl) {
        wsClient.unsubscribe(taskIdFromUrl)
      }
    }
  }, [taskIdFromUrl, setTaskId, jwt, address])

  return { dag, events, taskIdFromUrl, accessDenied }
}
