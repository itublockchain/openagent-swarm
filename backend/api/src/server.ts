import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { IStoragePort, INetworkPort } from '../../../shared/ports';
import { AgentManager } from './AgentRunner';
import { TaskSchema, AgentDeploySchema, AgentIdParamsSchema } from './schemas';
import { EventType } from '../../../shared/types';

export interface ServerDeps {
  storage: IStoragePort;
  network: INetworkPort;
  manager: AgentManager;
}

export default async function createServer(deps: ServerDeps) {
  const fastify = Fastify({ logger: true });

  // In-memory results store: taskId → { nodes: [{nodeId, result}] }
  const taskResults = new Map<string, { nodes: Array<{ nodeId: string; result: string }> }>()

  // Listen to SUBTASK_DONE and store results in API memory
  deps.network.on(EventType.SUBTASK_DONE, (event: any) => {
    const { taskId, nodeId, result } = event.payload ?? {}
    if (!taskId || !nodeId || !result) return
    if (!taskResults.has(taskId)) taskResults.set(taskId, { nodes: [] })
    const entry = taskResults.get(taskId)!
    // avoid duplicates
    if (!entry.nodes.find(n => n.nodeId === nodeId)) {
      entry.nodes.push({ nodeId, result })
    }
  })

  await fastify.register(cors, {
    origin: true // Allow all origins for dev
  });

  await fastify.register(websocket);

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  /**
   * POST /task
   * API just broadcasts the task to the AXL mesh.
   * A "Runner Agent" in the pool will pick it up and plan it.
   */
  fastify.post('/task', async (request, reply) => {
    const body = TaskSchema.parse(request.body);
    const specHash = await deps.storage.append(body);
    
    const event = {
      type: EventType.TASK_SUBMITTED,
      payload: { ...body, taskId: specHash, specHash },
      timestamp: Date.now(),
      agentId: 'api-server'
    };

    await deps.network.emit(event);
    return { taskId: specHash };
  });

  // POST /agent/deploy
  fastify.post('/agent/deploy', async (request: any) => {
    const body = AgentDeploySchema.parse(request.body)
    const containerId = await deps.manager.deploy(body)
    return { containerId }
  });

  // GET /agent/pool
  fastify.get('/agent/pool', async () => {
    const list = await deps.manager.list();
    return list;
  });

  // GET /task/:taskId
  // Now fetches only from storage. Live state is reconstructed by frontend via WebSocket.
  fastify.get('/task/:taskId', async (request) => {
    const { taskId } = request.params as any;
    const task = await deps.storage.fetch(taskId);
    return { ...(task as any) };
  });

  /**
   * GET /result/:taskId
   * Returns the aggregated subtask results for a completed task.
   * Results are collected from SUBTASK_DONE events broadcast by agents.
   */
  fastify.get('/result/:taskId', async (request, reply) => {
    const { taskId } = request.params as any;
    const result = taskResults.get(taskId);
    if (!result) {
      reply.code(404)
      return { error: 'No results yet for task: ' + taskId }
    }
    // Combine all node results into a single string
    const combined = result.nodes
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(n => `=== ${n.nodeId} ===\n${n.result}`)
      .join('\n\n')
    return { taskId, nodes: result.nodes, combined }
  });

  // DELETE /agent/:id
  fastify.delete('/agent/:id', async (request, reply) => {
    const { id } = AgentIdParamsSchema.parse(request.params);
    await deps.manager.stop(id);
    return { ok: true };
  });

  // WebSocket handler for event streaming
  // This bridges AXL mesh events to the browser dashboard
  fastify.get('/ws', { websocket: true }, (connection: any, req) => {
    const socket = connection.socket || connection;
    console.log('[WS] Client connected to P2P Event Bus');

    const handlers: Map<string, (event: any) => void> = new Map();

    const send = (event: any) => {
      if (socket && (socket.readyState === 1 || socket.readyState === 'open')) {
        try {
          socket.send(JSON.stringify(event));
        } catch (err) {
          console.error('[WS] Send error:', err);
        }
      }
    };

    Object.values(EventType).forEach(type => {
      const handler = (event: any) => send(event);
      handlers.set(type, handler);
      deps.network.on(type as EventType, handler);
    });

    socket.on('close', () => {
      console.log('[WS] Client disconnected');
      handlers.forEach((handler, type) => {
        deps.network.off(type as EventType, handler);
      });
      handlers.clear();
    });
  });

  return fastify;
}

