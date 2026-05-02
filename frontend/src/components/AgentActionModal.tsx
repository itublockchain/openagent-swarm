'use client'

import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Power, X } from 'lucide-react'
import { apiRequest, openDepositModal } from '../../lib/api'
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
  /** Decimals kept in the prop for backwards compat — ignored now that
   *  the API speaks USDC (6 decimals) over plain decimal strings. */
  decimals?: number
  onSuccess: () => void
  onClose: () => void
}

/**
 * Combined deposit / withdraw / stop modal. All three flows are pure
 * backend calls now — the user only proves SIWE identity (already in JWT)
 * and the API operator handles every on-chain move.
 *   - deposit  → POST /agent/:id/topup — operator debits user's Treasury
 *               balance, credits the agent's Escrow balance, restarts
 *               the container to pick up the new stake floor.
 *   - withdraw → POST /agent/:id/withdraw {amount?} — operator debits
 *               agent's Escrow balance, credits user's Treasury balance.
 *   - stop     → DELETE /agent/:id — operator drains the agent's Escrow
 *               balance back to the user's Treasury, kills the container.
 */
export function AgentActionModal({ mode, agent, onSuccess, onClose }: Props) {
  const [amount, setAmount] = useState('')
  const [withdrawAll, setWithdrawAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    setAmount('')
    setWithdrawAll(false)
    setBusy(false)
    setError(null)
    setSuccess(null)
  }, [mode, agent.agentId])

  const handleDeposit = async () => {
    if (!amount.trim()) {
      setError('Enter a USDC amount')
      return
    }
    const numeric = Number(amount)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setError('Amount must be > 0')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const res = await apiRequest(`/agent/${agent.agentId}/topup`, {
        method: 'POST',
        body: JSON.stringify({ amount }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const msg = body.error ?? `topup failed (${res.status})`
        if (/insufficient/i.test(msg)) {
          openDepositModal()
          throw new Error(`${msg} — opening the deposit modal so you can top up your Treasury.`)
        }
        throw new Error(msg)
      }
      setSuccess(`Deposited ${amount} USDC into agent`)
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
        const numeric = Number(amount)
        if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('Invalid amount')
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
      setSuccess('Withdraw confirmed — funds returned to your Treasury balance')
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
      setSuccess('Agent stopped — earnings + stake returned to your Treasury balance')
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
              Moves USDC from your Treasury balance into the agent's stake. The
              operator signs both ledger ops; you sign nothing. The agent
              restarts to pick up the new stake floor.
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
              disabled={busy || !amount.trim()}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? 'Depositing…' : 'Deposit'}
            </button>
          </>
        )}

        {mode === 'withdraw' && (
          <>
            <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
              Pulls USDC from the agent's Escrow balance back to your
              Treasury balance. The agent keeps its 0G gas — that's
              operator-funded, not yours.
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
              Stops and removes the agent. The agent's full Escrow balance
              (stake + earnings) is returned to your Treasury balance, then
              the container is destroyed.
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
