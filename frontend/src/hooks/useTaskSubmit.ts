'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { apiRequest, openDepositModal } from '../../lib/api'

export type TaskSubmitStep = 'idle' | 'submitting' | 'done' | 'error'

export interface TaskSubmitOptions {
  spec: string
  /** Decimal USDC string. */
  budget: string
  model?: string
  /** Optional colony scope. Backend rejects (403) when caller isn't the
   *  owner of a private colony or the colony doesn't exist. */
  colonyId?: string
}

export interface TaskSubmitResult {
  taskId: string
  taskIdBytes32: string
}

/**
 * Shared task submission flow used by both the explorer prompt box and
 * the per-colony submitter. The browser only proves SIWE identity (JWT
 * already in apiRequest); the API operator signs `spendOnBehalfOf` on
 * 0G and broadcasts to AXL. No on-chain user signing here anymore.
 */
export function useTaskSubmit(onLog?: (line: string) => void) {
  const [step, setStep] = useState<TaskSubmitStep>('idle')
  const [error, setError] = useState<string | null>(null)
  const { address: walletAddress } = useAccount()

  const log = (line: string) => onLog?.(line)

  const submit = async (opts: TaskSubmitOptions): Promise<TaskSubmitResult | null> => {
    if (!walletAddress) {
      setError('Connect your wallet first')
      setStep('error')
      return null
    }
    setStep('submitting')
    setError(null)
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    try {
      const res = await apiRequest('/task', {
        method: 'POST',
        body: JSON.stringify({
          spec: opts.spec,
          budget: opts.budget,
          nonce,
          model: opts.model,
          colonyId: opts.colonyId,
        }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        if (res.status === 402 && detail.code === 'INSUFFICIENT_BALANCE') {
          openDepositModal()
          throw new Error(`Insufficient Treasury balance (need ${detail.required} USDC, have ${detail.balance}) — opening deposit.`)
        }
        throw new Error(detail.error ?? `submit failed (${res.status})`)
      }
      const data = (await res.json()) as { taskId: string; taskIdBytes32: string }
      setStep('done')
      log(`Dispatched ${data.taskId.slice(0, 8)}…`)
      return data
    } catch (err: any) {
      setStep('error')
      const msg = err?.shortMessage || err?.message || String(err)
      setError(msg)
      log(`error: ${msg}`)
      return null
    }
  }

  const reset = () => {
    setStep('idle')
    setError(null)
  }

  return { submit, step, error, reset }
}
