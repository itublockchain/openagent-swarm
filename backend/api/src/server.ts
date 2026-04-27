import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { IStoragePort, INetworkPort } from '../../../shared/ports';
import { AgentManager } from './AgentRunner';
import { TaskSchema, AgentDeploySchema, AgentIdParamsSchema } from './schemas';
import { ethers } from 'ethers';
import SwarmEscrowABI from '../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json';
import MockERC20ABI from '../../../contracts/artifacts/src/MockERC20.sol/MockERC20.json';
import deployments from '../../../contracts/deployments/og_testnet.json';
import { EventType } from '../../../shared/types';
import { generateNonce, SiweMessage } from 'siwe'
import jwt from 'jsonwebtoken'

const DEFAULT_JWT_SECRET = 'swarm-dev-secret'
const JWT_SECRET = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET)) {
  throw new Error('[API] JWT_SECRET must be set to a non-default value in production')
}
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

  // JWT helpers — declared early so all routes can use them
  function verifyJWT(token: string): { address: string; chainId: number } | null {
    try {
      return jwt.verify(token, JWT_SECRET) as any
    } catch {
      return null
    }
  }
  function requireAuth(request: any, reply: any): { address: string; chainId: number } | null {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Unauthorized' })
      return null
    }
    const user = verifyJWT(authHeader.slice(7))
    if (!user) {
      reply.status(401).send({ error: 'Invalid token' })
      return null
    }
    return user
  }

  // CORS allow-list — accept comma-separated origins via env in production
  const corsEnv = process.env.CORS_ORIGINS?.trim()
  const corsOrigins: string[] | true = corsEnv
    ? corsEnv.split(',').map(s => s.trim()).filter(Boolean)
    : true
  if (process.env.NODE_ENV === 'production' && corsOrigins === true) {
    throw new Error('[API] CORS_ORIGINS must be set to an explicit allow-list in production')
  }
  await fastify.register(cors, {
    origin: corsOrigins,
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

  /**
   * POST /task
   * API just broadcasts the task to the AXL mesh.
   * A "Runner Agent" in the pool will pick it up and plan it.
   */
  fastify.post('/task', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return

    const body = TaskSchema.parse(request.body);
    const specHash = await deps.storage.append(body);

    // On-chain: Create task in SwarmEscrow.
    // Without this, the agent's stake() call later reverts with "Task does not
    // exist". Flow: read decimals → ensure allowance → createTask.
    try {
      const rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
      const privateKey = process.env.PRIVATE_KEY;
      if (!privateKey) {
        return reply.status(500).send({
          error: 'PRIVATE_KEY env var is required for on-chain task creation',
        });
      }

      const escrowAddr = process.env.L2_ESCROW_ADDRESS || deployments.SwarmEscrow;
      const usdcAddr = process.env.L2_USDC_ADDRESS || deployments.MockUSDC;

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const signer = new ethers.Wallet(privateKey, provider);
      const escrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, signer);
      const usdc = new ethers.Contract(usdcAddr, MockERC20ABI.abi, signer);

      // Read decimals at runtime — supports both 18-decimal MockERC20 and
      // 6-decimal real USDC without code changes.
      const decimals: number = Number(await usdc.decimals());
      const budget = ethers.parseUnits(body.budget || '0.01', decimals);
      const taskIdBytes32 = specHash.startsWith('0x')
        ? specHash
        : ethers.keccak256(ethers.toUtf8Bytes(specHash));

      // Approve escrow to pull USDC. Use MaxUint256 once and re-use across
      // tasks to avoid an approval tx per submission.
      const allowance: bigint = await usdc.allowance(signer.address, escrowAddr);
      if (allowance < budget) {
        console.log(`[L2] Approving USDC for escrow (current allowance ${allowance})...`);
        const approveTx = await usdc.approve(escrowAddr, ethers.MaxUint256);
        await approveTx.wait();
      }

      console.log(`[L2] Creating task ${taskIdBytes32} on-chain with budget ${body.budget}...`);
      const tx = await escrow.createTask(taskIdBytes32, budget);
      await tx.wait();
      console.log(`[L2] Task created on-chain. TX: ${tx.hash}`);
    } catch (err) {
      console.error('[L2] Failed to create task on-chain:', err);
      return reply.status(500).send({
        error: 'Failed to create task on-chain',
        details: (err as Error).message,
      });
    }
    
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
  fastify.post('/agent/deploy', async (request: any, reply) => {
    if (!requireAuth(request, reply)) return
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
    if (!requireAuth(request, reply)) return
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

