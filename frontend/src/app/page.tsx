"use client";

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ThemeToggle } from '@/components/theme-toggle';
import TaskNode, { NodeData, cn } from '@/components/flow/task-node';
import { ArrowLeft, Send, Terminal as TerminalIcon, Rocket, X } from 'lucide-react';

const nodeTypes = {
  task: TaskNode,
};

function DashboardContent() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [inputText, setInputText] = useState("");
  const [isDeployOpen, setIsDeployOpen] = useState(false);
  const [deployStep, setDeployStep] = useState(1);
  const [systemPrompt, setSystemPrompt] = useState("You are a DeFi specialist. Focus on yield optimization strategies. Always verify token addresses before suggesting swaps.");
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [selectedModel, setSelectedModel] = useState("gpt-4o");
  const [stakeAmount, setStakeAmount] = useState("10");
  const [logs, setLogs] = useState<string[]>([
    "Waiting for user intent...",
    "Ready to generate and deploy DAG."
  ]);
  const [simulationTrigger, setSimulationTrigger] = useState(0);

  const generateRandomDAG = (intent: string) => {
    const newNodes: Node<NodeData>[] = [
      { id: '1', type: 'task', position: { x: 400, y: 50 }, data: { label: `User Intent: ${intent}`, status: 'completed', agent: '0xUser...123' } },
      { id: '2', type: 'task', position: { x: 400, y: 150 }, data: { label: 'Planner: Decompose Intent', status: 'planner', agent: '0xPlan...456' } },
    ];
    
    const newEdges: Edge[] = [
      { id: 'e1-2', source: '1', target: '2', animated: true }
    ];

    const numSubtasks = Math.floor(Math.random() * 5) + 3; // 3 to 7 nodes
    const slashedIndex = Math.floor(Math.random() * numSubtasks);

    // Create 2 or 3 layers for mixed sequential/parallel execution
    const numLayers = Math.min(numSubtasks, Math.floor(Math.random() * 2) + 2); 
    const layers: number[][] = Array.from({length: numLayers}, () => []);
    
    for (let i = 0; i < numSubtasks; i++) {
       // Ensure at least 1 node per layer
       if (i < numLayers) {
         layers[i].push(i);
       } else {
         const randomLayer = Math.floor(Math.random() * numLayers);
         layers[randomLayer].push(i);
       }
    }

    const spacingX = 250;
    const spacingY = 150;
    
    const subtaskNodes: Node<NodeData>[] = [];
    const subtaskEdges: Edge[] = [];
    let keeperY = 0;

    for (let l = 0; l < numLayers; l++) {
      const layerNodes = layers[l];
      const startX = 400 - ((layerNodes.length - 1) * spacingX) / 2;
      const currentY = 300 + (l * spacingY);
      keeperY = currentY + spacingY + 50;

      for (let i = 0; i < layerNodes.length; i++) {
        const globalIndex = layerNodes[i];
        const id = `sub-${globalIndex}`;
        
        subtaskNodes.push({
          id,
          type: 'task',
          position: { x: startX + (i * spacingX), y: currentY },
          data: { label: `Dynamic Subtask ${globalIndex+1}`, status: 'pending', isSlashedTarget: globalIndex === slashedIndex }
        });

        if (l === 0) {
          // Connect to Planner
          subtaskEdges.push({ id: `e2-${id}`, source: '2', target: id, animated: true });
        } else {
          // Connect to random nodes in previous layer (mixed sequential/parallel)
          const prevLayer = layers[l - 1];
          const numParents = Math.floor(Math.random() * prevLayer.length) + 1;
          const parents = [...prevLayer].sort(() => 0.5 - Math.random()).slice(0, numParents);
          
          parents.forEach(p => {
             subtaskEdges.push({ id: `e_sub-${p}-${id}`, source: `sub-${p}`, target: id, animated: true });
          });
        }
      }
    }

    // Find all leaf nodes (nodes with no children) and connect them to KeeperHub
    const parentIds = new Set(subtaskEdges.map(e => e.source));
    const leafNodes = subtaskNodes.filter(n => !parentIds.has(n.id));

    const keeperId = 'keeper';
    const keeperNode: Node<NodeData> = {
      id: keeperId,
      type: 'task',
      position: { x: 400, y: keeperY },
      data: { label: 'Execute On-Chain via KeeperHub', status: 'pending' }
    };

    const keeperEdges: Edge[] = leafNodes.map(node => ({
      id: `e${node.id}-${keeperId}`,
      source: node.id,
      target: keeperId,
      animated: true
    }));

    setNodes([...newNodes, ...subtaskNodes, keeperNode]);
    setEdges([...newEdges, ...subtaskEdges, ...keeperEdges]);
    
    setLogs([
      "[SYSTEM] Connected to 0G Storage & Gensyn AXL.",
      `[USER] Submitted spec: ${intent}`,
      "[ESCROW] Locked user funds + execution fee.",
      "[AUCTION] Planner Agent 0xPlan...456 staked 15 USDC.",
      `[COMPUTE] Planner generated a complex DAG with ${numSubtasks} parallel/sequential tasks.`
    ]);

    setSimulationTrigger(prev => prev + 1);
  };

  // Simulate dynamic status changes across multiple steps
  useEffect(() => {
    if (simulationTrigger === 0) return;

    const t1 = setTimeout(() => {
      setNodes((nds) => nds.map((n) => {
        if (n.id.startsWith('sub-')) return { ...n, data: { ...n.data, status: (n.data as any).isSlashedTarget ? 'slashed' : 'claimed', agent: `0xAgent...${Math.floor(Math.random()*999)}` } };
        return n;
      }));
      setEdges((eds) => eds.map((e) => {
        const targetNode = nodes.find(n => n.id === e.target);
        if (targetNode && (targetNode.data as any).isSlashedTarget) {
          return { ...e, style: { stroke: '#ef4444' } };
        }
        return e;
      }));
      setLogs((prev) => [...prev, "[AUCTION] Agents claimed subtasks.", "[VALIDATION] Verifying initial outputs..."]);
    }, 2000);

    const t2 = setTimeout(() => {
      setNodes((nds) => nds.map((n) => {
        if (n.id.startsWith('sub-') && (n.data as any).isSlashedTarget) {
           return { ...n, data: { ...n.data, status: 'claimed', label: `${n.data.label} (Retry)`, agent: `0xNew...${Math.floor(Math.random()*999)}` } };
        }
        return n;
      }));
      setEdges((eds) => eds.map((e) => {
        return { ...e, style: undefined }; // Reset slashed red lines
      }));
      setLogs((prev) => [...prev, "[VALIDATION] Toxic payload detected! Slashed agent.", "[AUCTION] Re-auctioned slashed task. Claimed by new agent."]);
    }, 4500);

    const t3 = setTimeout(() => {
      setNodes((nds) => nds.map((n) => {
        if (n.id.startsWith('sub-')) return { ...n, data: { ...n.data, status: 'validating' } };
        return n;
      }));
      setLogs((prev) => [...prev, "[SYSTEM] Validating dependent branches in parallel by LLM-Judges..."]);
    }, 7000);

    const t4 = setTimeout(() => {
      setNodes((nds) => nds.map((n) => {
        if (n.id.startsWith('sub-')) return { ...n, data: { ...n.data, status: 'completed' } };
        return n;
      }));
      setLogs((prev) => [...prev, "[VALIDATION] All subtasks outputs verified.", "[PLANNER] Full DAG completion cryptographically verified."]);
    }, 9500);

    const t5 = setTimeout(() => {
      setNodes((nds) => nds.map((n) => {
        if (n.id === 'keeper') return { ...n, data: { ...n.data, status: 'keeper', agent: 'KeeperHub' } };
        return n;
      }));
      setLogs((prev) => [...prev, "[KEEPER] Executed payload on-chain.", "[ESCROW] Distributed unlocked USDC rewards to honest swarm agents."]);
    }, 12000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
    };
  }, [simulationTrigger]);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* App Header */}
      <header className="h-14 border-b border-border bg-background/95 backdrop-blur px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <span className="font-extrabold tracking-tighter text-lg">Swarm Explorer</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsDeployOpen(true)}
            className="flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Rocket className="w-3.5 h-3.5" />
            Deploy Agent
          </button>
          <span className="flex items-center gap-1.5 text-xs font-mono bg-green-500/10 text-green-600 dark:text-green-400 px-2 py-1 rounded-md border border-green-500/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            AXL Connected
          </span>
          <ThemeToggle />
        </div>
      </header>

      {/* Main Content Split */}
      <div className="flex flex-1 overflow-hidden flex-col md:flex-row">

        {/* Left Panel: Logs & Interaction */}
        <div className="w-full md:w-80 lg:w-96 border-r border-border bg-accent/20 flex flex-col shrink-0 h-1/3 md:h-full">
          <div className="p-4 border-b border-border bg-background flex items-center gap-2 shrink-0">
            <TerminalIcon className="w-4 h-4 text-primary" />
            <h3 className="font-semibold text-sm">Activity Feed</h3>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-[11px] sm:text-xs">
            {logs.map((log, i) => (
              <div
                key={i}
                className={cn(
                  "p-2 rounded border bg-background opacity-90 animate-in slide-in-from-left-2 duration-300",
                  log.includes("[SYSTEM]") ? "border-blue-500/30 text-blue-600 dark:text-blue-400" :
                    log.includes("[USER]") ? "border-neutral-500/30 text-foreground" :
                      log.includes("[ESCROW]") ? "border-green-500/30 text-green-600 dark:text-green-400" :
                        log.includes("[AUCTION]") ? "border-yellow-500/30 text-yellow-600 dark:text-yellow-400" :
                          log.includes("[VALIDATION]") && log.includes("REJECTED") ? "border-red-500/30 text-red-600 dark:text-red-400" :
                            log.includes("[VALIDATION]") ? "border-purple-500/30 text-purple-600 dark:text-purple-400" :
                              log.includes("[KEEPER]") ? "border-teal-500/30 text-teal-600 dark:text-teal-400" :
                                log.includes("[PLANNER]") ? "border-purple-500/30 text-purple-600 dark:text-purple-400" :
                                  log.includes("[COMPUTE]") ? "border-blue-500/30 text-blue-600 dark:text-blue-400" :
                                    "border-border text-muted-foreground"
                )}
              >
                {log}
              </div>
            ))}
          </div>

          <div className="p-4 border-t border-border bg-background shrink-0">
            <form onSubmit={(e) => { 
              e.preventDefault(); 
              if (inputText.trim()) { 
                generateRandomDAG(inputText);
                setInputText(""); 
              } 
            }} className="relative flex items-center">
              <input
                type="text"
                placeholder="Submit new task..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                className="w-full bg-accent/50 border border-border rounded-lg pl-3 pr-10 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
              />
              <button
                type="submit"
                disabled={!inputText.trim()}
                className="absolute right-2 p-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50 transition-opacity"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>
        </div>

        {/* Right Panel: React Flow DAG */}
        <div className="flex-1 relative bg-background">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            className="dark:bg-black"
          >
            <Background color="#888" gap={16} size={1} />
            <Controls className="dark:bg-neutral-900 dark:border-neutral-800 dark:fill-white" />
            <MiniMap
              className="dark:bg-neutral-900"
              maskColor="rgba(0,0,0, 0.2)"
              nodeColor={(n) => {
                const data = n.data as NodeData;
                if (data.status === 'completed') return '#22c55e';
                if (data.status === 'slashed') return '#ef4444';
                if (data.status === 'validating') return '#eab308';
                if (data.status === 'claimed') return '#3b82f6';
                if (data.status === 'planner') return '#a855f7';
                if (data.status === 'keeper') return '#14b8a6';
                return '#737373';
              }}
            />
          </ReactFlow>
        </div>

      </div>

      {/* Deploy Agents Modal */}
      {isDeployOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold tracking-tight">Deploy Your Custom Agent</h2>
              <button
                onClick={() => { setIsDeployOpen(false); setDeployStep(1); }}
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
                  deployStep === 1 ? "opacity-100 translate-x-0 relative" : "opacity-0 -translate-x-full absolute inset-0 pointer-events-none"
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

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Agent System Prompt</label>
                    <textarea 
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                    />
                  </div>

                  <button
                    onClick={() => setDeployStep(2)}
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
                  deployStep === 2 ? "opacity-100 translate-x-0 relative" : "opacity-0 translate-x-full absolute inset-0 pointer-events-none"
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
                    disabled={!isWalletConnected}
                    onClick={() => {
                      setIsDeployOpen(false);
                      setDeployStep(1);
                      generateRandomDAG(systemPrompt);
                    }}
                    className="w-full flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors mt-6 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Rocket className="w-4 h-4" />
                    Initialize Deployment
                  </button>
                  <button
                    onClick={() => setDeployStep(1)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Back
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppDashboard() {
  return (
    <Suspense fallback={<div className="flex h-screen w-full items-center justify-center bg-background text-foreground">Loading Swarm Explorer...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
