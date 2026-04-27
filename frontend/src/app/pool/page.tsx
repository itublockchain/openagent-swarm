'use client'

import { useEffect, useState } from 'react'
import { TopologyMap } from '../../components/TopologyMap'
import { Header } from '../../components/Header'
import { DeployAgentModal } from '../../components/DeployAgentModal'
import { cn } from '@/lib/utils'

interface AgentRecord {
  agentId: string
  name?: string
  agentAddress?: string
  containerId: string
  model: string
  stakeAmount: string
  status: 'pending' | 'running' | 'stopped' | 'error'
  deployedAt: number
  ownerAddress?: string
}

export default function PoolPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [selected, setSelected] = useState<AgentRecord | null>(null)
  const [isDeployOpen, setIsDeployOpen] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/agent/pool`
        )
        const data = await res.json()
        setAgents(data)
      } catch (err) {
        console.error('Failed to load agent pool:', err)
      }
    }
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleSelect = (agentId: string) => {
    setSelected(agents.find(a => a.agentId === agentId) ?? null)
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />
      
      <div className="flex flex-1 overflow-hidden">
        {/* 3D Topology Map */}
        <div className="flex-1 relative">
          <TopologyMap agents={agents} onSelect={handleSelect} />
          <div className="absolute top-4 right-4 text-muted-foreground text-[10px] font-bold uppercase tracking-widest bg-background/80 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-border/50 z-20">
            P2P MESH: {agents.length} NODES ACTIVE
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-80 bg-card text-card-foreground p-6 overflow-y-auto border-l border-border animate-in slide-in-from-right duration-300">
          <h2 className="text-xl font-bold mb-6 tracking-tight">Agent Pool</h2>

          {selected ? (
            <div className="mb-8 p-4 rounded-xl bg-accent/30 border border-border/50">
              <h3 className="text-base font-bold mb-1 text-primary leading-none">
                {selected.name ?? selected.agentId}
              </h3>
              <p className="text-[10px] font-mono text-muted-foreground mb-4">{selected.agentId}</p>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Model</span>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{selected.model}</span>
                </div>
                {selected.agentAddress && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Wallet</span>
                    <span className="font-mono text-xs">{selected.agentAddress.slice(0, 6)}…{selected.agentAddress.slice(-4)}</span>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Bond</span>
                  <span className="font-semibold text-foreground">{selected.stakeAmount} USDC</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Status</span>
                  <span className={cn(
                    "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider",
                    selected.status === 'running' ? "bg-green-500/10 text-green-500 border border-green-500/20" : "bg-muted text-muted-foreground border border-border"
                  )}>
                    {selected.status}
                  </span>
                </div>
                <div className="pt-4 mt-4 border-t border-border/50 text-[10px] text-muted-foreground uppercase tracking-widest font-medium">
                  Deployed: {new Date(selected.deployedAt).toLocaleString()}
                </div>
              </div>
            </div>
          ) : (
            <div className="py-12 px-4 text-center rounded-xl border border-dashed border-border text-muted-foreground text-sm mb-6 bg-muted/20">
              Select an agent to see details
            </div>
          )}

          <div className="flex flex-col gap-3">
            {agents.map(agent => (
              <div
                key={agent.containerId}
                onClick={() => handleSelect(agent.agentId)}
                className={cn(
                  "p-3 rounded-lg cursor-pointer transition-all border",
                  selected?.agentId === agent.agentId 
                    ? "bg-accent border-primary/30 shadow-sm" 
                    : "bg-background/50 border-border/50 hover:border-border hover:bg-accent/50"
                )}
                style={{
                  borderLeftWidth: '4px',
                  borderLeftColor: agent.status === 'running' ? '#22c55e' : '#64748b'
                }}
              >
                <div className="font-bold text-sm truncate">{agent.name ?? agent.agentId}</div>
                <div className="text-muted-foreground text-[10px] mt-1 font-mono">{agent.model}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <DeployAgentModal 
        isOpen={isDeployOpen} 
        onClose={() => setIsDeployOpen(false)}
        onSuccess={() => {}}
      />
    </div>
  )
}
