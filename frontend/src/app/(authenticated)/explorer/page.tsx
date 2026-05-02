"use client";

import React, { useState, useEffect, Suspense, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAccount } from 'wagmi';
import TaskNode, { NodeData } from '@/components/flow/task-node';
import { CanvasEmptyState } from '@/components/flow/CanvasEmptyState';
import { IntentSuggestions } from '@/components/flow/IntentSuggestions';
import { LogsPanel } from '@/components/flow/LogsPanel';
import { entryFromEvent, makeEntry, type LogEntry } from '@/components/flow/logEntry';
import { PromptConfigRow, type ModelId } from '@/components/flow/PromptConfigRow';
import { Send, Loader2, Plus } from 'lucide-react';
import { CopyableId } from '@/components/ui/copyable-id';
import { useSporeEvents, SubtaskStatus } from '@/hooks/useSporeEvents';
import { DeployAgentModal } from '@/components/DeployAgentModal';
import { Header } from '@/components/Header';
import { apiRequest, openDepositModal } from '../../../../lib/api';
import { ENV } from '../../../../lib/env';
import { cn } from '@/lib/utils';

const nodeTypes = {
  task: TaskNode,
};

type SubmitStep = 'idle' | 'submitting' | 'done' | 'error';

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
  const [logs, setLogs] = useState<LogEntry[]>(() => [
    makeEntry('system', 'Waiting for user intent…'),
    makeEntry('system', 'Ready to generate and deploy DAG.'),
  ]);
  // Stable across renders — `entryFromEvent` mutates this set in place to
  // remember which dedup ids we've already shown so re-broadcasts of the
  // same logical event (e.g. PLANNER_SELECTED fan-out across the swarm)
  // don't repeatedly stamp the panel with near-identical rows.
  const seenLogIdsRef = useRef<Set<string>>(new Set());

  const { dag, events, taskIdFromUrl, accessDenied } = useSporeEvents();

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
      { key: 'spec', label: 'Spec', state: stepOf(!!dag || !!taskIdFromUrl, !!taskIdFromUrl && !dag) },
      { key: 'plan', label: 'Plan', state: stepOf(!!dag, !taskIdFromUrl ? false : !dag) },
      { key: 'claim', label: 'Claim', state: stepOf(hasValidate || allDone, !!dag && !hasValidate && hasClaim) },
      { key: 'validate', label: 'Validate', state: stepOf(allDone, hasValidate && !allDone) },
      { key: 'settle', label: 'Settle', state: stepOf(false, allDone) },
    ];
  })();
  const { address: walletAddress } = useAccount();

  // Live Treasury balance — drives the budget input's max so the user can
  // never type a value the backend would reject with 402. Refreshes on
  // the same cadence as the header pill (12s) so deposits land in the cap
  // a tick after BridgeWatcher mirrors them. Null until the first /v1/me
  // /balance read returns; PromptConfigRow falls back to its default 1000
  // cap until then so the field isn't pinned to 1 during initial load.
  const [treasuryBalance, setTreasuryBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!walletAddress) {
      setTreasuryBalance(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const res = await apiRequest('/v1/me/balance')
        if (!res.ok) return
        const data = (await res.json()) as { balance: string }
        const n = Number(data.balance)
        if (!cancelled && Number.isFinite(n)) setTreasuryBalance(n)
      } catch {
        // Transient — keep last known value.
      }
    }
    load()
    const t = setInterval(load, 12_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [walletAddress])

  // Clamp budget to current balance whenever balance changes (e.g. after
  // a withdrawal). Without this, a stale 50-USDC budget would persist
  // after the wallet's Treasury drops to 10, and submit would 402.
  useEffect(() => {
    if (treasuryBalance == null) return
    const cap = Math.max(1, Math.floor(treasuryBalance))
    setBudget(b => Math.min(b, cap))
  }, [treasuryBalance])

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
      { id: '2', type: 'task', position: { x: 400, y: 150 }, data: { label: 'Planner: Decompose Intent', status: 'planner', agent: dag.plannerId || 'Awaiting...' } },
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
          // Reasoning payload from SUBTASK_DONE — the hook captures these
          // onto the box, but they only reach NodeDetailPanel if we forward
          // them onto the flow node's data here.
          result: box.result,
          toolsUsed: box.toolsUsed,
          transcript: box.transcript,
          iterations: box.iterations,
          stopReason: box.stopReason,
          outputHash: box.outputHash,
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

  // Backend-relayed task submission. The browser only proves SIWE
  // identity; the API operator signs `Treasury.spendOnBehalfOf` on 0G
  // and broadcasts to AXL. No wallet popup, no on-chain user txs.
  const submitRealDAG = async (intent: string) => {
    if (!walletAddress) {
      setLogs(prev => [...prev, makeEntry('error', 'No wallet connected. Connect first.')]);
      return;
    }

    const budgetStr = String(budget);
    const submissionNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSubmitStep('submitting');
    setLogs(prev => [...prev, makeEntry('user', `Submitting spec: ${intent} (budget=${budgetStr} USDC)`)]);

    try {
      const submitRes = await apiRequest('/task', {
        method: 'POST',
        body: JSON.stringify({
          spec: intent,
          budget: budgetStr,
          nonce: submissionNonce,
          colonyId: selectedColony ?? undefined,
        }),
      });
      if (!submitRes.ok) {
        const detail = await submitRes.json().catch(() => ({}));
        if (submitRes.status === 402 && detail.code === 'INSUFFICIENT_BALANCE') {
          openDepositModal();
          throw new Error(`Insufficient Treasury balance (need ${detail.required} USDC, have ${detail.balance}) — opening deposit.`);
        }
        throw new Error(`submit failed: ${detail.error ?? submitRes.status}`);
      }
      const data = await submitRes.json();
      setLogs(prev => [...prev, makeEntry('api', `Treasury debited ${budgetStr} USDC · tx ${(data.treasuryTxHash ?? '').slice(0, 12)}`)]);

      const params = new URLSearchParams(searchParams.toString());
      params.set('taskId', data.taskId);
      params.delete('intent');
      router.replace(`?${params.toString()}`);

      setSubmitStep('done');
      setLogs(prev => [...prev, makeEntry('api', `Task ${data.taskId.slice(0, 8)}… broadcast to AXL. Awaiting DAG…`)]);
    } catch (err: any) {
      setSubmitStep('error');
      const msg = err?.shortMessage || err?.message || String(err);
      setLogs(prev => [...prev, makeEntry('error', `(step=${submitStep}) ${msg}`)]);
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

  // Sync logs from events. Processes the entire events array to ensure
  // historical events (from a page refresh) are all captured, while
  // `seenLogIdsRef` ensures we don't duplicate lines during live updates.
  useEffect(() => {
    if (events.length === 0) return;

    const newEntries: LogEntry[] = [];
    // Process from oldest to newest so the terminal chronological order is preserved
    [...events].reverse().forEach(ev => {
      const { entry } = entryFromEvent(ev, seenLogIdsRef.current);
      if (entry) newEntries.push(entry);
    });

    if (newEntries.length > 0) {
      setLogs(prev => [...prev, ...newEntries].slice(-100));
    }
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
            <CanvasEmptyState visible={nodes.length === 0 && submitStep === 'idle' && !taskIdFromUrl && !accessDenied} />

            {/* Unauthorized deep-link state — shown when the connected wallet
                isn't the task owner (or no wallet is connected). The backend
                refuses both REST and WS reads for this case; the UI surfaces
                that as an explicit "private task" message instead of an
                indefinite empty canvas. */}
            {accessDenied && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                <div className="max-w-md text-center px-6">
                  <div className="text-xs font-mono uppercase tracking-widest text-red-500 mb-2">403 — Private task</div>
                  <h2 className="text-lg font-bold mb-2">This task is owner-restricted</h2>
                  <p className="text-sm text-muted-foreground mb-4">
                    Only the wallet that submitted this task can view its DAG and results. Connect the owner wallet, or dispatch your own intent to start a new task.
                  </p>
                  <button
                    onClick={() => router.replace('/explorer')}
                    className="px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-border rounded-md hover:bg-muted transition-colors"
                  >
                    Back to explorer
                  </button>
                </div>
              </div>
            )}

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

          <LogsPanel
            entries={logs}
            onClear={() => {
              setLogs([]);
              seenLogIdsRef.current.clear();
            }}
          />

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
              indicator. Once every subtask reaches `done` (or finalResult is
              broadcast), we drop back to the input so the user can dispatch a
              follow-up intent without first clicking "New intent". */}
          {(() => {
            const isDispatching = submitStep === 'submitting';
            const hasActiveTask = !!taskIdFromUrl;
            const taskComplete =
              !!dag?.finalResult ||
              (!!dag && dag.boxes.length > 0 && dag.boxes.every(b => b.status === 'done'));
            const showLoader = (isDispatching || hasActiveTask) && !taskComplete;

            if (!showLoader) {
              return (
                <>
                  {/* Completion banner — shown after the active task's DAG
                      reaches done. Distinguishes "fresh idle" from "previous
                      task finished, you can dispatch a follow-up". */}
                  {taskComplete && hasActiveTask && (
                    <div className="px-4 py-2 border-t border-border bg-green-500/5 flex items-center gap-2 text-[11px]">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      <span className="text-green-700 dark:text-green-400 font-bold uppercase tracking-wider text-[10px]">
                        Task completed
                      </span>
                      <span className="text-muted-foreground">— dispatch a new intent below</span>
                    </div>
                  )}

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

                  {/* Prompt Area — config row sits above the textarea so the
                      user sees their budget cap (= live Treasury balance)
                      before composing the intent, not after sending. */}
                  <div className="p-4 border-t border-border bg-background space-y-3">
                    <PromptConfigRow
                      model={model}
                      budget={budget}
                      colonyId={selectedColony}
                      colonies={colonies}
                      onModelChange={setModel}
                      onBudgetChange={setBudget}
                      onColonyChange={setSelectedColony}
                      hideModel
                      maxBudget={treasuryBalance ?? undefined}
                    />
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
                    </div>
                  </div>
                </>
              );
            }

            const dispatchLabel =
              submitStep === 'submitting' ? 'Broadcasting to SPORE…'
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
        </div>
      </div>

      <DeployAgentModal
        isOpen={isDeployOpen}
        onClose={() => setIsDeployOpen(false)}
        onSuccess={() => { }}
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
