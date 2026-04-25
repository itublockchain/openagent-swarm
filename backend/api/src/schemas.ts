import { z } from 'zod';

export const TaskSchema = z.object({
  spec: z.string().min(1),
  budget: z.string()
});

export const AgentDeploySchema = z.object({
  agentId: z.string().min(1),
  stakeAmount: z.string().min(1)
});

export const AgentIdParamsSchema = z.object({
  id: z.string().min(1)
});
