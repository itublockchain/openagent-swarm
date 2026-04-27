"use client";

import React, { useState, useEffect, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ThemeToggle } from '@/components/theme-toggle';
import TaskNode, { NodeData, cn } from '@/components/flow/task-node';
import { Send, Terminal as TerminalIcon, Rocket, X } from 'lucide-react';
import { useSwarmEvents } from '@/hooks/useSwarmEvents';
import { DeployAgentModal } from '@/components/DeployAgentModal';
import { Header } from '@/components/Header';
import { apiRequest } from '../../lib/api';

const nodeTypes = {
  task: TaskNode,
};

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [inputText, setInputText] = useState("");
  const [isDeployOpen, setIsDeployOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([
    "Waiting for user intent...",
    "Ready to generate and deploy DAG."
  ]);
  
  const { dag, events, taskIdFromUrl } = useSwarmEvents();

  // Sync DAG state from hook to React Flow
  useEffect(() => {
    if (!dag) return;

    const currentY = 250;
    const spacingY = 100;
    
    const newFlowNodes: Node<NodeData>[] = [
      { id: '1', type: 'task', position: { x: 400, y: 50 }, data: { label: `Active Task: ${dag.taskId.slice(0, 8)}...`, status: 'completed', agent: 'api-server' } },
      { id: '2', type: 'task', position: { x: 400, y: 150 }, data: { label: 'Planner: Decompose Intent', status: 'planner', agent: 'distributed-agent' } },
    ];
    
    const newFlowEdges: Edge[] = [
      { id: 'e1-2', source: '1', target: '2', animated: true }
    ];

    dag.boxes.forEach((box, index) => {
      newFlowNodes.push({
        id: box.nodeId,
        type: 'task',
        position: { x: 400, y: currentY + index * spacingY },
        data: { 
          label: box.subtask, 
          status: box.status === 'done' ? 'completed' : (box.status === 'claimed' ? 'claimed' : (box.status === 'failed' ? 'slashed' : 'pending')),
          agent: box.agentId
        },
      });

      if (index === 0) {
        newFlowEdges.push({ id: `e2-${box.nodeId}`, source: '2', target: box.nodeId, animated: true });
      } else {
        const prevId = dag.boxes[index - 1].nodeId;
        newFlowEdges.push({ id: `e-${prevId}-${box.nodeId}`, source: prevId, target: box.nodeId, animated: true });
      }
    });

    setNodes(newFlowNodes);
    setEdges(newFlowEdges);
  }, [dag, setNodes, setEdges]);

  // Handle task submission
  const submitRealDAG = async (intent: string) => {
    setLogs(prev => [...prev, `[USER] Submitting spec: ${intent}`]);

    try {
      const res = await apiRequest('/task', {
        method: 'POST',
        body: JSON.stringify({ spec: intent, budget: "10" })
      });
      if (!res.ok) throw new Error("API request failed");
      const data = await res.json();
      
      // Update URL with taskId
      const params = new URLSearchParams(searchParams.toString());
      params.set('taskId', data.taskId);
      router.replace(`?${params.toString()}`);

      setLogs(prev => [...prev, `[API] Task ${data.taskId.slice(0, 8)} submitted. Awaiting DAG...`]);
    } catch (err: any) {
      setLogs(prev => [...prev, `[ERROR] Failed to submit task: ${err.message}`]);
    }
  };

  // Sync logs from events
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    setLogs(prev => [...prev, `[${new Date(latest.timestamp).toLocaleTimeString()}] ${latest.type}`].slice(-100));
  }, [events]);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />

      {/* Main Content Split */}
      <div className="flex flex-1 overflow-hidden flex-col md:flex-row">
        
        {/* Left: Swarm Intelligence Flow (React Flow) */}
        <div className="flex-1 relative border-r border-border bg-muted/5">
          <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
             <div className="bg-background/80 backdrop-blur px-3 py-1.5 rounded-lg border border-border shadow-sm flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">Gensyn AXL Stream Active</span>
             </div>
             {taskIdFromUrl && (
               <div className="bg-primary/10 text-primary px-3 py-1.5 rounded-lg border border-primary/20 shadow-sm text-[10px] font-bold">
                 TASK: {taskIdFromUrl.slice(0, 12)}...
               </div>
             )}
          </div>
          
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            className="bg-dot-pattern"
          >
            <Background color="#888" strokeWidth={0.5} gap={20} />
            <Controls className="fill-foreground" />
          </ReactFlow>
        </div>

        {/* Right: Terminal & Prompt */}
        <div className="w-full md:w-[380px] flex flex-col bg-background/50 backdrop-blur-sm shrink-0 border-t md:border-t-0 md:border-l border-border">
          
          {/* Logs Terminal */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="h-9 px-4 border-b border-border flex items-center justify-between bg-muted/20">
              <div className="flex items-center gap-2">
                <TerminalIcon className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Orchestration Logs</span>
              </div>
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-red-500/20" />
                <div className="w-2 h-2 rounded-full bg-yellow-500/20" />
                <div className="w-2 h-2 rounded-full bg-green-500/20" />
              </div>
            </div>
            
            <div className="flex-1 p-4 font-mono text-[11px] overflow-y-auto space-y-1.5 bg-background/30">
              {logs.map((log, i) => (
                <div key={i} className={cn(
                  "border-l-2 pl-2 transition-all",
                  log.includes('[ERROR]') ? "border-red-500 text-red-400 bg-red-500/5" : 
                  log.includes('[SYSTEM]') ? "border-blue-500 text-blue-400" :
                  log.includes('[USER]') ? "border-green-500 text-foreground font-bold" :
                  "border-muted text-muted-foreground"
                )}>
                  {log}
                </div>
              ))}
            </div>
          </div>

          {/* Prompt Area */}
          <div className="p-4 border-t border-border bg-background">
            <div className="relative group">
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Enter swarm intent (e.g. Research AI trends on X)..."
                className="w-full bg-muted/30 border border-border rounded-xl p-4 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all resize-none h-24"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitRealDAG(inputText);
                    setInputText("");
                  }
                }}
              />
              <button
                onClick={() => {
                  submitRealDAG(inputText);
                  setInputText("");
                }}
                disabled={!inputText.trim()}
                className="absolute bottom-3 right-3 p-2 bg-primary text-primary-foreground rounded-lg hover:scale-105 transition-transform disabled:opacity-30 disabled:hover:scale-100"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-3 flex items-center justify-between px-1">
               <div className="flex gap-2">
                  <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">GPT-4o</span>
                  <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">10 USDC Budget</span>
               </div>
               <span className="text-[10px] text-muted-foreground italic">Press Enter to dispatch</span>
            </div>
          </div>
        </div>
      </div>

      <DeployAgentModal 
        isOpen={isDeployOpen} 
        onClose={() => setIsDeployOpen(false)}
        onSuccess={() => {}}
      />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div>Loading Dashboard...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
