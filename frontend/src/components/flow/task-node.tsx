"use client";

import React, { memo } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { Clock, Play, ShieldAlert, CheckCircle2, AlertOctagon, BrainCircuit } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type NodeData = {
  label: string;
  agent?: string;
  status: 'pending' | 'claimed' | 'validating' | 'slashed' | 'completed' | 'planner' | 'keeper';
};

export type TaskNodeType = Node<NodeData, 'task'>;

const TaskNode = ({ data, isConnectable }: NodeProps<TaskNodeType>) => {
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
      statusStyles[data.status] || statusStyles.pending
    )}>
      <Handle type="target" position={Position.Top} isConnectable={isConnectable} className="opacity-0" />
      
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sm tracking-tight">{data.label}</span>
        {statusIcons[data.status]}
      </div>
      
      {data.agent && (
        <div className="text-[10px] font-mono opacity-80 mt-1 bg-background/50 px-2 py-1 rounded-md w-fit">
          Agent: {data.agent}
        </div>
      )}
      
      <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} className="opacity-0" />
    </div>
  );
};

export default memo(TaskNode);
