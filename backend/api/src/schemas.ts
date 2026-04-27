import { z } from 'zod';

export const TaskSchema = z.object({
  spec: z.string().min(1),
  budget: z.string().optional()
});

export const AgentDeploySchema = z.object({
  agentId: z.string().min(1),
  stakeAmount: z.string(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const AgentIdParamsSchema = z.object({
  id: z.string().min(1)
});
