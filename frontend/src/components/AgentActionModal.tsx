'use client'

import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Power, X } from 'lucide-react'
import { parseUnits } from 'viem'
import { useAccount, useChainId, useSwitchChain, useWriteContract } from 'wagmi'
import { readContract } from '@wagmi/core'
import { ERC20_ABI, CONTRACT_ADDRESSES } from '@/lib/contracts'
import { config as wagmiConfig, ogTestnet } from '../../lib/wagmi'
import { apiRequest } from '../../lib/api'
import { waitTxOrVerify } from '../../lib/tx'
import { cn } from '@/lib/utils'

export type ActionMode = 'deposit' | 'withdraw' | 'stop'

interface AgentLite {
  agentId: string
  agentAddress?: string
  name?: string
  stakeAmount: string
}

interface Props {
  mode: ActionMode
  agent: AgentLite
  decimals: number
  /** Called after the action lands successfully (so the caller can refetch). */
  onSuccess: () => void
  onClose: () => void
}

/**
 * Combined deposit / withdraw / stop modal. Three flows with different chain
 * interactions but the same outer shell:
 *   - deposit  → user signs USDC.transfer(agent, amount); on confirm we POST
 *               /agent/:id/topup so the API can bump the stake floor and
 *               restart the container (otherwise the surplus watchdog would
 *               immediately sweep the new deposit back out).
 *   - withdraw → POST /agent/:id/withdraw {amount?}; backend signs from the
 *               agent's wallet. No user signature needed.
 *   - stop     → DELETE /agent/:id; backend drains both USDC and OG before
 *               killing the container, returns the drain receipts in body.
 */
export function AgentActionModal({ mode, agent, decimals, onSuccess, onClose }: Props) {
  const [amount, setAmount] = useState('')
  const [withdrawAll, setWithdrawAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const usdcAddr = CONTRACT_ADDRESSES.usdc
  const { isConnected } = useAccount()
  const currentChainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  // Reset every time the modal switches mode/agent so a previous error or
  // amount doesn't leak across actions.
  useEffect(() => {
    setAmount('')
    setWithdrawAll(false)
    setBusy(false)
    setError(null)
    setSuccess(null)
  }, [mode, agent.agentId])

  const ensureChain = async () => {
    if (currentChainId === ogTestnet.id) return
    await switchChainAsync({ chainId: ogTestnet.id })
  }

  const handleDeposit = async () => {
    if (!agent.agentAddress) {
      setError('Agent has no on-chain address yet')
      return
    }
    if (!usdcAddr) {
      setError('USDC address missing in frontend env')
      return
    }
    let parsed: bigint
    try {
      parsed = parseUnits(amount, decimals)
    } catch {
      setError('Enter a valid USDC amount')
      return
    }
    if (parsed <= BigInt(0)) {
      setError('Amount must be > 0')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await ensureChain()
      // Snapshot agent's USDC balance pre-transfer so we can confirm
      // landing via state-delta if the receipt fetch times out (0G
      // Galileo's RPC frequently misses receipts on tx that did land).
      const balBefore = (await readContract(wagmiConfig, {
        abi: ERC20_ABI,
        address: usdcAddr,
        functionName: 'balanceOf',
        args: [agent.agentAddress as `0x${string}`],
      })) as bigint

      const txHash = await writeContractAsync({
        address: usdcAddr,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [agent.agentAddress as `0x${string}`, parsed],
        chainId: ogTestnet.id,
      })
      await waitTxOrVerify(txHash, async () => {
        const balAfter = (await readContract(wagmiConfig, {
          abi: ERC20_ABI,
          address: usdcAddr,
          functionName: 'balanceOf',
          args: [agent.agentAddress as `0x${string}`],
        })) as bigint
        return balAfter >= balBefore + parsed
      })
      // Tell the API so it bumps the stake floor + restarts the container.
      // Without this step, the agent's surplus watchdog would sweep the
      // deposit straight back to the owner on its next 60s tick.
      const res = await apiRequest(`/agent/${agent.agentId}/topup`, {
        method: 'POST',
        body: JSON.stringify({ amount }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`API topup failed: ${body.error ?? res.status}`)
      }
      setSuccess(`Deposited ${amount} USDC`)
      onSuccess()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleWithdraw = async () => {
    setBusy(true)
    setError(null)
    try {
      const body: { amount?: string } = {}
      if (!withdrawAll) {
        if (!amount.trim()) {
          throw new Error('Enter an amount or check "Withdraw all"')
        }
        // Quick client-side parse just to fail fast — backend re-parses.
        try { parseUnits(amount, decimals) } catch { throw new Error('Invalid amount') }
        body.amount = amount
      }
      const res = await apiRequest(`/agent/${agent.agentId}/withdraw`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `withdraw failed (${res.status})`)
      }
      setSuccess('Withdraw confirmed — funds returned to your wallet')
      onSuccess()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await apiRequest(`/agent/${agent.agentId}`, { method: 'DELETE' })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `stop failed (${res.status})`)
      }
      setSuccess('Agent stopped — USDC + OG returned to your wallet')
      onSuccess()
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const titleByMode: Record<ActionMode, string> = {
    deposit: 'Deposit USDC',
    withdraw: 'Withdraw USDC',
    stop: 'Stop agent',
  }
  const iconByMode: Record<ActionMode, React.ReactNode> = {
    deposit: <ArrowDownToLine className="w-4 h-4" />,
    withdraw: <ArrowUpFromLine className="w-4 h-4" />,
    stop: <Power className="w-4 h-4" />,
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
            {iconByMode[mode]}
            {titleByMode[mode]}
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-full p-1 hover:bg-accent text-muted-foreground transition-colors disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="text-[11px] font-mono text-muted-foreground mb-4 space-y-1">
          <div className="flex justify-between">
            <span className="opacity-70">Agent</span>
            <span className="text-foreground truncate max-w-[60%]">{agent.name ?? agent.agentId.slice(0, 12)}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">Stake floor</span>
            <span className="text-foreground tabular-nums">{agent.stakeAmount} USDC</span>
          </div>
        </div>

        {mode === 'deposit' && (
          <>
            <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
              Sends USDC from your wallet to the agent's address. The stake floor
              is raised by the same amount so the surplus watchdog won't sweep
              this deposit back. The agent is restarted to pick up the new floor.
            </p>
            <label className="text-xs font-medium text-foreground">Amount (USDC)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="10"
              min="0"
              step="any"
              disabled={busy}
              className="w-full mt-1 mb-4 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
            <button
              onClick={handleDeposit}
              disabled={busy || !isConnected || !amount.trim()}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? 'Depositing…' : 'Sign & deposit'}
            </button>
          </>
        )}

        {mode === 'withdraw' && (
          <>
            <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
              Pulls USDC from the agent's wallet to yours. The agent's tx-gas
              (OG) stays so the agent can keep working. Use Stop if you want
              to reclaim everything.
            </p>
            <label className="flex items-center gap-2 text-xs font-medium mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={withdrawAll}
                onChange={e => setWithdrawAll(e.target.checked)}
                disabled={busy}
                className="rounded"
              />
              Withdraw entire USDC balance
            </label>
            {!withdrawAll && (
              <>
                <label className="text-xs font-medium text-foreground">Amount (USDC)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="5"
                  min="0"
                  step="any"
                  disabled={busy}
                  className="w-full mt-1 mb-4 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                />
              </>
            )}
            <button
              onClick={handleWithdraw}
              disabled={busy || (!withdrawAll && !amount.trim())}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? 'Withdrawing…' : 'Withdraw'}
            </button>
          </>
        )}

        {mode === 'stop' && (
          <>
            <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
              Stops and removes the agent. The container is killed and its full
              USDC balance plus remaining OG (minus a small gas reserve) is
              returned to your wallet in the same flow.
            </p>
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-500 mb-4">
              This is irreversible. The agent will be removed from the on-chain
              registry and its container destroyed.
            </div>
            <button
              onClick={handleStop}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? 'Stopping…' : 'Stop & withdraw all'}
            </button>
          </>
        )}

        {error && (
          <div className="mt-4 text-[11px] px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-red-500">
            {error}
          </div>
        )}
        {success && (
          <div className={cn(
            'mt-4 text-[11px] px-3 py-2 rounded-md border',
            'border-green-500/30 bg-green-500/10 text-green-600',
          )}>
            {success}
          </div>
        )}
      </div>
    </div>
  )
}
