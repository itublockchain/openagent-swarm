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

  fastify.post('/task', async (request: any, reply: any) => {
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

  fastify.post('/agent/deploy', async (request: any, reply: any) => {
    const body = AgentDeploySchema.parse(request.body);
    const containerId = await deps.runner.deploy(body);
    return { containerId };
  });

  fastify.get('/agent/pool', async () => {
    const list = await deps.runner.list();
    return list;
  });

  fastify.delete('/agent/:id', async (request: any, reply: any) => {
    const { id } = AgentIdParamsSchema.parse(request.params);
    await deps.runner.stop(id);
    return { ok: true };
  });

  fastify.register(async (fastify: any) => {
    fastify.get('/ws', { websocket: true }, (connection: any, req: any) => {
      console.log('[WS] Client connected');
      const handler = (event: any) => {
        if (connection.readyState === 1) {
          connection.send(JSON.stringify(event));
        }
      };
      Object.values(EventType).forEach((type) => {
        deps.network.on(type as EventType, handler);
      });
      connection.socket.on('close', () => {
        console.log('[WS] Client disconnected');
      });
    });
  });

  return fastify;
}
