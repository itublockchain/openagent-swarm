'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { wsClient, WSEvent } from '../lib/ws'
import { EventType } from '../../../shared/types'

export type SubtaskStatus = 'idle' | 'claimed' | 'pending' | 'done' | 'failed'

export interface SubtaskBox {
  nodeId: string
  subtask: string
  status: SubtaskStatus
  agentId?: string
  outputHash?: string
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
                outputHash: n.outputHash
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

    const handleDAGReady = (event: WSEvent) => {
      const { nodes, taskId } = event.payload as any
      console.log('[useSwarmEvents] DAG_READY received for task:', taskId);

      // If we don't have a taskId in URL, or it matches, update state
      if (!taskIdFromUrl || taskId.startsWith(taskIdFromUrl) || taskIdFromUrl.startsWith(taskId)) {
        setDag({
          taskId,
          boxes: nodes.map((n: any) => ({
            nodeId: n.id,
            subtask: n.subtask,
            status: 'idle',
          })),
        });
        if (!taskIdFromUrl) setTaskId(taskId);
      }
    }

    const handleSubtaskClaimed = (event: WSEvent) => {
      const { nodeId, agentId, taskId } = event.payload as any;
      if (taskIdFromUrl && !taskId.startsWith(taskIdFromUrl) && !taskIdFromUrl.startsWith(taskId)) return;

      setDag(prev => prev ? {
        ...prev,
        boxes: prev.boxes.map(b =>
          b.nodeId === nodeId ? { ...b, status: 'claimed', agentId } : b
        ),
      } : null)
    }

    const handleSubtaskDone = (event: WSEvent) => {
      const { nodeId, outputHash, taskId } = event.payload as any
      if (taskIdFromUrl && !taskId.startsWith(taskIdFromUrl) && !taskIdFromUrl.startsWith(taskId)) return;

      setDag(prev => prev ? {
        ...prev,
        boxes: prev.boxes.map(b =>
          b.nodeId === nodeId ? { ...b, status: 'done', outputHash } : b
        ),
      } : null)
    }

    const handleChallenge = (event: WSEvent) => {
      const { nodeId, taskId } = event.payload as any
      if (taskIdFromUrl && !taskId.startsWith(taskIdFromUrl) && !taskIdFromUrl.startsWith(taskId)) return;

      setDag(prev => prev ? {
        ...prev,
        boxes: prev.boxes.map(b =>
          b.nodeId === nodeId ? { ...b, status: 'failed' } : b
        ),
      } : null)
    }

    const handleTaskReopened = (event: WSEvent) => {
      const { nodeId, taskId } = event.payload as any
      if (taskIdFromUrl && !taskId.startsWith(taskIdFromUrl) && !taskIdFromUrl.startsWith(taskId)) return;

      setDag(prev => prev ? {
        ...prev,
        boxes: prev.boxes.map(b =>
          b.nodeId === nodeId ? { ...b, status: 'idle', agentId: undefined } : b
        ),
      } : null)
    }

    wsClient.on('*', handleAll)
    wsClient.on(EventType.DAG_READY, handleDAGReady)
    wsClient.on(EventType.SUBTASK_CLAIMED, handleSubtaskClaimed)
    wsClient.on(EventType.SUBTASK_DONE, handleSubtaskDone)
    wsClient.on(EventType.CHALLENGE, handleChallenge)
    wsClient.on(EventType.TASK_REOPENED, handleTaskReopened)

    return () => {
      wsClient.off('*', handleAll)
      wsClient.off(EventType.DAG_READY, handleDAGReady)
      wsClient.off(EventType.SUBTASK_CLAIMED, handleSubtaskClaimed)
      wsClient.off(EventType.SUBTASK_DONE, handleSubtaskDone)
      wsClient.off(EventType.CHALLENGE, handleChallenge)
      wsClient.off(EventType.TASK_REOPENED, handleTaskReopened)
    }
  }, [taskIdFromUrl, setTaskId])

  return { dag, events, taskIdFromUrl }
}
