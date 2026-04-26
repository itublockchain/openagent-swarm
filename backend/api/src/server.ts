import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { IStoragePort, INetworkPort } from '../../../shared/ports';
import { AgentRunner } from './AgentRunner';
import { TaskSchema, AgentDeploySchema, AgentIdParamsSchema } from './schemas';
import { EventType } from '../../../shared/types';

export interface ServerDeps {
  storage: IStoragePort;
  network: INetworkPort;
  runner: AgentRunner;
}

export default async function createServer(deps: ServerDeps) {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: true // Allow all origins for dev
  });

  await fastify.register(websocket);

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

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
  fastify.post('/agent/deploy', async (request: any) => {
    const body = AgentDeploySchema.parse(request.body)
    // body: { agentId, stakeAmount, model?, systemPrompt? }
    const containerId = await deps.runner.deploy(body)
    return { containerId }
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

  fastify.route({
    method: 'GET',
    url: '/ws',
    handler: (req, reply) => {
      reply.status(404).send({ error: 'Not a websocket request' });
    },
    wsHandler: (connection: any, req) => {
      const socket = connection.socket || connection;

      if (!socket || typeof socket.on !== 'function') return;

      const handler = (event: any) => {
        if (socket.readyState === 1 || socket.readyState === 'open') {
          try {
            socket.send(JSON.stringify(event));
          } catch (err) {
            console.error('[WS] Send error:', err);
          }
        }
      };

      // tüm event tiplerini dinle
      const types = Object.values(EventType);
      types.forEach(type => deps.network.on(type as EventType, handler));

      socket.on('close', () => {
        types.forEach(type => deps.network.off(type as EventType, handler));
      });
    }
  });

  return fastify;
}
