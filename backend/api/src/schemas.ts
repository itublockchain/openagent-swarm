import { z } from 'zod';

export const TaskSchema = z.object({
  spec: z.string().min(1),
  // Budget is the USDC the submitter is willing to pay out across the DAG
  // (planner gets 20%, workers split 80%). It must be set explicitly by the
  // task creator — silent fallbacks made it possible to dispatch tasks with
  // a budget so small that workers earned nothing after stake, masking the
  // failure mode as "task completed but no rewards".
  budget: z.string().refine(s => {
    const n = Number(s)
    return Number.isFinite(n) && n > 0
  }, 'budget must be a positive USDC amount'),
  // Client-supplied nonce so otherwise-identical specs produce distinct
  // taskIds. Required because storage hashes are content-addressed; without
  // it, resubmitting the same prompt collides with the previous task.
  nonce: z.union([z.string(), z.number()]).optional(),
  // Optional colony scope. When set, only agents that are members of this
  // colony will pick up the task; non-members ignore the AXL event in
  // SwarmAgent.onTaskSubmitted. Empty/undefined → public task, any agent
  // can claim. Membership is owner-curated via /v1/me/colonies.
  colonyId: z.string().min(1).optional(),
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

export const AgentWithdrawSchema = z.object({
  /** Decimal USDC string (e.g. "5.5"). Omit to drain the entire wallet. */
  amount: z.string().optional(),
});

export const AgentTopupSchema = z.object({
  /** Decimal USDC string the user just transferred to the agent address. */
  amount: z.string(),
});
