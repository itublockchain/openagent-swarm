'use client'

import { useEffect, useState } from 'react'
import { wsClient, WSEvent } from '../lib/ws'

// string literals — no cross-project import needed
const EV = {
  DAG_READY:        'DAG_READY',
  SUBTASK_CLAIMED:  'SUBTASK_CLAIMED',
  SUBTASK_DONE:     'SUBTASK_DONE',
  CHALLENGE:        'CHALLENGE',
  TASK_REOPENED:    'TASK_REOPENED',
} as const

export function useSwarmEvents() {
  const [events, setEvents] = useState<WSEvent[]>([])

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001/ws'
    wsClient.connect(apiUrl)

    const handleAll = (event: WSEvent) => {
      setEvents(prev => [event, ...prev].slice(0, 50))
    }

    wsClient.on('*', handleAll)

    return () => {
      wsClient.off('*', handleAll)
    }
  }, [])

  return { events }
}
