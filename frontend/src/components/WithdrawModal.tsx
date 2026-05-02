'use client'

import { useEffect, useState } from 'react'
import { ArrowUpFromLine, Loader2, X } from 'lucide-react'
import { apiRequest } from '../../lib/api'

interface Props {
  /** Caller-supplied current Treasury balance, decimal string. */
  balance: string
  onClose: () => void
  /** Fired after the API confirms both txs (Treasury debit on 0G,
   *  USDC release on Base). Caller refetches balance + wallet USDC. */
  onSuccess?: (txInfo: WithdrawResponse) => void
}

interface WithdrawResponse {
  amount: string
  fee: string
  total_debited: string
  debit_tx: string
  release_tx: string
  request_id: string
  base_address: string
}

/**
 * Withdraw real USDC back to the user's wallet on Base. The browser does
 * NO on-chain signing — POSTs to /v1/withdraw, where the operator signs
 * Treasury.debitBalance on 0G and USDCGateway.release on Base.
 */
export function WithdrawModal({ balance, onClose, onSuccess }: Props) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WithdrawResponse | null>(null)

  useEffect(() => {
    setError(null)
  }, [amount])

  const handleWithdraw = async () => {
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
      const res = await apiRequest('/v1/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount }),
      })
      const data = (await res.json().catch(() => ({}))) as WithdrawResponse | { error?: string; code?: string }
      if (!res.ok) {
        const errBody = data as { error?: string }
        throw new Error(errBody.error ?? `withdraw failed (${res.status})`)
      }
      const ok = data as WithdrawResponse
      setResult(ok)
      onSuccess?.(ok)
    } catch (err) {
      setError((err as Error).message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const balanceNumeric = Number(balance)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <ArrowUpFromLine className="w-4 h-4" />
            Withdraw USDC
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-full p-1 hover:bg-accent text-muted-foreground transition-colors disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
          Pulls real USDC from the gateway back to your wallet on Base
          Sepolia. A small flat fee covers the operator's Base ETH gas.
        </p>

        <div className="text-[11px] font-mono text-muted-foreground mb-3 space-y-1">
          <div className="flex justify-between">
            <span className="opacity-70">Treasury balance</span>
            <span className="text-foreground tabular-nums">{balanceNumeric.toFixed(2)} USDC</span>
          </div>
        </div>

        {!result && (
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
            <button
              onClick={handleWithdraw}
              disabled={busy || !amount.trim()}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? 'Withdrawing…' : 'Withdraw'}
            </button>
          </>
        )}

        {result && (
          <div className="text-[11px] space-y-1.5 px-3 py-2 rounded-md border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400">
            <div className="font-bold uppercase tracking-wider">Released</div>
            <div className="font-mono">
              {result.amount} USDC → {result.base_address.slice(0, 10)}…{result.base_address.slice(-6)}
            </div>
            <div className="font-mono opacity-70 text-[10px]">
              fee {result.fee} · base tx {result.release_tx.slice(0, 10)}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 text-[11px] px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-red-500">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
