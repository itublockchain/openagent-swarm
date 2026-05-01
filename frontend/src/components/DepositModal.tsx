'use client'

import { useEffect, useState } from 'react'
import { ArrowDownToLine, Loader2, X } from 'lucide-react'
import { parseUnits } from 'viem'
import { useAccount, useChainId, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt, readContract } from '@wagmi/core'
import { ERC20_ABI, USDC_GATEWAY_ABI, CONTRACT_ADDRESSES } from '@/lib/contracts'
import { config as wagmiConfig, paymentChain } from '../../lib/wagmi'
import { apiRequest } from '../../lib/api'

const USDC_DECIMALS = 6
const POLL_INTERVAL_MS = 4_000
const POLL_TIMEOUT_MS = 90_000

interface Props {
  onClose: () => void
  /** Fired once Treasury balance has reflected the deposit (BridgeWatcher
   *  observed the on-chain event). Caller should refetch balance UI. */
  onSuccess?: (newBalance: string) => void
}

type Step = 'idle' | 'switching-chain' | 'approving' | 'depositing' | 'awaiting-credit' | 'done' | 'error'

/**
 * Deposit USDC on Base Sepolia. The user signs:
 *   1. usdc.approve(gateway, amount) — only if existing allowance is short.
 *   2. gateway.deposit(amount) — moves USDC from wallet to the gateway.
 *
 * BridgeWatcher (server-side) sees the Deposited event a few blocks later
 * and credits SwarmTreasury.balanceOf on 0G. We poll /v1/me/balance until
 * it reflects the new total, then notify the parent.
 */
export function DepositModal({ onClose, onSuccess }: Props) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)

  const usdcAddr = CONTRACT_ADDRESSES.usdc
  const gatewayAddr = CONTRACT_ADDRESSES.gateway

  // Real USDC balance on Base — what the user has available to deposit.
  const usdcBalanceQ = useReadContract({
    abi: ERC20_ABI,
    address: usdcAddr,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && chainId === paymentChain.id,
      refetchInterval: 8_000,
    },
  })

  useEffect(() => {
    setError(null)
  }, [amount])

  const handleDeposit = async () => {
    if (!address) {
      setError('Connect your wallet first')
      return
    }
    if (!gatewayAddr) {
      setError('Gateway address missing — set NEXT_PUBLIC_GATEWAY_ADDRESS')
      return
    }
    if (!usdcAddr) {
      setError('USDC address missing — set NEXT_PUBLIC_USDC_ADDRESS')
      return
    }
    let amountWei: bigint
    try {
      amountWei = parseUnits(amount, USDC_DECIMALS)
    } catch {
      setError('Enter a valid USDC amount')
      return
    }
    if (amountWei <= BigInt(0)) {
      setError('Amount must be > 0')
      return
    }

    setError(null)
    try {
      // 1. Force Base Sepolia.
      if (chainId !== paymentChain.id) {
        setStep('switching-chain')
        try {
          await switchChainAsync({ chainId: paymentChain.id })
        } catch (err: any) {
          if (err?.code === 4902 || /unrecognized chain/i.test(String(err?.message))) {
            throw new Error('Add Base Sepolia (chainId 84532) to your wallet, then retry')
          }
          throw err
        }
      }

      // 2. Check allowance, approve if short.
      const allowance = (await readContract(wagmiConfig, {
        abi: ERC20_ABI,
        address: usdcAddr,
        functionName: 'allowance',
        args: [address, gatewayAddr],
      })) as bigint

      if (allowance < amountWei) {
        setStep('approving')
        const approveHash = await writeContractAsync({
          abi: ERC20_ABI,
          address: usdcAddr,
          functionName: 'approve',
          args: [gatewayAddr, amountWei],
          chainId: paymentChain.id,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, timeout: 120_000 })
      }

      // 3. Deposit.
      setStep('depositing')
      const depositHash = await writeContractAsync({
        abi: USDC_GATEWAY_ABI,
        address: gatewayAddr,
        functionName: 'deposit',
        args: [amountWei],
        chainId: paymentChain.id,
      })
      await waitForTransactionReceipt(wagmiConfig, { hash: depositHash, timeout: 180_000 })

      // 4. Poll Treasury until BridgeWatcher mirrors the deposit. The
      //    watcher polls every 12s; we poll every 4s so the user
      //    typically sees it land within ~15s.
      setStep('awaiting-credit')
      const startBalance = await fetchTreasuryBalance()
      const target = startBalance + Number(amount)
      const deadline = Date.now() + POLL_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        const current = await fetchTreasuryBalance().catch(() => startBalance)
        if (current >= target - 0.000001) {
          setStep('done')
          onSuccess?.(current.toString())
          return
        }
      }
      throw new Error('Deposit landed on Base but Treasury credit took longer than expected. Refresh in a minute or check /v1/me/balance.')
    } catch (err: any) {
      setStep('error')
      setError(err?.shortMessage ?? err?.message ?? String(err))
    }
  }

  const isBusy = step !== 'idle' && step !== 'done' && step !== 'error'

  const stepLabel: Record<Step, string> = {
    idle: '',
    'switching-chain': 'Switching wallet to Base Sepolia…',
    approving: 'Approve USDC for the gateway…',
    depositing: 'Sign the deposit on Base…',
    'awaiting-credit': 'Bridging — waiting for Treasury credit on 0G…',
    done: '✓ Treasury balance updated',
    error: error ?? 'Error',
  }

  const usdcAvailable = usdcBalanceQ.data
    ? Number(usdcBalanceQ.data) / 10 ** USDC_DECIMALS
    : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <ArrowDownToLine className="w-4 h-4" />
            Deposit USDC
          </h2>
          <button
            onClick={onClose}
            disabled={isBusy}
            className="rounded-full p-1 hover:bg-accent text-muted-foreground transition-colors disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
          Deposit real USDC on Base Sepolia. Once the on-chain deposit
          confirms, the bridge mirrors it into your Treasury balance on 0G —
          which is what every action in the app spends from.
        </p>

        {usdcAvailable !== null && (
          <div className="text-[11px] font-mono text-muted-foreground mb-3">
            <span className="opacity-70">Wallet USDC:</span>{' '}
            <span className="text-foreground tabular-nums">{usdcAvailable.toFixed(2)}</span>
          </div>
        )}

        <label className="text-xs font-medium text-foreground">Amount (USDC)</label>
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="10"
          min="0"
          step="any"
          disabled={isBusy}
          className="w-full mt-1 mb-4 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />

        <button
          onClick={handleDeposit}
          disabled={isBusy || !isConnected || !amount.trim()}
          className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
          {step === 'idle' || step === 'done' || step === 'error'
            ? `Deposit ${amount || ''}`.trim()
            : stepLabel[step]}
        </button>

        {step === 'error' && error && (
          <div className="mt-4 text-[11px] px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-red-500">
            {error}
          </div>
        )}
        {step === 'done' && (
          <div className="mt-4 text-[11px] px-3 py-2 rounded-md border border-green-500/30 bg-green-500/10 text-green-600">
            Treasury balance updated.
          </div>
        )}
      </div>
    </div>
  )
}

async function fetchTreasuryBalance(): Promise<number> {
  const res = await apiRequest('/v1/me/balance')
  if (!res.ok) throw new Error(`balance read failed (${res.status})`)
  const data = (await res.json()) as { balance: string }
  const n = Number(data.balance)
  return Number.isFinite(n) ? n : 0
}
