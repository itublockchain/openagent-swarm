'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, Check, Loader2, X } from 'lucide-react'
import { parseUnits } from 'viem'
import { useAccount, useChainId, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt, readContract } from '@wagmi/core'
import { ERC20_ABI, USDC_GATEWAY_ABI, CONTRACT_ADDRESSES } from '@/lib/contracts'
import {
  CCTP_SOURCE_CHAINS,
  TOKEN_MESSENGER_V2_ABI,
  BASE_SEPOLIA_DOMAIN,
  BASE_SEPOLIA_CHAIN_ID,
  FINALITY_THRESHOLD_FAST,
  addressToBytes32,
  calcMaxFee,
  isCctpSourceChain,
} from '@/lib/cctp'
import { config as wagmiConfig, paymentChain } from '../../lib/wagmi'
import { apiRequest } from '../../lib/api'
import { ensureWalletChain } from '../../lib/tx'

const USDC_DECIMALS = 6
const POLL_INTERVAL_MS = 4_000
const POLL_TIMEOUT_MS = 180_000
const SLOW_BRIDGE_WARNING_MS = 90_000
const ZERO_BYTES32 = ('0x' + '0'.repeat(64)) as `0x${string}`

interface Props {
  onClose: () => void
  /** Fired once Treasury balance reflects the deposit. */
  onSuccess?: (newBalance: string) => void
}

type Step =
  | 'idle'
  | 'switching-chain'
  | 'approving'
  | 'depositing'      // direct path: gateway.deposit
  | 'burning'         // CCTP path: depositForBurnWithHook
  | 'attesting'       // CCTP path: waiting on Iris
  | 'minting'         // CCTP path: relayer submitted receiveMessage
  | 'awaiting-credit' // both paths: waiting BridgeWatcher → 0G credit
  | 'done'
  | 'error'

interface CctpStageInfo {
  stage: 'awaiting-message' | 'awaiting-attestation' | 'ready' | 'relayed' | 'settling' | 'credited' | 'failed'
  baseTxHash?: string
  settleTxHash?: string
  error?: string
}

export function DepositModal({ onClose, onSuccess }: Props) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)

  // Source chain options: every CCTP source + Base Sepolia (direct).
  // Default: currently-connected chain if supported; otherwise Base.
  const sourceOptions = useMemo(
    () => [
      ...Object.values(CCTP_SOURCE_CHAINS),
      {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        domain: BASE_SEPOLIA_DOMAIN,
        name: 'Base Sepolia (direct)',
      },
    ],
    [],
  )
  const [sourceChainId, setSourceChainId] = useState<number>(() => {
    if (chainId === BASE_SEPOLIA_CHAIN_ID || isCctpSourceChain(chainId)) return chainId
    return BASE_SEPOLIA_CHAIN_ID
  })
  const isCctpPath = isCctpSourceChain(sourceChainId)

  // Source-side USDC token + approval target depend on the path.
  const sourceConfig = isCctpPath ? CCTP_SOURCE_CHAINS[sourceChainId] : null
  const usdcAddr = isCctpPath ? sourceConfig!.usdc : CONTRACT_ADDRESSES.usdc
  const approveTargetAddr = isCctpPath ? sourceConfig!.tokenMessengerV2 : CONTRACT_ADDRESSES.gateway
  const cctpReceiverAddr = CONTRACT_ADDRESSES.cctpReceiver

  // Wallet USDC balance on the chosen source chain.
  const usdcBalanceQ = useReadContract({
    abi: ERC20_ABI,
    address: usdcAddr,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: sourceChainId,
    query: {
      enabled: !!address && !!usdcAddr,
      refetchInterval: 8_000,
    },
  })

  useEffect(() => setError(null), [amount, sourceChainId])

  // Surface a "Circle is slow" hint after 90s in attesting/minting.
  useEffect(() => {
    if (step !== 'attesting' && step !== 'minting') {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), SLOW_BRIDGE_WARNING_MS)
    return () => clearTimeout(t)
  }, [step])

  const handleDeposit = async () => {
    if (!address) {
      setError('Connect your wallet first')
      return
    }
    if (!usdcAddr) {
      setError('USDC address missing for selected chain')
      return
    }
    if (isCctpPath) {
      if (!cctpReceiverAddr) {
        setError('CCTPDepositReceiver address missing — set NEXT_PUBLIC_CCTP_RECEIVER_ADDRESS')
        return
      }
    } else if (!approveTargetAddr) {
      setError('Gateway address missing — set NEXT_PUBLIC_GATEWAY_ADDRESS')
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
    if (usdcBalanceQ.data !== undefined && amountWei > (usdcBalanceQ.data as bigint)) {
      setError('Insufficient USDC balance')
      return
    }

    setError(null)
    try {
      // 1. Make sure the wallet is on the chosen source chain. Force
      //    the switch unconditionally — `chainId` from useChainId() is
      //    unreliable when the wallet is on a chain that isn't in the
      //    wagmi config (e.g. 0G Galileo 16602), and a stale match
      //    silently skips the switch and trips viem's ChainMismatchError
      //    on the first writeContract.
      setStep('switching-chain')
      await ensureWalletChain(sourceChainId, switchChainAsync)

      // 2. Approve the spender if allowance falls short.
      const spender = isCctpPath ? sourceConfig!.tokenMessengerV2 : (approveTargetAddr as `0x${string}`)
      const allowance = (await readContract(wagmiConfig, {
        abi: ERC20_ABI,
        address: usdcAddr,
        functionName: 'allowance',
        args: [address, spender],
        chainId: sourceChainId as 84532 | 11155111 | 421614,
      })) as bigint

      if (allowance < amountWei) {
        setStep('approving')
        const approveHash = await writeContractAsync({
          abi: ERC20_ABI,
          address: usdcAddr,
          functionName: 'approve',
          args: [spender, amountWei],
          chainId: sourceChainId as 84532 | 11155111 | 421614,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, timeout: 120_000 })
      }

      // 3. Move USDC. Two paths.
      // Re-assert chain — the user may have switched their wallet
      // network during the approve wait, which would race the next
      // signature with viem's ChainMismatchError.
      await ensureWalletChain(sourceChainId, switchChainAsync)
      let depositTxHash: `0x${string}`
      if (isCctpPath) {
        setStep('burning')
        // TokenMessengerV2.depositForBurnWithHook reverts with "Hook data
        // is empty" if hookData.length == 0. Our receiver doesn't read it
        // (it credits the messageSender from the signed attestation) but
        // we still have to fill it. Encode the user's address as bytes32 —
        // gives any future hookData-aware logic something useful to read.
        depositTxHash = await writeContractAsync({
          abi: TOKEN_MESSENGER_V2_ABI,
          address: sourceConfig!.tokenMessengerV2,
          functionName: 'depositForBurnWithHook',
          args: [
            amountWei,
            BASE_SEPOLIA_DOMAIN,
            addressToBytes32(cctpReceiverAddr!),
            usdcAddr,
            ZERO_BYTES32,
            calcMaxFee(amountWei),
            FINALITY_THRESHOLD_FAST,
            addressToBytes32(address),
          ],
          chainId: sourceChainId as 84532 | 11155111 | 421614,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: depositTxHash, timeout: 180_000 })
      } else {
        setStep('depositing')
        depositTxHash = await writeContractAsync({
          abi: USDC_GATEWAY_ABI,
          address: approveTargetAddr as `0x${string}`,
          functionName: 'deposit',
          args: [amountWei],
          chainId: BASE_SEPOLIA_CHAIN_ID,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: depositTxHash, timeout: 180_000 })
      }

      // 4. Path-specific bridging step.
      if (isCctpPath) {
        // Hand the burn txHash to the backend so the relayer takes it
        // through Iris attestation → receiveMessage on Base.
        setStep('attesting')
        const enqueueRes = await apiRequest('/v1/cctp/burn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ srcChainId: sourceChainId, txHash: depositTxHash }),
        })
        if (!enqueueRes.ok) {
          throw new Error(`Failed to queue burn: ${enqueueRes.status} ${await enqueueRes.text()}`)
        }

        // Poll cctp status until relayed (then BridgeWatcher does the credit).
        const cctpDeadline = Date.now() + POLL_TIMEOUT_MS
        while (Date.now() < cctpDeadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
          const statusRes = await apiRequest(
            `/v1/cctp/status?srcChainId=${sourceChainId}&txHash=${depositTxHash}`,
          )
          if (!statusRes.ok) continue
          const info = (await statusRes.json()) as CctpStageInfo
          if (info.stage === 'failed') {
            throw new Error(info.error || 'CCTP relay failed — try again or contact support')
          }
          // Anything past 'ready' means the on-chain leg is done or
          // imminent — stop polling status, switch to balance polling.
          if (
            info.stage === 'relayed' ||
            info.stage === 'settling' ||
            info.stage === 'credited'
          ) {
            setStep('minting')
            break
          }
          if (info.stage === 'ready') {
            setStep('minting')
          }
        }
      }

      // 5. Wait for BridgeWatcher to mirror the deposit into 0G Treasury.
      // CCTP V2 Fast charges a small fee (typically 0–14 bps), so the
      // credited amount is `amount - feeExecuted`, never the full
      // requested amount. 1.5% tolerance covers Circle's stated max fee
      // with comfortable headroom; below that we wait for the BridgeWatcher
      // (~12s poll cycle) to report a strictly increasing balance.
      setStep('awaiting-credit')
      const startBalance = await fetchTreasuryBalance()
      const target = startBalance + Number(amount) * (isCctpPath ? 0.985 : 1)
      const balanceDeadline = Date.now() + POLL_TIMEOUT_MS
      while (Date.now() < balanceDeadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        const current = await fetchTreasuryBalance().catch(() => startBalance)
        if (current >= target - 0.000001) {
          setStep('done')
          onSuccess?.(current.toString())
          return
        }
      }
      throw new Error(
        'Deposit landed but Treasury credit took longer than expected. Refresh in a minute or check /v1/me/balance.',
      )
    } catch (err: any) {
      setStep('error')
      setError(err?.shortMessage ?? err?.message ?? String(err))
    }
  }

  const isBusy = step !== 'idle' && step !== 'done' && step !== 'error'

  const stepLabel: Record<Step, string> = {
    idle: '',
    'switching-chain': 'Switching wallet…',
    approving: 'Approve USDC…',
    depositing: 'Sign deposit on Base…',
    burning: 'Sign burn on source…',
    attesting: 'Waiting on Circle attestation (~10–20s)…',
    minting: 'Relaying to Base Sepolia…',
    'awaiting-credit': 'Crediting Treasury on 0G…',
    done: '✓ Treasury balance updated',
    error: error ?? 'Error',
  }

  const usdcAvailable = usdcBalanceQ.data ? Number(usdcBalanceQ.data) / 10 ** USDC_DECIMALS : null
  const sourceConfigLabel = sourceOptions.find(s => s.chainId === sourceChainId)?.name ?? '—'

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
          Deposit USDC from any supported chain. Cross-chain bridges go through
          Circle CCTP V2 (~15s). The result lands as Treasury credit on 0G.
        </p>

        <label className="text-xs font-medium text-foreground">Source chain</label>
        <select
          value={sourceChainId}
          onChange={e => setSourceChainId(Number(e.target.value))}
          disabled={isBusy}
          className="w-full mt-1 mb-3 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {sourceOptions.map(opt => (
            <option key={opt.chainId} value={opt.chainId}>
              {opt.name}
            </option>
          ))}
        </select>

        {usdcAvailable !== null && (
          <div className="text-[11px] font-mono text-muted-foreground mb-3">
            <span className="opacity-70">Wallet USDC ({sourceConfigLabel}):</span>{' '}
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

        {isCctpPath && isBusy && (
          <CctpProgress step={step} />
        )}

        {slow && (step === 'attesting' || step === 'minting') && (
          <div className="mt-3 text-[11px] px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-600">
            Circle attestation is taking longer than usual. Fast Transfer SLA is
            8–20s; if it takes &gt;5min the relayer will retry automatically.
          </div>
        )}

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

function CctpProgress({ step }: { step: Step }) {
  const stages: { id: Step; label: string }[] = [
    { id: 'burning', label: 'Burn on source' },
    { id: 'attesting', label: 'Circle attestation' },
    { id: 'minting', label: 'Mint on Base' },
    { id: 'awaiting-credit', label: '0G Treasury credit' },
  ]
  const currentIdx = stages.findIndex(s => s.id === step)
  return (
    <ol className="mt-4 space-y-1.5 text-[11px]">
      {stages.map((stage, i) => {
        const done = i < currentIdx
        const active = i === currentIdx
        return (
          <li key={stage.id} className="flex items-center gap-2">
            {done ? (
              <Check className="w-3.5 h-3.5 text-green-500" />
            ) : active ? (
              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
            ) : (
              <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground/40" />
            )}
            <span className={done ? 'text-muted-foreground line-through' : active ? 'text-foreground' : 'text-muted-foreground/60'}>
              {stage.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

async function fetchTreasuryBalance(): Promise<number> {
  const res = await apiRequest('/v1/me/balance')
  if (!res.ok) throw new Error(`balance read failed (${res.status})`)
  const data = (await res.json()) as { balance: string }
  const n = Number(data.balance)
  return Number.isFinite(n) ? n : 0
}
