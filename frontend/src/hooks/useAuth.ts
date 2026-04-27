'use client'

import { useConnect } from 'wagmi'
import { useAuth as useAuthContext } from '../context/AuthContext'

export function useAuth() {
  const context = useAuthContext()
  const { connect, connectors, isPending } = useConnect()

  return {
    ...context,
    connect,
    connectors,
    isPending,
  }
}
