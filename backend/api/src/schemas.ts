import { z } from 'zod';

export const TaskSchema = z.object({
  spec: z.string().min(1),
  budget: z.string().optional(),
  // Client-supplied nonce so otherwise-identical specs produce distinct
  // taskIds. Required because storage hashes are content-addressed; without
  // it, resubmitting the same prompt collides with the previous task.
  nonce: z.union([z.string(), z.number()]).optional(),
});

export const AgentPrepareSchema = z.object({
  name: z.string().min(1).max(40),
  stakeAmount: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const AgentDeploySchema = z.object({
  agentId: z.string().min(1),
});

export const AgentIdParamsSchema = z.object({
  id: z.string().min(1)
});
