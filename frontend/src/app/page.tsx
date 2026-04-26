"use client";

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ThemeToggle } from '@/components/theme-toggle';
import TaskNode, { NodeData, cn } from '@/components/flow/task-node';
import { ArrowLeft, Send, Terminal as TerminalIcon, Rocket, X } from 'lucide-react';
import { useSwarmEvents } from '@/hooks/useSwarmEvents';
import { DeployAgentModal } from '@/components/DeployAgentModal';
import { Header } from '@/components/Header';

const nodeTypes = {
  task: TaskNode,
};

function DashboardContent() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [inputText, setInputText] = useState("");
  const [isDeployOpen, setIsDeployOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([
    "Waiting for user intent...",
    "Ready to generate and deploy DAG."
  ]);
  const [simulationTrigger, setSimulationTrigger] = useState(0);
  const { events } = useSwarmEvents();

  const submitRealDAG = async (intent: string) => {
    const newNodes: Node<NodeData>[] = [
      { id: '1', type: 'task', position: { x: 400, y: 50 }, data: { label: `User Intent: ${intent}`, status: 'completed', agent: '0xUser...123' } },
      { id: '2', type: 'task', position: { x: 400, y: 150 }, data: { label: 'Planner: Decompose Intent', status: 'planner', agent: '0xPlan...456' } },
    ];
    
    const newEdges: Edge[] = [
      { id: 'e1-2', source: '1', target: '2', animated: true }
    ];

    setNodes(newNodes);
    setEdges(newEdges);
    setLogs([
      "[SYSTEM] Connected to 0G Storage & Gensyn AXL.",
      `[USER] Submitted spec: ${intent}`,
      "[ESCROW] Locked user funds + execution fee.",
      "[API] Sending request to Swarm Backend..."
    ]);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const res = await fetch(`${apiUrl}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: intent, budget: "10" })
      });
      if (!res.ok) throw new Error("API request failed");
      setLogs(prev => [...prev, "[API] Task submitted successfully. Awaiting DAG_READY event via WebSocket..."]);
    } catch (err: any) {
      setLogs(prev => [...prev, `[ERROR] Failed to submit task: ${err.message}`]);
    }
  };

  // Sync AXL events → React Flow canvas and logs
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0]; // newest event is at index 0

    if (latest.type === 'TASK_SUBMITTED') {
      setLogs(prev => [...prev, `[AXL] TASK_SUBMITTED broadcasted.`]);
    }

    if (latest.type === 'DAG_READY') {
      const dagNodes: any[] = (latest.payload as any).nodes ?? [];
      setLogs(prev => [...prev, `[COMPUTE] Planner generated a dynamic DAG with ${dagNodes.length} tasks via OpenAI.`]);

      const spacingY = 150;
      const currentY = 300;
      const newFlowNodes: Node<NodeData>[] = [];
      const newFlowEdges: Edge[] = [];

      dagNodes.forEach((node: any, index: number) => {
        newFlowNodes.push({
          id: node.id,
          type: 'task',
          position: { x: 400, y: currentY + index * spacingY },
          data: { label: node.subtask, status: 'pending' },
        });
        if (index === 0) {
          newFlowEdges.push({ id: `e2-${node.id}`, source: '2', target: node.id, animated: true });
        } else {
          const parentId = node.prevHash ? node.prevHash.replace('hash-', '') : dagNodes[index - 1].id;
          newFlowEdges.push({ id: `e-${parentId}-${node.id}`, source: parentId, target: node.id, animated: true });
        }
      });

      const lastNodeId = dagNodes[dagNodes.length - 1]?.id;
      if (lastNodeId) {
        const keeperY = currentY + dagNodes.length * spacingY + 50;
        newFlowNodes.push({ id: 'keeper', type: 'task', position: { x: 400, y: keeperY }, data: { label: 'Execute On-Chain via KeeperHub', status: 'pending' } });
        newFlowEdges.push({ id: `e-${lastNodeId}-keeper`, source: lastNodeId, target: 'keeper', animated: true });
      }

      setNodes(prev => [...prev.slice(0, 2), ...newFlowNodes]);
      setEdges(prev => [...prev.slice(0, 1), ...newFlowEdges]);
    }

    if (latest.type === 'SUBTASK_CLAIMED') {
      const { nodeId, agentId } = latest.payload as any;
      setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, status: 'claimed', agent: agentId } } : n));
      setLogs(prev => [...prev, `[AUCTION] Node ${nodeId} claimed by ${agentId}`]);
    }

    if (latest.type === 'SUBTASK_DONE') {
      const { nodeId } = latest.payload as any;
      setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, status: 'completed' } } : n));
      setLogs(prev => [...prev, `[WORKER] Node ${nodeId} completed.`]);
    }

    if (latest.type === 'CHALLENGE' || latest.type === 'TASK_REOPENED') {
      const { nodeId } = latest.payload as any;
      setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, status: 'slashed', label: `${n.data.label} (Slashed/Retry)` } } : n));
      setLogs(prev => [...prev, `[VALIDATION] Node ${nodeId} challenged/slashed! Re-opening task...`]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />


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
                submitRealDAG(inputText);
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

        {/* Right Panel: React Flow DAG + DAGBoard */}
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

          {/* DAGBoard overlay was removed */}
        </div>

      </div>

      {/* Deploy Agents Modal */}
      <DeployAgentModal 
        isOpen={isDeployOpen} 
        onClose={() => setIsDeployOpen(false)}
        onSuccess={(containerId) => {
          setLogs(prev => [...prev, `[SYSTEM] Agent deployed successfully! Container ID: ${containerId.slice(0, 12)}...`]);
        }}
      />
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
