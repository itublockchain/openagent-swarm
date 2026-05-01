"use client";

import React, { useState, useEffect, Suspense, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAccount, useWriteContract, useChainId, useSwitchChain } from 'wagmi';
import { waitForTransactionReceipt, readContract } from '@wagmi/core';
import TaskNode, { NodeData } from '@/components/flow/task-node';                                                       
import { CanvasEmptyState } from '@/components/flow/CanvasEmptyState';
import { IntentSuggestions } from '@/components/flow/IntentSuggestions';
import { LogsPanel } from '@/components/flow/LogsPanel';
import { PromptConfigRow, type ModelId } from '@/components/flow/PromptConfigRow';
import { Send, Loader2, Plus } from 'lucide-react';
import { CopyableId } from '@/components/ui/copyable-id';
import { useSporeEvents, SubtaskStatus } from '@/hooks/useSporeEvents';
import { DeployAgentModal } from '@/components/DeployAgentModal';
import { Header } from '@/components/Header';
import { apiRequest } from '../../../../lib/api';
import { ENV } from '../../../../lib/env';
import { config as wagmiConfig, ogTestnet } from '../../../../lib/wagmi';
import { ERC20_ABI, SPORE_ESCROW_ABI } from '@/lib/contracts';
import { cn } from '@/lib/utils';

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
  const [model, setModel] = useState<ModelId>('gpt-4o');
  const [budget, setBudget] = useState<number>(10);
  // Colony scope for the next dispatch. null = public, any agent claims;
  // a colony id restricts to that colony's members. Populated by the
  // /v1/me/colonies fetch below; if the user has no colonies the dropdown
  // hides and this stays null forever.
  const [selectedColony, setSelectedColony] = useState<string | null>(null);
  const [colonies, setColonies] = useState<Array<{ id: string; name: string }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isDeployOpen, setIsDeployOpen] = useState(false);
  const [submitStep, setSubmitStep] = useState<SubmitStep>('idle');
  const [logs, setLogs] = useState<string[]>([
    "Waiting for user intent...",
    "Ready to generate and deploy DAG."
  ]);

  const { dag, events, taskIdFromUrl } = useSporeEvents();

  // Resizable right panel: min = 380px (initial size), max = 50vw.
  // Inline width is only applied at md+ — below that the panel stacks full-width.
  const PANEL_MIN = 380;
  const [panelWidth, setPanelWidth] = useState(PANEL_MIN);
  const [isDesktop, setIsDesktop] = useState(false);
  const isResizingRef = useRef(false);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Clamp panel width when the viewport shrinks so the 50vw cap stays honored.
  useEffect(() => {
    const clamp = () => {
      setPanelWidth((w) => {
        const max = Math.floor(window.innerWidth * 0.5);
        return Math.min(Math.max(PANEL_MIN, w), Math.max(PANEL_MIN, max));
      });
    };
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const max = Math.floor(window.innerWidth * 0.5);
      const next = window.innerWidth - e.clientX;
      setPanelWidth(Math.min(Math.max(PANEL_MIN, next), Math.max(PANEL_MIN, max)));
    };
    const onUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Elapsed-time ticker for status bar. Resets when a new taskId arrives.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!taskIdFromUrl) return;
    const start = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setElapsedSec(0);
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [taskIdFromUrl]);
  const elapsedFmt = `${Math.floor(elapsedSec / 60).toString().padStart(2, '0')}:${(elapsedSec % 60).toString().padStart(2, '0')}`;
  const completedCount = nodes.filter(n => n.data?.status === 'completed').length;

  // Five-phase indicator strip. Each phase is "done", "active", or "pending"
  // based on observable state (DAG / node statuses).
  const phases = (() => {
    const taskNodes = nodes.filter(n => !['1', '2'].includes(n.id));
    const hasClaim = taskNodes.some(n => ['claimed', 'validating', 'completed', 'slashed'].includes(n.data?.status as string));
    const hasValidate = taskNodes.some(n => ['validating', 'completed'].includes(n.data?.status as string));
    const allDone = taskNodes.length > 0 && taskNodes.every(n => n.data?.status === 'completed');

    const stepOf = (done: boolean, active: boolean) =>
      done ? 'done' as const : active ? 'active' as const : 'pending' as const;

    return [
      { key: 'spec',     label: 'Spec',     state: stepOf(!!dag || !!taskIdFromUrl, !!taskIdFromUrl && !dag) },
      { key: 'plan',     label: 'Plan',     state: stepOf(!!dag, !taskIdFromUrl ? false : !dag) },
      { key: 'claim',    label: 'Claim',    state: stepOf(hasValidate || allDone, !!dag && !hasValidate && hasClaim) },
      { key: 'validate', label: 'Validate', state: stepOf(allDone, hasValidate && !allDone) },
      { key: 'settle',   label: 'Settle',   state: stepOf(false, allDone) },
    ];
  })();
  const { address: walletAddress } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  // Fetch the user's own colonies + all public colonies so the explorer
  // dropdown surfaces both: own (any visibility) and public (others'
  // colonies the user can dispatch into). Backend rejects private + non-
  // owner submissions with 403, so the visible options here mirror what
  // the user can actually use. Refresh on 30s interval.
  useEffect(() => {
    const load = async () => {
      try {
        // Two parallel reads. /v1/me/colonies needs JWT (silently fails
        // without a wallet); /v1/colonies/public is open. Merge dedupe
        // by id so own-public colonies don't appear twice.
        const tasks: Array<Promise<Array<{ id: string; name: string }>>> = []
        if (walletAddress) {
          tasks.push(
            apiRequest('/v1/me/colonies')
              .then(r => r.ok ? r.json() : { colonies: [] })
              .then((d: { colonies: Array<{ id: string; name: string }> }) =>
                d.colonies.map(c => ({ id: c.id, name: c.name })),
              )
              .catch(() => []),
          )
        }
        tasks.push(
          fetch(`${ENV.API_URL}/v1/colonies/public`)
            .then(r => r.ok ? r.json() : { colonies: [] })
            .then((d: { colonies: Array<{ id: string; name: string }> }) =>
              d.colonies.map(c => ({ id: c.id, name: `${c.name} (public)` })),
            )
            .catch(() => []),
        )
        const results = await Promise.all(tasks)
        const merged = new Map<string, { id: string; name: string }>()
        for (const list of results) {
          for (const c of list) {
            // Own listing wins over public if a colony appears in both
            // (i.e., user-owned public). Iteration order is own → public.
            if (!merged.has(c.id)) merged.set(c.id, c)
          }
        }
        setColonies(Array.from(merged.values()))
      } catch (err) {
        console.warn('[explorer] colonies fetch failed:', err)
      }
    }
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [walletAddress])

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

    // Map our 5-state lifecycle (idle / claimed / pending / done / failed)
    // to TaskNode's visual states. 'pending' from the hook means the worker
    // has submitted output and is waiting for batch validation — that's the
    // userflow's "yellow" stage and maps to TaskNode's 'validating'.
    const statusMap: Record<SubtaskStatus, NodeData['status']> = {
      idle: 'pending',
      claimed: 'claimed',
      pending: 'validating',
      done: 'completed',
      failed: 'slashed',
    };

    dag.boxes.forEach((box, index) => {
      newFlowNodes.push({
        id: box.nodeId,
        type: 'task',
        position: { x: 400, y: currentY + index * spacingY },
        data: {
          label: box.subtask,
          status: statusMap[box.status] ?? 'pending',
          agent: box.agentId,
          passCount: box.passes?.length ?? 0,
          jury: box.jury
            ? {
                guilty: box.jury.guilty,
                innocent: box.jury.innocent,
                voters: box.jury.voters.length,
                committed: box.jury.committed.length,
              }
            : undefined,
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
  //   3. wagmi: SporeEscrow.createTask(taskIdBytes32, budget) — user funds the escrow
  //   4. /task → backend verifies on-chain task exists, broadcasts to AXL mesh
  const submitRealDAG = async (intent: string) => {
    if (!walletAddress) {
      setLogs(prev => [...prev, `[ERROR] No wallet connected. Connect first.`]);
      return;
    }

    const budgetStr = String(budget);
    // Fresh nonce per submission so identical specs don't collide on the
    // content-addressed taskId (would revert with "Task already exists").
    const submissionNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSubmitStep('preparing');
    setLogs(prev => [...prev, `[USER] Submitting spec: ${intent} (model=${model}, budget=${budgetStr} USDC)`]);

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
        body: JSON.stringify({ spec: intent, budget: budgetStr, nonce: submissionNonce, colonyId: selectedColony ?? undefined }),
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
      setLogs(prev => [...prev, `[L2] Prepared task ${prep.taskIdBytes32.slice(0, 12)}... budget=${budgetStr} mUSDC`]);
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
        abi: SPORE_ESCROW_ABI,
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
          abi: SPORE_ESCROW_ABI,
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
            abi: SPORE_ESCROW_ABI,
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
        body: JSON.stringify({ spec: intent, budget: budgetStr, nonce: submissionNonce, colonyId: selectedColony ?? undefined }),
      });
      if (!submitRes.ok) {
        const detail = await submitRes.json().catch(() => ({}));
        throw new Error(`submit failed: ${detail.error ?? submitRes.status}`);
      }
      const data = await submitRes.json();

      const params = new URLSearchParams(searchParams.toString());
      params.set('taskId', data.taskId);
      params.delete('intent');
      router.replace(`?${params.toString()}`);

      setSubmitStep('done');
      setLogs(prev => [...prev, `[API] Task ${data.taskId.slice(0, 8)} broadcast to AXL. Awaiting DAG...`]);
    } catch (err: any) {
      setSubmitStep('error');
      const msg = err?.shortMessage || err?.message || String(err);
      setLogs(prev => [...prev, `[ERROR] (step=${submitStep}) ${msg}`]);
    }
  };

  // Auto-submit ?intent= from landing CTA. Guard against React 19 Strict Mode double-effect.
  // Wait for wallet — submitRealDAG no-ops without one and the user gets a confusing
  // "[ERROR] No wallet connected" log instead of an actionable hint.
  const intentParam = searchParams.get('intent');
  const submittedIntentRef = useRef(false);
  useEffect(() => {
    if (intentParam && !submittedIntentRef.current && !taskIdFromUrl && walletAddress) {
      submittedIntentRef.current = true;
      submitRealDAG(intentParam);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentParam, taskIdFromUrl, walletAddress]); // added walletAddress as dependency

  // Sync logs from events
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    setLogs(prev => [...prev, `[${new Date(latest.timestamp).toLocaleTimeString()}] ${latest.type}`].slice(-100));
  }, [events]);

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
      <Header onDeployClick={() => setIsDeployOpen(true)} />

      {/* Main Content Split */}
      <div className="flex flex-1 overflow-hidden flex-col md:flex-row">
        
        {/* Left: SPORE Intelligence Flow (React Flow) */}
        <div className="flex-1 flex flex-col border-r border-border bg-muted/5 min-w-0">
          <div className="h-9 px-4 border-b border-border bg-background/85 backdrop-blur flex items-center gap-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-foreground/85 font-semibold">Gensyn AXL Live</span>
            </div>
            {taskIdFromUrl && (
              <>
                <span className="opacity-30">·</span>
                <span className="flex items-center gap-1.5"><span className="opacity-60">Task</span><CopyableId value={taskIdFromUrl} head={6} tail={4} /></span>
              </>
            )}
            {nodes.length > 0 && (
              <>
                <span className="opacity-30">·</span>
                <span><span className="opacity-60">Nodes</span> <span className="tabular-nums">{completedCount}/{nodes.length}</span></span>
              </>
            )}
            {taskIdFromUrl && (
              <span className="ml-auto tabular-nums">
                <span className="opacity-60">Elapsed</span> {elapsedFmt}
              </span>
            )}
          </div>

          {/* Phase strip */}
          {taskIdFromUrl && (
            <div className="px-4 py-2 border-b border-border bg-background/60 backdrop-blur shrink-0">
              <ol className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest">
                {phases.map((p, i) => (
                  <li key={p.key} className="flex items-center gap-1 flex-1 min-w-0">
                    <span
                      className={cn(
                        'flex items-center justify-center w-4 h-4 rounded-full border text-[9px] font-bold tabular-nums shrink-0',
                        p.state === 'done' && 'bg-green-500 border-green-500 text-white',
                        p.state === 'active' && 'bg-yellow-500/20 border-yellow-500 text-yellow-600 dark:text-yellow-400 animate-pulse',
                        p.state === 'pending' && 'bg-muted border-border text-muted-foreground',
                      )}
                    >
                      {i + 1}
                    </span>
                    <span
                      className={cn(
                        'truncate',
                        p.state === 'done' && 'text-foreground',
                        p.state === 'active' && 'text-yellow-600 dark:text-yellow-400 font-semibold',
                        p.state === 'pending' && 'text-muted-foreground/60',
                      )}
                    >
                      {p.label}
                    </span>
                    {i < phases.length - 1 && (
                      <span className={cn('flex-1 h-px', p.state === 'done' ? 'bg-green-500/40' : 'bg-border')} />
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="relative flex-1 min-h-0">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              fitView
              className="bg-dot-pattern"
            >
              <Background color="#888" gap={20} />
              <Controls className="fill-foreground" />
            </ReactFlow>
            <CanvasEmptyState visible={nodes.length === 0 && submitStep === 'idle' && !taskIdFromUrl} />

            {/* Status legend */}
            {nodes.length > 0 && (
              <div className="absolute bottom-3 left-3 z-10 hidden lg:flex flex-wrap items-center gap-x-3 gap-y-1 bg-background/85 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-border/50 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-purple-500" />Planner</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />Idle</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />Claimed</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />Validating</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />Done</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />Slashed</span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Terminal & Prompt */}
        <div
          className="w-full md:w-[380px] flex flex-col bg-background/50 backdrop-blur-sm shrink-0 border-t md:border-t-0 md:border-l border-border relative"
          style={isDesktop ? { width: panelWidth } : undefined}
        >
          {/* Drag handle — hidden on mobile (panel stacks full-width). */}
          <div
            onMouseDown={onResizeStart}
            role="separator"
            aria-orientation="vertical"
            className="hidden md:block absolute top-0 bottom-0 -left-0.5 w-1 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors z-20"
          />

          <LogsPanel logs={logs} onClear={() => setLogs([])} />

          {/* Pending-intent banner — shown when an ?intent= came from the landing
              CTA but the wallet isn't connected yet. Once the user connects, the
              auto-submit effect above kicks in. */}
          {intentParam && !walletAddress && !taskIdFromUrl && (
            <div className="px-4 py-2.5 border-t border-border bg-yellow-500/5 flex items-start gap-2 text-[11px]">
              <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse shrink-0" />
              <div className="min-w-0">
                <div className="font-bold text-yellow-600 dark:text-yellow-400 uppercase tracking-wider text-[10px] mb-0.5">Intent queued</div>
                <p className="text-muted-foreground leading-snug">
                  Connect your wallet to dispatch <span className="text-foreground italic">&ldquo;{intentParam.length > 60 ? intentParam.slice(0, 60) + '…' : intentParam}&rdquo;</span> to SPORE.
                </p>
              </div>
            </div>
          )}

          {/* Once a task is in flight (or one is loaded from ?taskId), the
              intent input is moot — we collapse it and show a compact dispatch
              indicator. The "New intent" reset below brings the textarea back. */}
          {(() => {
            const isDispatching =
              submitStep === 'preparing' ||
              submitStep === 'approving' ||
              submitStep === 'creating' ||
              submitStep === 'submitting';
            const hasActiveTask = !!taskIdFromUrl;
            const showLoader = isDispatching || hasActiveTask;

            if (!showLoader) {
              return (
                <>
                  {/* Suggested intents — fills textarea, user reviews + dispatches */}
                  <IntentSuggestions
                    onPick={(text) => {
                      setInputText(text);
                      requestAnimationFrame(() => {
                        const ta = textareaRef.current;
                        if (ta) { ta.focus(); ta.setSelectionRange(text.length, text.length); }
                      });
                    }}
                  />

                  {/* Prompt Area */}
                  <div className="p-4 border-t border-border bg-background">
                    <div className="relative group">
                      <textarea
                        ref={textareaRef}
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        placeholder="Enter SPORE intent (e.g. Research AI trends on X)..."
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
                      {submitStep === 'error' && (
                        <div className="absolute -top-2 left-3 bg-background px-2 text-[10px] font-bold uppercase tracking-wider text-red-500">
                          ⚠ Error — see logs
                        </div>
                      )}
                    </div>
                  </div>
                </>
              );
            }

            const dispatchLabel =
              submitStep === 'preparing' ? 'Preparing spec…'
              : submitStep === 'approving' ? 'Approving USDC…'
              : submitStep === 'creating' ? 'Creating task on-chain…'
              : submitStep === 'submitting' ? 'Broadcasting to SPORE…'
              : dag ? 'DAG live — awaiting subtasks'
              : 'Awaiting DAG from planner…';

            const handleNewIntent = () => {
              const params = new URLSearchParams(searchParams.toString());
              params.delete('taskId');
              params.delete('intent');
              const qs = params.toString();
              router.replace(qs ? `?${qs}` : '?');
              setSubmitStep('idle');
              setInputText('');
            };

            return (
              <div className="p-4 border-t border-border bg-background">
                <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3.5 flex items-center gap-3">
                  <div className="relative shrink-0">
                    <Loader2 className="w-5 h-5 text-primary animate-spin" />
                    <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-primary mb-0.5">
                      SPORE working
                    </div>
                    <div className="text-xs text-foreground/85 truncate">{dispatchLabel}</div>
                  </div>
                  {/* Only let the user reset once the on-chain dispatch is past;
                      mid-flight reset would orphan a signed-but-unbroadcast task. */}
                  {!isDispatching && (
                    <button
                      onClick={handleNewIntent}
                      className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground border border-border hover:border-foreground/40 rounded-md px-2 py-1 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      New intent
                    </button>
                  )}
                </div>
              </div>
            )
          })()}
            <PromptConfigRow
              model={model}
              budget={budget}
              colonyId={selectedColony}
              colonies={colonies}
              onModelChange={setModel}
              onBudgetChange={setBudget}
              onColonyChange={setSelectedColony}
            />
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

export default function ExplorerPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading SPORE Explorer...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
