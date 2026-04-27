import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { IStoragePort, INetworkPort } from '../../../shared/ports';
import { AgentManager } from './AgentRunner';
import { TaskSchema, AgentDeploySchema, AgentIdParamsSchema } from './schemas';
import { EventType } from '../../../shared/types';
import { generateNonce, SiweMessage } from 'siwe'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET ?? 'swarm-dev-secret'
const nonces = new Map<string, number>() // nonce → expiry

export interface ServerDeps {
  storage: IStoragePort;
  network: INetworkPort;
  manager: AgentManager;
}

export default async function createServer(deps: ServerDeps) {
  const fastify = Fastify({ 
    logger: true,
    ignoreTrailingSlash: true 
  });

  // Global request logger
  fastify.addHook('onRequest', async (request) => {
    console.log(`[BACKEND] Incoming request: ${request.method} ${request.url}`);
  });

  await fastify.register(cors, {
    origin: true 
  });

  await fastify.register(websocket);

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // GET /auth/nonce
  fastify.get('/auth/nonce', async () => {
    const nonce = generateNonce()
    nonces.set(nonce, Date.now() + 5 * 60 * 1000) // 5 dakika
    return { nonce }
  })

  // POST /auth/verify
  fastify.post('/auth/verify', async (request, reply) => {
    const { message, signature } = request.body as any

    try {
      const siwe = new SiweMessage(message)
      
      // Nonce kontrolü
      const expiry = nonces.get(siwe.nonce)
      if (!expiry || expiry < Date.now()) {
        return reply.status(401).send({ error: 'Invalid or expired nonce' })
      }

      const { data, error } = await siwe.verify({ signature })

      if (error || !data) {
        return reply.status(401).send({ error: 'Invalid signature' })
      }

      // Nonce kullanıldı, sil
      nonces.delete(siwe.nonce)

      // JWT oluştur
      const token = jwt.sign(
        { address: data.address, chainId: data.chainId },
        JWT_SECRET,
        { expiresIn: '24h' }
      )

      return { token, address: data.address }
    } catch (err) {
      console.error('[AUTH] Verify error:', err)
      return reply.status(401).send({ error: 'Auth failed' })
    }
  })

  // JWT doğrulama helper
  function verifyJWT(token: string): { address: string; chainId: number } | null {
    try {
      return jwt.verify(token, JWT_SECRET) as any
    } catch {
      return null
    }
  }

  /**
   * POST /task
   * API just broadcasts the task to the AXL mesh.
   * A "Runner Agent" in the pool will pick it up and plan it.
   */
  fastify.post('/task', async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const token = authHeader.slice(7)
    const user = verifyJWT(token)
    if (!user) {
      return reply.status(401).send({ error: 'Invalid token' })
    }

    const body = TaskSchema.parse(request.body);
    const specHash = await deps.storage.append(body);
    
    const event = {
      type: EventType.TASK_SUBMITTED,
      payload: { ...body, taskId: specHash, specHash, submittedBy: user.address },
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
      const handler = (event: any) => {
        const now = Date.now();
        const diff = Math.abs(now - (event.timestamp || 0));
        
        if (diff < 60000) { // 60 seconds tolerance
          console.log(`[WS] OK: Transmitting ${event.type} to dashboard (diff: ${diff}ms)`);
          send(event);
        } else {
          console.warn(`[WS] FILTERED: ${event.type} too old or clock drift (diff: ${diff}ms, eventTs: ${event.timestamp}, now: ${now})`);
        }
      };
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

