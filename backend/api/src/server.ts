import Fastify from 'fastify';
import websocket from '@fastify/websocket';
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

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

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

  fastify.post('/agent/deploy', async (request, reply) => {
    const body = AgentDeploySchema.parse(request.body);
    const containerId = await deps.runner.deploy(body);
    return { containerId };
  });

  fastify.get('/agent/pool', async () => {
    const list = await deps.runner.list();
    return list;
  });

  fastify.delete('/agent/:id', async (request, reply) => {
    const { id } = AgentIdParamsSchema.parse(request.params);
    await deps.runner.stop(id);
    return { ok: true };
  });

  fastify.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (connection, req) => {
      console.log('[WS] Client connected');
      const handler = (event: any) => {
        connection.socket.send(JSON.stringify(event));
      };
      deps.network.on('*', handler);
      connection.socket.on('close', () => {
        console.log('[WS] Client disconnected');
      });
    });
  });

  return fastify;
}
