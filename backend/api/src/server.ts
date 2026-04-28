import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { IStoragePort, INetworkPort } from '../../../shared/ports';
import { AgentManager } from './AgentRunner';
import { TaskSchema, AgentPrepareSchema, AgentDeploySchema, AgentIdParamsSchema } from './schemas';
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

  // Shared L2 helpers — read-only RPC client used for verification.
  const rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
  const escrowAddr = process.env.L2_ESCROW_ADDRESS || deployments.SwarmEscrow;
  const usdcAddr = process.env.L2_USDC_ADDRESS || deployments.MockUSDC;
  const readProvider = new ethers.JsonRpcProvider(rpcUrl);
  const readEscrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, readProvider);
  const readUsdc = new ethers.Contract(usdcAddr, MockERC20ABI.abi, readProvider);

  function deriveTaskId(specHash: string): string {
    return specHash.startsWith('0x') && specHash.length === 66
      ? specHash
      : ethers.keccak256(ethers.toUtf8Bytes(specHash));
  }

  /**
   * POST /task/prepare
   * First half of the user-signed task creation flow. Uploads the spec to
   * storage and returns everything the frontend needs to sign the on-chain
   * approve + createTask transactions itself. No on-chain side effects.
   */
  fastify.post('/task/prepare', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return

    const body = TaskSchema.parse(request.body);
    const specHash = await deps.storage.append(body);
    const taskIdBytes32 = deriveTaskId(specHash);

    let decimals: number
    try {
      decimals = Number(await readUsdc.decimals());
    } catch (err) {
      console.error('[L2] Failed to read USDC decimals:', err);
      return reply.status(502).send({ error: 'L2 RPC unreachable' });
    }
    const budgetWei = ethers.parseUnits(body.budget || '0.01', decimals).toString();

    return {
      specHash,
      taskIdBytes32,
      budgetWei,
      decimals,
      escrowAddress: escrowAddr,
      usdcAddress: usdcAddr,
    };
  });

  /**
   * POST /task
   * Second half of the flow: verifies the user has already created the task
   * on-chain (via their own wallet) and then broadcasts to the AXL mesh.
   * The legacy fallback path (API wallet creates the task itself) is gated
   * behind ALLOW_API_CREATE_TASK=true for backward compat / dev workflows.
   */
  fastify.post('/task', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return

    const body = TaskSchema.parse(request.body);
    const specHash = await deps.storage.append(body);
    const taskIdBytes32 = deriveTaskId(specHash);

    // Verify the on-chain task exists. The user's wallet (or, in dev, the API
    // wallet) must have called createTask with this exact taskIdBytes32.
    let taskOnChain: any
    try {
      taskOnChain = await readEscrow.tasks(taskIdBytes32);
    } catch (err) {
      console.error('[L2] tasks() lookup failed:', err);
      return reply.status(502).send({ error: 'L2 RPC unreachable' });
    }

    if (taskOnChain.owner === ethers.ZeroAddress) {
      if (process.env.ALLOW_API_CREATE_TASK === 'true') {
        // Legacy / dev path: fall back to API-funded createTask. Useful for
        // server-to-server testing without a connected wallet.
        const r = await apiFundedCreateTask(taskIdBytes32, body.budget || '0.01');
        if (!r.ok) return reply.status(500).send(r.payload);
      } else {
        return reply.status(402).send({
          error: 'Task not found on-chain. Frontend must call createTask first.',
          taskIdBytes32,
        });
      }
    }

    const event = {
      type: EventType.TASK_SUBMITTED,
      payload: { ...body, taskId: specHash, specHash, submittedBy: user.address },
      timestamp: Date.now(),
      agentId: 'api-server'
    };

    await deps.network.emit(event);
    return { taskId: specHash, taskIdBytes32 };
  });

  // Legacy helper preserved behind ALLOW_API_CREATE_TASK=true.
  async function apiFundedCreateTask(taskIdBytes32: string, budgetStr: string): Promise<{ ok: true } | { ok: false; payload: any }> {
    try {
      const privateKey = process.env.PRIVATE_KEY;
      if (!privateKey) return { ok: false, payload: { error: 'PRIVATE_KEY env var required for API-funded createTask' } };
      const signer = new ethers.Wallet(privateKey, readProvider);
      const escrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, signer);
      const usdc = new ethers.Contract(usdcAddr, MockERC20ABI.abi, signer);
      const decimals: number = Number(await usdc.decimals());
      const budget = ethers.parseUnits(budgetStr, decimals);

      const allowance: bigint = await usdc.allowance(signer.address, escrowAddr);
      if (allowance < budget) {
        const approveTx = await usdc.approve(escrowAddr, ethers.MaxUint256);
        await approveTx.wait();
      }
      const tx = await escrow.createTask(taskIdBytes32, budget);
      await tx.wait();
      console.log(`[L2] API-funded createTask ${taskIdBytes32} tx=${tx.hash}`);
      return { ok: true };
    } catch (err) {
      console.error('[L2] apiFundedCreateTask failed:', err);
      return { ok: false, payload: { error: 'createTask failed', details: (err as Error).message } };
    }
  }

  /**
   * POST /agent/prepare
   * Mints a fresh wallet for the agent, prefunds it with native gas, returns
   * the address. The frontend then asks the user to sign a USDC.transfer to
   * this address before calling /agent/deploy.
   */
  fastify.post('/agent/prepare', async (request: any, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const body = AgentPrepareSchema.parse(request.body)
    try {
      const result = await deps.manager.prepare({
        name: body.name,
        model: body.model,
        stakeAmount: body.stakeAmount,
        systemPrompt: body.systemPrompt,
        ownerAddress: user.address,
      })
      return result;
    } catch (err) {
      console.error('[API] /agent/prepare failed:', err)
      return reply.status(500).send({ error: (err as Error).message })
    }
  });

  // POST /agent/deploy — verifies USDC arrival, then spawns the container.
  fastify.post('/agent/deploy', async (request: any, reply) => {
    if (!requireAuth(request, reply)) return
    const body = AgentDeploySchema.parse(request.body)
    try {
      const record = await deps.manager.deploy(body.agentId)
      return { containerId: record.containerId, agentId: record.agentId, agentAddress: record.agentAddress }
    } catch (err) {
      const msg = (err as Error).message
      console.error('[API] /agent/deploy failed:', msg)
      // Stake-not-arrived case is a 402 (Payment Required) — UI should retry
      // after the transfer confirms.
      const status = msg.includes('Transfer USDC') ? 402 : 500
      return reply.status(status).send({ error: msg })
    }
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

