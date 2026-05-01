import type { FastifyInstance } from 'fastify'
import type { TaskIndex } from './tasksIndex'

interface RegisterOpts {
  taskIndex: TaskIndex
  /**
   * Webapp uses SIWE-JWT auth (NOT API key) — passed in from server.ts so
   * we don't pull jsonwebtoken into v1/* and create import cycles.
   */
  requireAuth: (req: any, reply: any) => { address: string; chainId: number } | null
  /** Shared in-memory task → results map. Status / completed flag is
   *  derived from this; absence = pending. */
  taskResults: Map<string, { nodes: Array<{ nodeId: string; result: string }> }>
}

/**
 * Mounts /v1/me/* — webapp profile / "my account" surface. SIWE-JWT
 * gated, owner-scoped against the connected wallet. SDK consumers don't
 * use these (they have their own /v1/tasks list flow with API key).
 */
export async function registerProfileRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const { taskIndex, requireAuth, taskResults } = opts

  // GET /v1/me/tasks — list tasks the connected wallet has submitted,
  // newest first. Status is derived at read time from taskResults so the
  // index never lies.
  app.get('/v1/me/tasks', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const rows = taskIndex.listForOwner(user.address)
    const tasks = rows.map(r => {
      const result = taskResults.get(r.taskId)
      // Completion is sticky once the SQLite column is set — survives API
      // restarts even after taskResults (in-memory) is cleared. Fall back
      // to in-memory presence for the brief window between DAG_COMPLETED
      // and the markCompleted write landing.
      const isCompleted = !!r.completedAt || !!result
      return {
        task_id: r.taskId,
        spec: r.spec,
        budget: r.budget,
        source: r.source,
        model: r.model,
        submitted_at: r.submittedAt,
        completed_at: r.completedAt,
        status: isCompleted ? 'completed' : 'pending',
        node_count: result?.nodes.length ?? 0,
      }
    })
    reply.send({ tasks })
  })

  // GET /v1/me/tasks/:id/result — full result for a single task the
  // connected wallet owns. Same shape as /v1/tasks/:id/result but
  // SIWE-JWT scoped (no API key required).
  app.get<{ Params: { id: string } }>('/v1/me/tasks/:id/result', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = request.params

    // Defense: only return results for tasks this user actually submitted.
    // Without this, anyone with a JWT could pull the result of a task
    // they don't own by guessing the taskId.
    const ownerRow = taskIndex
      .listForOwner(user.address, 200)
      .find(r => r.taskId === id)
    if (!ownerRow) {
      reply.status(404).send({ error: 'Task not found in your history' })
      return
    }
    const result = taskResults.get(id)
    if (!result) {
      reply.status(404).send({ error: 'No result yet', code: 'NOT_READY', task_id: id })
      return
    }
    const sorted = [...result.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    const combined = sorted.map(n => `=== ${n.nodeId} ===\n${n.result}`).join('\n\n')
    reply.send({
      task_id: id,
      result: combined,
      node_results: sorted.map(n => ({ node_id: n.nodeId, result: n.result })),
    })
  })
}
