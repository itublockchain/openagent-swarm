"use client";

import React, { useState, useEffect, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAccount, useWriteContract, useChainId, useSwitchChain } from 'wagmi';
import { waitForTransactionReceipt, readContract } from '@wagmi/core';
import { ThemeToggle } from '@/components/theme-toggle';
import TaskNode, { NodeData, cn } from '@/components/flow/task-node';
import { Send, Terminal as TerminalIcon, Rocket, X } from 'lucide-react';
import { useSwarmEvents } from '@/hooks/useSwarmEvents';
import { DeployAgentModal } from '@/components/DeployAgentModal';
import { Header } from '@/components/Header';
import { apiRequest } from '../../lib/api';
import { config as wagmiConfig, ogTestnet } from '../../lib/wagmi';
import { ERC20_ABI, SWARM_ESCROW_ABI } from '@/lib/contracts';

const nodeTypes = {
  task: TaskNode,
};

type SubmitStep = 'idle' | 'preparing' | 'approving' | 'creating' | 'submitting' | 'done' | 'error';

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [inputText, setInputText] = useState("");
  const [isDeployOpen, setIsDeployOpen] = useState(false);
  const [submitStep, setSubmitStep] = useState<SubmitStep>('idle');
  const [logs, setLogs] = useState<string[]>([
    "Waiting for user intent...",
    "Ready to generate and deploy DAG."
  ]);

  const { dag, events, taskIdFromUrl } = useSwarmEvents();
  const { address: walletAddress } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

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

  // User-signed task submission flow:
  //   1. /task/prepare → backend uploads spec to storage, returns taskIdBytes32 + budgetWei
  //   2. wagmi: USDC.approve(escrow, budget) — skipped if existing allowance is sufficient
  //   3. wagmi: SwarmEscrow.createTask(taskIdBytes32, budget) — user funds the escrow
  //   4. /task → backend verifies on-chain task exists, broadcasts to AXL mesh
  const submitRealDAG = async (intent: string) => {
    if (!walletAddress) {
      setLogs(prev => [...prev, `[ERROR] No wallet connected. Connect first.`]);
      return;
    }

    const budget = "10";
    // Fresh nonce per submission so identical specs don't collide on the
    // content-addressed taskId (would revert with "Task already exists").
    const submissionNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSubmitStep('preparing');
    setLogs(prev => [...prev, `[USER] Submitting spec: ${intent}`]);

    try {
      // 0. Switch wallet to 0G Galileo if it's on a different chain.
      if (currentChainId !== ogTestnet.id) {
        setLogs(prev => [...prev, `[L2] Switching wallet to chainId ${ogTestnet.id}...`]);
        try {
          await switchChainAsync({ chainId: ogTestnet.id });
        } catch (err: any) {
          if (err?.code === 4902 || /unrecognized chain/i.test(String(err?.message))) {
            throw new Error('Add 0G Galileo testnet (chainId 16602, RPC https://evmrpc-testnet.0g.ai) to your wallet, then retry');
          }
          throw err;
        }
      }

      // 1. Prepare
      const prepRes = await apiRequest('/task/prepare', {
        method: 'POST',
        body: JSON.stringify({ spec: intent, budget, nonce: submissionNonce }),
      });
      if (!prepRes.ok) throw new Error(`prepare failed: ${prepRes.status}`);
      const prep = await prepRes.json() as {
        specHash: string;
        taskIdBytes32: `0x${string}`;
        budgetWei: string;
        decimals: number;
        escrowAddress: `0x${string}`;
        usdcAddress: `0x${string}`;
      };
      setLogs(prev => [...prev, `[L2] Prepared task ${prep.taskIdBytes32.slice(0, 12)}... budget=${budget} mUSDC`]);
      const budgetWei = BigInt(prep.budgetWei);

      // 2. Approve USDC if allowance is insufficient.
      const allowance = await readContract(wagmiConfig, {
        address: prep.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [walletAddress, prep.escrowAddress],
      }) as bigint;

      // 0G testnet RPC sometimes lags ~30s before propagating receipts.
      // Bump timeout (default ~60s) and slow polling so we don't see
      // "Transaction may not be processed on a block yet" too eagerly.
      const RECEIPT_OPTS = { timeout: 180_000, pollingInterval: 3_000 } as const;

      if (allowance < budgetWei) {
        setSubmitStep('approving');
        setLogs(prev => [...prev, `[L2] Approving USDC (current allowance ${allowance.toString()})...`]);
        const approveHash = await writeContractAsync({
          address: prep.usdcAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [prep.escrowAddress, budgetWei],
          chainId: ogTestnet.id,
        });
        setLogs(prev => [...prev, `[L2] approve tx: ${approveHash}`]);
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, ...RECEIPT_OPTS });
        setLogs(prev => [...prev, `[L2] approve confirmed`]);
      } else {
        setLogs(prev => [...prev, `[L2] allowance sufficient, skipping approve`]);
      }

      // 3. createTask — but only if the escrow doesn't already have this task.
      // Specs are content-addressed, so resubmitting the same spec yields the
      // same taskId; the contract would revert with "Task already exists".
      // Detect upfront and skip straight to the AXL broadcast in that case.
      setSubmitStep('creating');
      const existing = (await readContract(wagmiConfig, {
        address: prep.escrowAddress,
        abi: SWARM_ESCROW_ABI,
        functionName: 'tasks',
        args: [prep.taskIdBytes32],
      })) as readonly [`0x${string}`, bigint, bigint, boolean];
      const existingOwner = existing[0];

      if (existingOwner !== '0x0000000000000000000000000000000000000000') {
        setLogs(prev => [...prev, `[L2] Task already on-chain (owner=${existingOwner.slice(0, 6)}…${existingOwner.slice(-4)}), skipping createTask`]);
      } else {
        setLogs(prev => [...prev, `[L2] Creating task on-chain...`]);
        const createHash = await writeContractAsync({
          address: prep.escrowAddress,
          abi: SWARM_ESCROW_ABI,
          functionName: 'createTask',
          args: [prep.taskIdBytes32, budgetWei],
          chainId: ogTestnet.id,
        });
        setLogs(prev => [...prev, `[L2] createTask tx: ${createHash}`]);
        try {
          await waitForTransactionReceipt(wagmiConfig, { hash: createHash, ...RECEIPT_OPTS });
        } catch (err: any) {
          // Receipt fetch can time out on a slow RPC even though the tx
          // landed. Verify on-chain state directly before giving up.
          const verify = (await readContract(wagmiConfig, {
            address: prep.escrowAddress,
            abi: SWARM_ESCROW_ABI,
            functionName: 'tasks',
            args: [prep.taskIdBytes32],
          })) as readonly [`0x${string}`, bigint, bigint, boolean];
          if (verify[0] === '0x0000000000000000000000000000000000000000') {
            throw err; // really not on-chain
          }
          setLogs(prev => [...prev, `[L2] createTask receipt timed out, but task IS on-chain — continuing`]);
        }
        setLogs(prev => [...prev, `[L2] createTask confirmed`]);
      }

      // 4. Broadcast to AXL — backend re-uploads the same body to 0G storage
      // (content-addressed → same hash) then verifies the task exists on-chain.
      // Same nonce as /prepare so the storage hash matches.
      setSubmitStep('submitting');
      const submitRes = await apiRequest('/task', {
        method: 'POST',
        body: JSON.stringify({ spec: intent, budget, nonce: submissionNonce }),
      });
      if (!submitRes.ok) {
        const detail = await submitRes.json().catch(() => ({}));
        throw new Error(`submit failed: ${detail.error ?? submitRes.status}`);
      }
      const data = await submitRes.json();

      const params = new URLSearchParams(searchParams.toString());
      params.set('taskId', data.taskId);
      router.replace(`?${params.toString()}`);

      setSubmitStep('done');
      setLogs(prev => [...prev, `[API] Task ${data.taskId.slice(0, 8)} broadcast to AXL. Awaiting DAG...`]);
    } catch (err: any) {
      setSubmitStep('error');
      const msg = err?.shortMessage || err?.message || String(err);
      setLogs(prev => [...prev, `[ERROR] (step=${submitStep}) ${msg}`]);
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
                disabled={submitStep !== 'idle' && submitStep !== 'done' && submitStep !== 'error'}
                className="w-full bg-muted/30 border border-border rounded-xl p-4 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all resize-none h-24 disabled:opacity-60"
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
                disabled={
                  !inputText.trim() ||
                  (submitStep !== 'idle' && submitStep !== 'done' && submitStep !== 'error')
                }
                className="absolute bottom-3 right-3 p-2 bg-primary text-primary-foreground rounded-lg hover:scale-105 transition-transform disabled:opacity-30 disabled:hover:scale-100"
              >
                <Send className="w-4 h-4" />
              </button>
              {submitStep !== 'idle' && submitStep !== 'done' && (
                <div className="absolute -top-2 left-3 bg-background px-2 text-[10px] font-bold uppercase tracking-wider text-primary">
                  {submitStep === 'preparing' && 'Preparing...'}
                  {submitStep === 'approving' && 'Approving USDC...'}
                  {submitStep === 'creating' && 'Creating on-chain...'}
                  {submitStep === 'submitting' && 'Submitting to swarm...'}
                  {submitStep === 'error' && '⚠ Error — see logs'}
                </div>
              )}
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
