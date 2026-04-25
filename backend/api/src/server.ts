import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { IStoragePort } from '../../../shared/ports';
import { EventBus } from '../../agent/src/core/EventBus';
import { AgentRunner } from './AgentRunner';
import { TaskSchema, AgentDeploySchema, AgentIdParamsSchema } from './schemas';
import { EventType } from '../../../shared/types';

export interface ServerDeps {
  storage: IStoragePort;
  network: EventBus;
  runner: AgentRunner;
}

export default async function createServer(deps: ServerDeps) {
  const fastify = Fastify({ logger: true });

  await fastify.register(websocket);

  // POST /task
  fastify.post('/task', async (request, reply) => {
    const body = TaskSchema.parse(request.body);
    const specHash = await deps.storage.append(body);
    
    await deps.network.emit({
      type: EventType.TASK_SUBMITTED,
      payload: { ...body, taskId: specHash, specHash },
      timestamp: Date.now(),
      agentId: 'api-server'
    });

    return { taskId: specHash };
  });

  // POST /agent/deploy
  fastify.post('/agent/deploy', async (request, reply) => {
    const body = AgentDeploySchema.parse(request.body);
    const containerId = await deps.runner.deploy(body);
    return { containerId };
  });

  // GET /agent/pool
  fastify.get('/agent/pool', async () => {
    const list = await deps.runner.list();
    return list;
  });

  // DELETE /agent/:id
  fastify.delete('/agent/:id', async (request, reply) => {
    const { id } = AgentIdParamsSchema.parse(request.params);
    await deps.runner.stop(id);
    return { ok: true };
  });

  // WS /ws
  fastify.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (connection, req) => {
      console.log('[WS] Client connected');
      
      const handler = (event: any) => {
        connection.socket.send(JSON.stringify(event));
      };

      deps.network.on('*', handler);

      connection.socket.on('close', () => {
        console.log('[WS] Client disconnected');
        // Note: EventBus needs a way to remove a specific listener
        // For simplicity in this mock, we might need an off(type, handler) method
        // But the prompt said off(type) which clears all. 
        // We'll leave it as is for now or use a more refined off if we had it.
      });
    });
  });

  return fastify;
}
