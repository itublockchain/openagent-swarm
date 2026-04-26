"use client";

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ThemeToggle } from '@/components/theme-toggle';
import TaskNode, { NodeData, cn } from '@/components/flow/task-node';
import { ArrowLeft, Send, Terminal as TerminalIcon } from 'lucide-react';

const nodeTypes = {
  task: TaskNode,
};

function DashboardContent() {
  const searchParams = useSearchParams();
  const taskQuery = searchParams.get('task');
  const userIntent = taskQuery ? `User Intent: ${taskQuery}` : 'User Intent: Swap 100 USDC to ETH on Optimism';
  const submittedLog = taskQuery ? `[USER] Submitted spec: ${taskQuery}` : '[USER] Submitted spec: Swap 100 USDC to ETH on Optimism.';

  const initialNodes: Node<NodeData>[] = [
    { id: '1', type: 'task', position: { x: 400, y: 50 }, data: { label: userIntent, status: 'completed', agent: '0xUser...123' } },
    { id: '2', type: 'task', position: { x: 400, y: 150 }, data: { label: 'Planner: Decompose Intent', status: 'planner', agent: '0xPlan...456' } },
    { id: '3', type: 'task', position: { x: 150, y: 300 }, data: { label: 'Subtask 1: Generate Smart Contract', status: 'completed', agent: '0xGenA...987' } },
    { id: '5', type: 'task', position: { x: 650, y: 300 }, data: { label: 'Subtask 3: Bridge USDC Base -> ARB', status: 'completed', agent: '0xBrid...333' } },
    { id: '4', type: 'task', position: { x: 150, y: 450 }, data: { label: 'Subtask 2: Deploy to Arbitrum (Retry)', status: 'slashed', agent: '0xBad...000' } },
    { id: '7', type: 'task', position: { x: -50, y: 600 }, data: { label: 'Subtask 5: Register DID on 0G', status: 'pending' } },
    { id: '6', type: 'task', position: { x: 400, y: 600 }, data: { label: 'Subtask 4: Fund Deployed Contract', status: 'pending' } },
    { id: '8', type: 'task', position: { x: 400, y: 750 }, data: { label: 'Execute On-Chain via KeeperHub', status: 'pending' } },
  ];

  const initialEdges: Edge[] = [
    { id: 'e1-2', source: '1', target: '2', animated: true },
    { id: 'e2-3', source: '2', target: '3', animated: true },
    { id: 'e2-5', source: '2', target: '5', animated: true },
    { id: 'e3-4', source: '3', target: '4', animated: true, style: { stroke: '#ef4444' } }, // Slashed route representation
    { id: 'e4-7', source: '4', target: '7', animated: true },
    { id: 'e4-6', source: '4', target: '6', animated: true },
    { id: 'e5-6', source: '5', target: '6', animated: true },
    { id: 'e7-8', source: '7', target: '8', animated: true },
    { id: 'e6-8', source: '6', target: '8', animated: true },
  ];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [inputText, setInputText] = useState("");
  const [logs, setLogs] = useState<string[]>([
    "[SYSTEM] Connected to 0G Storage & Gensyn AXL.",
    submittedLog,
    "[ESCROW] Locked user funds + execution fee.",
    "[AUCTION] Planner Agent 0xPlan...456 staked 15 USDC.",
    "[COMPUTE] Planner generated 5-node dependent DAG.",
    "[AUCTION] Subtask 1 claimed by 0xGenA...987. Output verified.",
    "[AUCTION] Subtask 3 claimed by 0xBrid...333. Output verified.",
    "[AUCTION] Subtask 2 claimed by 0xBad...000.",
    "[VALIDATION] Subtask 2 output REJECTED (Toxic payload)! Slashed 10 USDC.",
    "[AUCTION] Subtask 2 re-auctioned. Claimed by 0xGood...111.",
  ]);

  // Simulate dynamic status changes across multiple steps
  useEffect(() => {
    // Step 1: Retry success, subsequent tasks become validating
    const timer1 = setTimeout(() => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === '4') return { ...n, data: { ...n.data, status: 'completed', agent: '0xGood...111' } };
          if (n.id === '6') return { ...n, data: { ...n.data, status: 'validating', agent: '0xFund...444' } };
          if (n.id === '7') return { ...n, data: { ...n.data, status: 'validating', agent: '0xRegI...555' } };
          return n;
        })
      );
      setEdges((eds) => 
        eds.map((e) => {
          if (e.id === 'e3-4') return { ...e, style: { stroke: '#22c55e' } }; // Fix slashed path visually
          return e;
        })
      );
      setLogs((prev) => [
        ...prev,
        "[VALIDATION] Subtask 2 output verified by LLM-Judge.",
        "[AUCTION] Subtask 4 claimed by 0xFund...444.",
        "[AUCTION] Subtask 5 claimed by 0xRegI...555.",
        "[SYSTEM] Validating dependent branches in parallel..."
      ]);
    }, 4000);

    // Step 2: Final completion and Keeper execution
    const timer2 = setTimeout(() => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === '6' || n.id === '7') return { ...n, data: { ...n.data, status: 'completed' } };
          if (n.id === '8') return { ...n, data: { ...n.data, status: 'keeper', agent: 'KeeperHub' } };
          return n;
        })
      );
      setLogs((prev) => [
        ...prev,
        "[VALIDATION] Subtasks 4 & 5 outputs verified.",
        "[PLANNER] Full DAG completion cryptographically verified.",
        "[KEEPER] Compiling final state transitions...",
        "[KEEPER] Executed payload on-chain (KeeperHub).",
        "[ESCROW] Distributed unlocked USDC rewards to honest swarm agents."
      ]);
    }, 8000);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [setNodes, setEdges]);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* App Header */}
      <header className="h-14 border-b border-border bg-background/95 backdrop-blur px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 text-sm font-medium">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
          <div className="h-4 w-px bg-border"></div>
          <span className="font-extrabold tracking-tighter text-lg">Swarm Explorer</span>
        </div>
        <div className="flex items-center gap-3">
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
            <form onSubmit={(e) => { e.preventDefault(); if(inputText.trim()) { setLogs(p => [...p, `[USER] ${inputText}`]); setInputText(""); } }} className="relative flex items-center">
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
                if(data.status === 'completed') return '#22c55e';
                if(data.status === 'slashed') return '#ef4444';
                if(data.status === 'validating') return '#eab308';
                if(data.status === 'claimed') return '#3b82f6';
                if(data.status === 'planner') return '#a855f7';
                if(data.status === 'keeper') return '#14b8a6';
                return '#737373';
              }} 
            />
          </ReactFlow>
        </div>

      </div>
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
