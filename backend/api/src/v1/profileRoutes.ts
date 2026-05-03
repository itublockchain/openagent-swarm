import type { FastifyInstance } from 'fastify'
import type { TaskIndex } from './tasksIndex'
import type { TaskStateStore } from './taskStateStore'

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
  /** SQLite-backed mirror of per-task DAG snapshot + event log. Needed so
   *  DELETE /v1/me/tasks routes can cascade the cleanup beyond the
   *  user_tasks row — without it, stale dag_nodes / task_events would
   *  accumulate forever. */
  taskState: TaskStateStore
  /** Callback fired after a task row is deleted so server.ts can prune
   *  its in-memory caches (taskOwners, plannerByTask). Optional — if
   *  omitted the caches just go slightly stale until process restart. */
  onTaskDeleted?: (taskId: string) => void
}

/**
 * Mounts /v1/me/* — webapp profile / "my account" surface. SIWE-JWT
 * gated, owner-scoped against the connected wallet. SDK consumers don't
 * use these (they have their own /v1/tasks list flow with API key).
 */
export async function registerProfileRoutes(app: FastifyInstance, opts: RegisterOpts) {
  const { taskIndex, requireAuth, taskResults, taskState, onTaskDeleted } = opts

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

  // DELETE /v1/me/tasks/:id — owner-scoped single-row purge for the
  // profile-page trash icon. Removes the user_tasks row AND cascades into
  // the dag_nodes + events tables so the explorer's deep-link reload
  // returns 404 instead of resurrecting the task from a stale snapshot.
  // Owner check is implicit in TaskIndex.delete (WHERE owner = ?), so an
  // attacker who guesses a taskId can't delete someone else's task.
  app.delete<{ Params: { id: string } }>('/v1/me/tasks/:id', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = request.params
    const removed = taskIndex.delete(id, user.address)
    if (!removed) {
      // Same response whether the row never existed or belonged to another
      // wallet — don't leak existence via a different error code.
      reply.status(404).send({ error: 'Task not found' })
      return
    }
    taskState.deleteTask(id)
    onTaskDeleted?.(id)
    reply.send({ ok: true })
  })

  // DELETE /v1/me/tasks — "Clear all" sweep for the profile-page section
  // header. Pulls the owner's id list once and cascades into both stores
  // in lock-step. Returns the deleted count so the UI can show a toast.
  // No paging — typical user has at most a few hundred tasks; if that
  // ever changes we can switch to a streaming variant.
  app.delete('/v1/me/tasks', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const ids = taskIndex.deleteAllForOwner(user.address)
    for (const id of ids) {
      taskState.deleteTask(id)
      onTaskDeleted?.(id)
    }
    reply.send({ ok: true, count: ids.length })
  })
}
