'use client'

import React, { useState } from 'react'
import { X, Rocket } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSuccess: (containerId: string) => void
}

export function DeployAgentModal({ isOpen, onClose, onSuccess }: Props) {
  const [step, setStep] = useState(1)
  const [selectedModel, setSelectedModel] = useState("gpt-4o")
  const [systemPrompt, setSystemPrompt] = useState('')
  const [stakeAmount, setStakeAmount] = useState("10")
  const [isWalletConnected, setIsWalletConnected] = useState(false)
  const [isDeploying, setIsDeploying] = useState(false)

  if (!isOpen) return null

  const handleDeploy = async () => {
    setIsDeploying(true)
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
      const res = await fetch(`${apiUrl}/agent/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: `agent-${Date.now()}`,
          stakeAmount: stakeAmount,
          model: selectedModel,
          systemPrompt: systemPrompt || undefined,
        })
      })

      if (!res.ok) throw new Error('Deployment failed')
      
      const { containerId } = await res.json()
      onSuccess(containerId)
      onClose()
    } catch (err) {
      console.error('Deploy error:', err)
      alert('Deployment failed. Check console for details.')
    } finally {
      setIsDeploying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold tracking-tight">Deploy Your Custom Agent</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 hover:bg-accent text-muted-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative overflow-hidden">
          {/* Step 1 */}
          <div 
            className={cn(
              "transition-all duration-300 ease-in-out",
              step === 1 ? "opacity-100 translate-x-0 relative" : "opacity-0 -translate-x-full absolute inset-0 pointer-events-none"
            )}
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Select AI Model</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="gpt-4o">GPT-4o (OpenAI)</option>
                  <option value="claude-3-5-sonnet">Claude 3.5 Sonnet (Anthropic)</option>
                  <option value="llama-3-70b">Llama 3 70B (0G Compute)</option>
                  <option value="mistral-large">Mistral Large (Gensyn)</option>
                </select>
              </div>

              {/* 4A — System Prompt TextArea */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  System Prompt <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea 
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="You are a DeFi specialist. Focus on yield optimization..."
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                />
              </div>

              <button
                onClick={() => setStep(2)}
                className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors mt-6"
              >
                Next
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div 
            className={cn(
              "transition-all duration-300 ease-in-out",
              step === 2 ? "opacity-100 translate-x-0 relative" : "opacity-0 translate-x-full absolute inset-0 pointer-events-none"
            )}
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Escrow Stake (USDC)</label>
                <div className="relative">
                  <input
                    type="number"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 pl-7 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="10"
                  />
                  <span className="absolute left-3 top-2.5 text-sm text-muted-foreground">$</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Amount to be staked into L2 Escrow contract.</p>
              </div>

              <div className="space-y-2 pt-2">
                <label className="text-sm font-medium text-foreground">Wallet Connection</label>
                {!isWalletConnected ? (
                  <button 
                    onClick={() => setIsWalletConnected(true)}
                    className="w-full flex items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    Connect Wallet
                  </button>
                ) : (
                  <div className="w-full flex items-center justify-between rounded-md border border-green-500/30 bg-green-500/10 px-4 py-2 text-sm text-green-600 dark:text-green-400">
                    <span className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                      </span>
                      0x71C...976F
                    </span>
                    <span className="text-xs font-mono">Connected</span>
                  </div>
                )}
              </div>

              <button
                disabled={!isWalletConnected || isDeploying}
                onClick={handleDeploy}
                className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors mt-6 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Rocket className={cn("w-4 h-4", isDeploying && "animate-pulse")} />
                {isDeploying ? 'Deploying...' : 'Initialize Deployment'}
              </button>
              <button
                onClick={() => setStep(1)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
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
