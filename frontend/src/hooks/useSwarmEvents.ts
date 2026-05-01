'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { wsClient, WSEvent } from '../lib/ws'
import { EventType, TranscriptStep } from '../../../shared/types'

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
}

export interface DAGState {
  taskId: string
  boxes: SubtaskBox[]
}

export function useSwarmEvents() {
  const searchParams = useSearchParams()
  const router = useRouter()

  // URL'den taskId al
  const taskIdFromUrl = searchParams.get('taskId')

  const [dag, setDag] = useState<DAGState | null>(null)
  const [events, setEvents] = useState<WSEvent[]>([])

  // taskId URL'e yaz
  const setTaskId = useCallback((taskId: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('taskId', taskId)
    router.replace(`?${params.toString()}`)
  }, [router, searchParams])

  // --- Initial State Fetch ---
  useEffect(() => {
    if (taskIdFromUrl && !dag) {
      const fetchState = async () => {
        try {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/task/${taskIdFromUrl}`)
          const data = await res.json()
          if (data && data.dag) {
            setDag({
              taskId: taskIdFromUrl,
              boxes: data.dag.nodes.map((n: any) => ({
                nodeId: n.id,
                subtask: n.subtask,
                status: n.status || 'idle',
                agentId: n.agentId,
                outputHash: n.outputHash,
                passes: [],
              }))
            })
          }
        } catch (err) {
          console.error('[useSwarmEvents] Failed to fetch task state:', err)
        }
      }
      fetchState()
    }
  }, [taskIdFromUrl, dag])

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001/ws'
    wsClient.connect(apiUrl)

    const handleAll = (event: WSEvent) => {
      console.log('[useSwarmEvents] Incoming event:', event.type, event.payload);
      setEvents(prev => [event, ...prev].slice(0, 50))
    }

    const matchesActiveTask = (taskId: string): boolean => {
      if (!taskIdFromUrl) return true
      return taskId.startsWith(taskIdFromUrl) || taskIdFromUrl.startsWith(taskId)
    }

    const updateBox = (nodeId: string, taskId: string, patch: (b: SubtaskBox) => SubtaskBox) => {
      if (!matchesActiveTask(taskId)) return
      setDag(prev => prev ? {
        ...prev,
        boxes: prev.boxes.map(b => b.nodeId === nodeId ? patch(b) : b),
      } : null)
    }

    const handleDAGReady = (event: WSEvent) => {
      const { nodes, taskId } = event.payload as any
      console.log('[useSwarmEvents] DAG_READY received for task:', taskId);

      if (!taskIdFromUrl || matchesActiveTask(taskId)) {
        setDag({
          taskId,
          boxes: nodes.map((n: any) => ({
            nodeId: n.id,
            subtask: n.subtask,
            status: 'idle',
            passes: [],
          })),
        });
        if (!taskIdFromUrl) setTaskId(taskId);
      }
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

    wsClient.on('*', handleAll)
    wsClient.on(EventType.DAG_READY, handleDAGReady)
    wsClient.on(EventType.SUBTASK_CLAIMED, handleSubtaskClaimed)
    wsClient.on(EventType.SUBTASK_DONE, handleSubtaskDone)
    wsClient.on(EventType.SUBTASK_VALIDATED, handleSubtaskValidated)
    wsClient.on(EventType.SUBTASK_PEER_VALIDATED, handleSubtaskPeerValidated)
    wsClient.on(EventType.AGENT_PASSED, handleAgentPassed)
    wsClient.on(EventType.JUROR_COMMITTED, handleJurorCommitted)
    wsClient.on(EventType.JUROR_VOTED, handleJurorVoted)
    wsClient.on(EventType.CHALLENGE, handleChallenge)
    wsClient.on(EventType.TASK_REOPENED, handleTaskReopened)

    return () => {
      wsClient.off('*', handleAll)
      wsClient.off(EventType.DAG_READY, handleDAGReady)
      wsClient.off(EventType.SUBTASK_CLAIMED, handleSubtaskClaimed)
      wsClient.off(EventType.SUBTASK_DONE, handleSubtaskDone)
      wsClient.off(EventType.SUBTASK_VALIDATED, handleSubtaskValidated)
      wsClient.off(EventType.SUBTASK_PEER_VALIDATED, handleSubtaskPeerValidated)
      wsClient.off(EventType.AGENT_PASSED, handleAgentPassed)
      wsClient.off(EventType.JUROR_COMMITTED, handleJurorCommitted)
      wsClient.off(EventType.JUROR_VOTED, handleJurorVoted)
      wsClient.off(EventType.CHALLENGE, handleChallenge)
      wsClient.off(EventType.TASK_REOPENED, handleTaskReopened)
    }
  }, [taskIdFromUrl, setTaskId])

  return { dag, events, taskIdFromUrl }
}
