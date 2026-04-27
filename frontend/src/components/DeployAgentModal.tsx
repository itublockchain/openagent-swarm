'use client'

import React, { useState } from 'react'
import { X, Rocket } from 'lucide-react'
import { useAccount, useWriteContract, useChainId, useSwitchChain } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import { config as wagmiConfig, ogTestnet } from '../../lib/wagmi'
import { ERC20_ABI } from '@/lib/contracts'
import { apiRequest } from '../../lib/api'
import { cn } from '@/lib/utils'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSuccess: (containerId: string) => void
}

// 0G Compute testnet currently exposes only a small set of qwen models. We
// pin to the one we've actually verified end-to-end. Add more here only
// after confirming they're routable from createZGComputeNetworkBroker.
const AVAILABLE_MODELS = [
  { value: 'qwen/qwen-2.5-7b-instruct', label: 'Qwen 2.5 7B Instruct (0G Compute)' },
] as const

type Step = 'idle' | 'switching-chain' | 'preparing' | 'transferring' | 'deploying' | 'done' | 'error'

export function DeployAgentModal({ isOpen, onClose, onSuccess }: Props) {
  const [stage, setStage] = useState(1)
  const [agentName, setAgentName] = useState('')
  const [selectedModel, setSelectedModel] = useState<string>(AVAILABLE_MODELS[0].value)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [stakeAmount, setStakeAmount] = useState('10')
  const [step, setStep] = useState<Step>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const { address: userAddress, isConnected } = useAccount()
  const currentChainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  if (!isOpen) return null

  const reset = () => {
    setStep('idle')
    setErrorMsg('')
  }

  const closeAndReset = () => {
    reset()
    setStage(1)
    onClose()
  }

  const handleDeploy = async () => {
    setErrorMsg('')
    if (!isConnected || !userAddress) {
      setErrorMsg('Connect your wallet first')
      return
    }
    if (!agentName.trim()) {
      setErrorMsg('Agent name is required')
      return
    }

    try {
      // 0. Make sure the wallet is on 0G Galileo. If not, prompt a switch —
      // otherwise writeContract silently hangs waiting for an unreachable RPC.
      if (currentChainId !== ogTestnet.id) {
        setStep('switching-chain')
        try {
          await switchChainAsync({ chainId: ogTestnet.id })
        } catch (err: any) {
          // 4902 = chain not added to the wallet. Tell the user to add it
          // manually rather than trying wallet_addEthereumChain RPC (which
          // varies per wallet) — gives a clearer remediation path.
          if (err?.code === 4902 || /unrecognized chain/i.test(String(err?.message))) {
            throw new Error('Add 0G Galileo testnet (chainId 16602, RPC https://evmrpc-testnet.0g.ai) to your wallet, then retry')
          }
          throw err
        }
      }

      // 1. Prepare — backend mints a fresh wallet for the agent and gas-funds it.
      setStep('preparing')
      const prepRes = await apiRequest('/agent/prepare', {
        method: 'POST',
        body: JSON.stringify({
          name: agentName.trim(),
          model: selectedModel,
          stakeAmount,
          systemPrompt: systemPrompt.trim() || undefined,
        }),
      })
      if (!prepRes.ok) {
        const e = await prepRes.json().catch(() => ({}))
        throw new Error(e.error || `prepare failed (${prepRes.status})`)
      }
      const prep = (await prepRes.json()) as {
        agentId: string
        agentAddress: `0x${string}`
        usdcAddress: `0x${string}`
        decimals: number
        stakeWei: string
        gasPrefundOG: string
      }

      // 2. User signs USDC.transfer to fund the agent's wallet directly.
      setStep('transferring')
      console.log('[Deploy] requesting USDC.transfer signature', {
        usdc: prep.usdcAddress, to: prep.agentAddress, amount: prep.stakeWei, chainId: ogTestnet.id,
      })
      const transferHash = await writeContractAsync({
        address: prep.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [prep.agentAddress, BigInt(prep.stakeWei)],
        chainId: ogTestnet.id,
      })
      console.log('[Deploy] transfer tx hash:', transferHash)
      // 0G RPC can take ~30-60s to surface receipts; bump default timeout.
      await waitForTransactionReceipt(wagmiConfig, {
        hash: transferHash,
        timeout: 180_000,
        pollingInterval: 3_000,
      })
      console.log('[Deploy] transfer confirmed')

      // 4. Backend verifies funding and starts the container.
      setStep('deploying')
      const deployRes = await apiRequest('/agent/deploy', {
        method: 'POST',
        body: JSON.stringify({ agentId: prep.agentId }),
      })
      if (!deployRes.ok) {
        const e = await deployRes.json().catch(() => ({}))
        throw new Error(e.error || `deploy failed (${deployRes.status})`)
      }
      const { containerId } = await deployRes.json()

      setStep('done')
      onSuccess(containerId)
      setTimeout(closeAndReset, 800)
    } catch (err: any) {
      console.error('[DeployModal] error:', err)
      setStep('error')
      setErrorMsg(err?.shortMessage || err?.message || String(err))
    }
  }

  const isBusy = step === 'switching-chain' || step === 'preparing' || step === 'transferring' || step === 'deploying'
  const stepLabel: Record<Step, string> = {
    idle: '',
    'switching-chain': 'Switch to 0G Galileo (chainId 16602) in your wallet…',
    preparing: 'Generating agent wallet…',
    transferring: 'Sign the USDC transfer in your wallet (check MetaMask popup)…',
    deploying: 'Spawning Docker container…',
    done: '✓ Agent live in pool',
    error: errorMsg || 'Error',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold tracking-tight">Deploy Your Custom Agent</h2>
          <button
            onClick={closeAndReset}
            className="rounded-full p-1.5 hover:bg-accent text-muted-foreground transition-colors"
            disabled={isBusy}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative overflow-hidden">
          {/* Stage 1 — name, model, prompt */}
          <div
            className={cn(
              'transition-all duration-300 ease-in-out',
              stage === 1 ? 'opacity-100 translate-x-0 relative' : 'opacity-0 -translate-x-full absolute inset-0 pointer-events-none',
            )}
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Agent Name</label>
                <input
                  type="text"
                  value={agentName}
                  onChange={e => setAgentName(e.target.value)}
                  placeholder="e.g. defi-yield-hunter"
                  maxLength={40}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="text-xs text-muted-foreground">Letters, numbers, dashes. Used as the on-chain identifier.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">AI Model</label>
                <select
                  value={selectedModel}
                  onChange={e => setSelectedModel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {AVAILABLE_MODELS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">Only models routable from 0G Compute testnet are listed.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  System Prompt <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea
                  value={systemPrompt}
                  onChange={e => setSystemPrompt(e.target.value)}
                  placeholder="You are a DeFi specialist. Focus on yield optimization..."
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                />
              </div>

              <button
                onClick={() => {
                  if (!agentName.trim()) {
                    setErrorMsg('Agent name is required')
                    return
                  }
                  setErrorMsg('')
                  setStage(2)
                }}
                className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors mt-6"
              >
                Next
              </button>
              {errorMsg && stage === 1 && (
                <p className="text-xs text-red-500 mt-2">{errorMsg}</p>
              )}
            </div>
          </div>

          {/* Stage 2 — stake + deploy */}
          <div
            className={cn(
              'transition-all duration-300 ease-in-out',
              stage === 2 ? 'opacity-100 translate-x-0 relative' : 'opacity-0 translate-x-full absolute inset-0 pointer-events-none',
            )}
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Initial Bond (USDC)</label>
                <div className="relative">
                  <input
                    type="number"
                    value={stakeAmount}
                    onChange={e => setStakeAmount(e.target.value)}
                    min="1"
                    disabled={isBusy}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 pl-7 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    placeholder="10"
                  />
                  <span className="absolute left-3 top-2.5 text-sm text-muted-foreground">$</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  USDC transferred to the agent's wallet. The agent uses this to stake on
                  subtask claims; staked amounts are returned on validation, slashed on
                  successful challenge.
                </p>
              </div>

              <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Wallet</span><span className="font-mono">{userAddress ? `${userAddress.slice(0, 6)}…${userAddress.slice(-4)}` : 'not connected'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span>{agentName || '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Model</span><span className="font-mono text-[10px]">{selectedModel}</span></div>
              </div>

              <button
                disabled={!isConnected || isBusy || !agentName.trim()}
                onClick={handleDeploy}
                className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors mt-6 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Rocket className={cn('w-4 h-4', isBusy && 'animate-pulse')} />
                {isBusy ? 'Deploying…' : 'Deploy Agent'}
              </button>

              {step !== 'idle' && (
                <div
                  className={cn(
                    'text-xs px-3 py-2 rounded-md border',
                    step === 'error'
                      ? 'border-red-500/30 bg-red-500/10 text-red-500'
                      : step === 'done'
                      ? 'border-green-500/30 bg-green-500/10 text-green-600'
                      : 'border-blue-500/30 bg-blue-500/10 text-blue-500',
                  )}
                >
                  {stepLabel[step]}
                </div>
              )}

              <button
                onClick={() => { reset(); setStage(1) }}
                disabled={isBusy}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
