"use client";

import React, { memo } from 'react';
import { Handle, Position, NodeProps, Node, NodeToolbar } from '@xyflow/react';
import { Clock, Play, ShieldAlert, CheckCircle2, AlertOctagon, BrainCircuit, Gavel, UserMinus } from 'lucide-react';
import { cn, shortHash } from '@/lib/utils';
import { TranscriptStep } from '../../../../shared/types';
import { NodeDetailPanel } from './NodeDetailPanel';

export { cn };

export type NodeData = {
  label: string;
  agent?: string;
  status: 'pending' | 'claimed' | 'validating' | 'slashed' | 'completed' | 'planner' | 'keeper';
  /** Number of agents that self-selected out of this node (skill mismatch). */
  passCount?: number;
  /** Live jury tally while a CHALLENGE is open on this node.
   *  - voters: count of jurors that have revealed (final guilty/innocent)
   *  - committed: count of jurors that sealed a vote in commit phase but
   *    haven't revealed yet. pending = committed - voters. */
  jury?: { guilty: number; innocent: number; voters: number; committed: number };
  /** Reasoning + output payload, captured from SUBTASK_DONE. Drives the
   *  per-node detail panel that opens beside the node when it's clicked. */
  result?: string;
  toolsUsed?: string[];
  transcript?: TranscriptStep[];
  iterations?: number;
  stopReason?: 'final' | 'max_iter' | 'deadline' | 'parse_error' | 'no_chat';
  outputHash?: string;
  /** Slash overlay — set when SlashWatcher recorded a Slashed event for
   *  this node's claimant. Drives the inline "Slashed: <reason>" badge
   *  beneath the agent line so the user sees WHY the node went red
   *  instead of just the bare red border. */
  slash?: {
    reason: string;
    amount: string;
    agentId?: string | null;
  };
};

export type TaskNodeType = Node<NodeData, 'task'>;

const TaskNode = ({ data, isConnectable, selected }: NodeProps<TaskNodeType>) => {
  const statusStyles = {
    pending: 'border-neutral-500/50 bg-neutral-500/10 text-neutral-500 dark:text-neutral-400',
    claimed: 'border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.3)]',
    validating: 'border-yellow-500/50 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 shadow-[0_0_15px_rgba(234,179,8,0.3)]',
    slashed: 'border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.3)]',
    completed: 'border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400 shadow-[0_0_15px_rgba(34,197,94,0.3)]',
    planner: 'border-purple-500/50 bg-purple-500/10 text-purple-600 dark:text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.3)]',
    keeper: 'border-teal-500/50 bg-teal-500/10 text-teal-600 dark:text-teal-400 shadow-[0_0_15px_rgba(20,184,166,0.3)]',
  };

  const statusIcons = {
    pending: <Clock className="w-4 h-4" />,
    claimed: <Play className="w-4 h-4 animate-pulse" />,
    validating: <ShieldAlert className="w-4 h-4 animate-pulse" />,
    slashed: <AlertOctagon className="w-4 h-4" />,
    completed: <CheckCircle2 className="w-4 h-4" />,
    planner: <BrainCircuit className="w-4 h-4" />,
    keeper: <CheckCircle2 className="w-4 h-4" />,
  };

  return (
    <div className={cn(
      "px-4 py-3 rounded-xl border backdrop-blur-md min-w-[180px] flex flex-col gap-2 transition-all duration-300",
      statusStyles[data.status] || statusStyles.pending,
      selected && 'ring-2 ring-primary/50 ring-offset-2 ring-offset-background'
    )}>
      {/* NodeToolbar opens to the right of the node when selected. ReactFlow
          handles positioning + auto-close when another node is selected or
          the canvas is clicked. */}
      <NodeToolbar isVisible={selected} position={Position.Right} offset={16}>
        <NodeDetailPanel data={data} />
      </NodeToolbar>

      <Handle type="target" position={Position.Top} isConnectable={isConnectable} className="opacity-0" />
      
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sm tracking-tight">{data.label}</span>
        {statusIcons[data.status]}
      </div>
      
      {data.agent && (
        <div
          className="text-[10px] font-mono opacity-80 mt-1 bg-background/50 px-2 py-1 rounded-md max-w-[180px] truncate"
          title={data.agent}
        >
          Agent: {data.agent.length > 16 ? shortHash(data.agent, 6, 4) : data.agent}
        </div>
      )}

      {data.slash && (
        <div
          className="text-[10px] font-mono bg-red-500/15 text-red-600 dark:text-red-400 px-2 py-1 rounded-md border border-red-500/30 flex items-center gap-1.5 max-w-[200px]"
          title={`Slashed ${data.slash.amount} USDC — ${data.slash.reason}`}
        >
          <AlertOctagon className="w-3 h-3 shrink-0" />
          <span className="truncate">Slashed: {data.slash.reason}</span>
        </div>
      )}

      {(data.passCount ?? 0) > 0 && (
        <div
          className="text-[10px] font-mono opacity-90 bg-background/40 px-2 py-1 rounded-md w-fit flex items-center gap-1.5"
          title="Agents that self-selected out of this node (skill mismatch)"
        >
          <UserMinus className="w-3 h-3" />
          <span>{data.passCount} passed</span>
        </div>
      )}

      {data.jury && (data.jury.voters > 0 || data.jury.committed > 0) && (
        <div
          className="text-[10px] font-mono bg-background/40 px-2 py-1 rounded-md w-fit flex items-center gap-1.5 border border-current/20"
          title="Live LLM-Judge jury — committed (sealed) vs revealed votes"
        >
          <Gavel className="w-3 h-3" />
          {data.jury.voters > 0 ? (
            <>
              <span className="text-red-500">{data.jury.guilty}G</span>
              <span className="opacity-50">·</span>
              <span className="text-green-500">{data.jury.innocent}I</span>
            </>
          ) : null}
          {/* Pending = committed but not yet revealed. Surfaced as a
              quiet badge so the 20s commit window isn't an empty stare. */}
          {data.jury.committed - data.jury.voters > 0 && (
            <>
              {data.jury.voters > 0 && <span className="opacity-50">·</span>}
              <span className="text-yellow-500 animate-pulse">
                {data.jury.committed - data.jury.voters} pending
              </span>
            </>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} className="opacity-0" />
    </div>
  );
};

export default memo(TaskNode);
