'use client'

import { useState } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract } from 'wagmi'
import { readContract } from '@wagmi/core'
import { config as wagmiConfig, ogTestnet } from '../../lib/wagmi'
import { apiRequest } from '../../lib/api'
import { waitTxOrVerify } from '../../lib/tx'
import { ERC20_ABI, SPORE_ESCROW_ABI } from '@/lib/contracts'

export type TaskSubmitStep =
  | 'idle'
  | 'preparing'
  | 'approving'
  | 'creating'
  | 'submitting'
  | 'done'
  | 'error'

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
 * Shared task submission flow used by both the explorer's full prompt
 * box and the per-colony textbox in profile. Encapsulates:
 *   1. /task/prepare (storage hash + chain params)
 *   2. USDC.approve (skipped if allowance already covers)
 *   3. SwarmEscrow.createTask (skipped if the same content-addressed task
 *      already exists; lets resubmits stay idempotent)
 *   4. /task POST (broadcasts to AXL with optional colonyId)
 *
 * All TX waits route through waitTxOrVerify so a flaky 0G Galileo receipt
 * fetch doesn't 422 a tx that actually landed.
 */
export function useTaskSubmit(onLog?: (line: string) => void) {
  const [step, setStep] = useState<TaskSubmitStep>('idle')
  const [error, setError] = useState<string | null>(null)
  const { address: walletAddress } = useAccount()
  const currentChainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const log = (line: string) => onLog?.(line)

  const submit = async (opts: TaskSubmitOptions): Promise<TaskSubmitResult | null> => {
    if (!walletAddress) {
      setError('Connect your wallet first')
      setStep('error')
      return null
    }
    setStep('preparing')
    setError(null)
    // Fresh nonce makes resubmits of the same spec produce distinct
    // content-addressed taskIds — without it, the second submit would
    // collide with the first and revert with "Task already exists".
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    try {
      if (currentChainId !== ogTestnet.id) {
        await switchChainAsync({ chainId: ogTestnet.id })
      }

      // 1. Prepare — storage hash, decimals, escrow address.
      // CRITICAL: send the EXACT body shape that step 4's /task POST will
      // send. Backend hashes whatever passes its TaskSchema, and colonyId
      // is in that schema — so a prepare body that omits colonyId derives
      // a different taskIdBytes32 than the submit body, the user signs
      // createTask for the prepare-derived id, and /task can't find that
      // id on-chain (since the user actually created a different one).
      // Symptom: createTask "succeeds" but the AXL broadcast 402s with
      // "Task not found on-chain" — the per-colony submit flow looked
      // broken end-to-end.
      const prepRes = await apiRequest('/task/prepare', {
        method: 'POST',
        body: JSON.stringify({
          spec: opts.spec,
          budget: opts.budget,
          nonce,
          colonyId: opts.colonyId,
        }),
      })
      if (!prepRes.ok) {
        const e = await prepRes.json().catch(() => ({}))
        throw new Error(e.error ?? `prepare failed (${prepRes.status})`)
      }
      const prep = (await prepRes.json()) as {
        specHash: string
        taskIdBytes32: `0x${string}`
        budgetWei: string
        decimals: number
        escrowAddress: `0x${string}`
        usdcAddress: `0x${string}`
      }
      const budgetWei = BigInt(prep.budgetWei)
      log(`Prepared task ${prep.taskIdBytes32.slice(0, 12)}…`)

      // 2. Approve USDC if existing allowance is too small.
      const allowance = (await readContract(wagmiConfig, {
        address: prep.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [walletAddress, prep.escrowAddress],
      })) as bigint

      if (allowance < budgetWei) {
        setStep('approving')
        log('Approving USDC…')
        const approveHash = await writeContractAsync({
          address: prep.usdcAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [prep.escrowAddress, budgetWei],
          chainId: ogTestnet.id,
        })
        await waitTxOrVerify(approveHash, async () => {
          const a = (await readContract(wagmiConfig, {
            address: prep.usdcAddress,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [walletAddress, prep.escrowAddress],
          })) as bigint
          return a >= budgetWei
        })
      }

      // 3. createTask — only if the escrow doesn't already have it.
      setStep('creating')
      const existing = (await readContract(wagmiConfig, {
        address: prep.escrowAddress,
        abi: SPORE_ESCROW_ABI,
        functionName: 'tasks',
        args: [prep.taskIdBytes32],
      })) as readonly [`0x${string}`, bigint, bigint, boolean]

      if (existing[0] === '0x0000000000000000000000000000000000000000') {
        log('Creating task on-chain…')
        const createHash = await writeContractAsync({
          address: prep.escrowAddress,
          abi: SPORE_ESCROW_ABI,
          functionName: 'createTask',
          args: [prep.taskIdBytes32, budgetWei],
          chainId: ogTestnet.id,
        })
        await waitTxOrVerify(createHash, async () => {
          const t = (await readContract(wagmiConfig, {
            address: prep.escrowAddress,
            abi: SPORE_ESCROW_ABI,
            functionName: 'tasks',
            args: [prep.taskIdBytes32],
          })) as readonly [`0x${string}`, bigint, bigint, boolean]
          return t[0] !== '0x0000000000000000000000000000000000000000'
        })
      } else {
        log('Task already exists on-chain — skipping createTask')
      }

      // 4. Broadcast to AXL. Same nonce → same storage hash, server-side
      //    INSERT OR IGNORE in the task index keeps things idempotent.
      setStep('submitting')
      const submitRes = await apiRequest('/task', {
        method: 'POST',
        body: JSON.stringify({
          spec: opts.spec,
          budget: opts.budget,
          nonce,
          model: opts.model,
          colonyId: opts.colonyId,
        }),
      })
      if (!submitRes.ok) {
        const e = await submitRes.json().catch(() => ({}))
        throw new Error(e.error ?? `submit failed (${submitRes.status})`)
      }
      const data = (await submitRes.json()) as { taskId: string; taskIdBytes32: string }
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
