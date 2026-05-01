import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import Dockerode from 'dockerode';
import { IStoragePort, INetworkPort } from '../../../shared/ports';
import { AgentManager } from './AgentRunner';
import { CentralComputeProxy } from './CentralComputeProxy';
import { TaskSchema, AgentPrepareSchema, AgentDeploySchema, AgentIdParamsSchema, AgentWithdrawSchema, AgentTopupSchema } from './schemas';
import { ethers } from 'ethers';
import SwarmEscrowABI from '../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json';
import MockERC20ABI from '../../../contracts/artifacts/src/MockERC20.sol/MockERC20.json';
import DAGRegistryABI from '../../../contracts/artifacts/src/DAGRegistry.sol/DAGRegistry.json';
import deployments from '../../../contracts/deployments/og_testnet.json';
import { EventType } from '../../../shared/types';
import { generateNonce, SiweMessage } from 'siwe'
import jwt from 'jsonwebtoken'
import { KeyStore } from './v1/keystore'
import { TaskIndex } from './v1/tasksIndex'
import { TaskStateStore } from './v1/taskStateStore'
import { ColonyStore } from './v1/colonyStore'
import { registerColoniesRoutes } from './v1/coloniesRoutes'
import { registerKeysRoutes } from './v1/keysRoutes'
import { registerTasksRoutes } from './v1/tasksRoutes'
import { registerBalanceRoutes } from './v1/balanceRoutes'
import { registerAgentsRoutes } from './v1/agentsRoutes'
import { registerProfileRoutes } from './v1/profileRoutes'

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
  /**
   * Optional shared compute proxy. Mounted only when COMPUTE_MODE=central.
   * Agents in central mode hit /internal/compute/chat which forwards here.
   */
  computeProxy?: CentralComputeProxy;
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

  // SQLite-backed mirror of every per-task / per-node lifecycle event.
  // Replaces two ex-in-memory Maps (`taskResults` + `dagCache`) so a server
  // crash / redeploy doesn't lose:
  //   - per-node final answers + reasoning trace + tool list
  //   - DAG ordering and per-node status (idle/claimed/pending/done/failed)
  // KeyStore + TaskIndex open the same SQLite file later — WAL mode lets
  // all three connections coexist without locking.
  const dbPath = process.env.API_DB_PATH ?? '/data/api.db'
  const taskState = new TaskStateStore({ dbPath })

  // Per-task plannerAgentId — small enough to keep in-memory (handful of
  // bytes per active task, reset on restart is fine because the next
  // PLANNER_SELECTED rebuilds it).
  const plannerByTask = new Map<string, string | undefined>()

  // Read shim so legacy code paths that expect `{ nodes: [{nodeId, result}] }`
  // get a fresh slice from SQLite without holding a stale in-memory copy.
  const taskResultsView = (taskId: string) => {
    const nodes = taskState.listResults(taskId)
    return nodes.length > 0 ? { nodes } : null
  }

  deps.network.on(EventType.DAG_READY, (event: any) => {
    const { taskId, nodes, plannerAgentId } = event.payload ?? {}
    if (!taskId || !Array.isArray(nodes)) return
    taskState.seedDag(
      taskId,
      nodes.map((n: any) => ({ id: n.id, subtask: n.subtask })),
    )
    if (plannerAgentId) plannerByTask.set(taskId, plannerAgentId)
  })

  deps.network.on(EventType.SUBTASK_CLAIMED, (event: any) => {
    const { taskId, nodeId, agentId } = event.payload ?? {}
    if (taskId && nodeId) taskState.setStatus(taskId, nodeId, { status: 'claimed', agentId })
  })

  deps.network.on(EventType.SUBTASK_VALIDATED, (event: any) => {
    const { taskId, nodeId } = event.payload ?? {}
    if (taskId && nodeId) taskState.setStatus(taskId, nodeId, { status: 'done' })
  })

  deps.network.on(EventType.SUBTASK_PEER_VALIDATED, (event: any) => {
    const { taskId, nodeId } = event.payload ?? {}
    if (taskId && nodeId) taskState.setStatus(taskId, nodeId, { status: 'done' })
  })

  // Persist task completion to SQLite as soon as the planner-keeper emits
  // DAG_COMPLETED with settled=true. This is what makes profile/page
  // remember the "completed" status across API restarts — taskResults
  // (in-memory) is what derives status today, and a process restart
  // empties it, leaving every previously-completed task showing as
  // "pending" until SUBTASK_DONE events fire again (which they don't,
  // because the task is already over).
  deps.network.on(EventType.DAG_COMPLETED, (event: any) => {
    const { taskId, result, settled } = event.payload ?? {}
    if (!taskId || !settled) return
    try {
      taskIndex.markCompleted(taskId, undefined, result)
    } catch (err) {
      console.warn(`[server] markCompleted failed for ${taskId}:`, err)
    }
  })

  // Per-owner task index — same dbPath as taskState/KeyStore.
  const taskIndex = new TaskIndex({ dbPath })

  // SUBTASK_DONE → persist EVERYTHING the agent broadcast (final answer,
  // transcript, tool list, iteration counters). This is the row that
  // makes "agent logs uçar" no longer true — even if the API process
  // dies the next instant, every detail is on disk.
  deps.network.on(EventType.SUBTASK_DONE, (event: any) => {
    const p = event.payload ?? {}
    if (!p.taskId || !p.nodeId || !p.result) return
    try {
      taskState.recordResult({
        taskId: p.taskId,
        nodeId: p.nodeId,
        result: p.result,
        outputHash: p.outputHash,
        agentId: p.agentId,
        transcript: p.transcript,
        iterations: p.iterations,
        stopReason: p.stopReason,
        toolsUsed: p.toolsUsed,
      })
    } catch (err) {
      console.warn(`[server] taskState.recordResult failed for ${p.taskId}/${p.nodeId}:`, err)
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

  /**
   * POST /internal/compute/chat
   * Shared 0G Compute relay for agents running with COMPUTE_MODE=central.
   * Agent passes messages + maxTokens, proxy forwards to a pooled broker
   * wallet on the API host. NOT user-facing — only agents on the
   * swarm_default Docker network reach this; outside the network it's
   * unreachable.
   */
  if (deps.computeProxy) {
    fastify.post('/internal/compute/chat', async (request, reply) => {
      const body = (request.body ?? {}) as {
        messages?: Array<{ role: string; content: string }>
        maxTokens?: number
        temperature?: number
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.status(400).send({ error: 'messages[] required' })
      }
      try {
        const content = await deps.computeProxy!.chat(
          body.messages,
          body.maxTokens ?? 1024,
          typeof body.temperature === 'number' ? body.temperature : 0.3,
        )
        return { content }
      } catch (err: any) {
        console.error('[/internal/compute/chat] error:', err)
        return reply.status(502).send({ error: err?.message ?? String(err) })
      }
    });
  }

  /**
   * POST /internal/execute
   * Sandbox runtime for the CodeExecutor agent tool. Spawns an ephemeral
   * container with `NetworkMode: none` so even an LLM-generated exfiltration
   * attempt has nowhere to send data. 30s wall timeout. Output capped.
   *
   * NOT user-facing — only reachable from inside the swarm_default Docker
   * network (i.e. agent containers). The agent's own network does not have
   * docker-proxy access; that's why this endpoint exists rather than letting
   * the agent spawn containers directly.
   */
  const execDocker = process.env.DOCKER_HOST
    ? new Dockerode({
      host: process.env.DOCKER_HOST.replace('tcp://', '').split(':')[0],
      port: Number(process.env.DOCKER_HOST.split(':').pop()) || 2375,
    })
    : new Dockerode({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

  const EXEC_IMAGES: Record<'python' | 'javascript', string> = {
    python: 'python:3.11-alpine',
    javascript: 'node:22-alpine',
  };
  const EXEC_TIMEOUT_MS = 30_000;
  const EXEC_OUTPUT_LIMIT = 8_000; // chars

  // Pre-pull sandbox images at boot so the first execute_code call doesn't
  // 404 with "no such image". Non-blocking — server can serve other routes
  // while pulls run in the background. Most LLM-driven tasks reach
  // execute_code only after planning + claim + chain tx (~30s) which is
  // plenty of head-start for a ~10MB alpine pull.
  void (async () => {
    for (const ref of Object.values(EXEC_IMAGES)) {
      try {
        await execDocker.getImage(ref).inspect()
        console.log(`[Docker] sandbox image ready: ${ref}`)
      } catch {
        console.log(`[Docker] pulling sandbox image: ${ref}...`)
        try {
          await new Promise<void>((resolve, reject) => {
            execDocker.pull(ref, (err: any, stream: any) => {
              if (err) return reject(err)
              execDocker.modem.followProgress(stream, (e: any) => (e ? reject(e) : resolve()))
            })
          })
          console.log(`[Docker] sandbox image pulled: ${ref}`)
        } catch (err) {
          console.warn(`[Docker] failed to pull ${ref} (execute_code calls for that runtime will 404 until a manual pull):`, err)
        }
      }
    }
  })()

  // Concurrency caps for sandbox container spawns. Each running container
  // reserves 256 MiB; without these limits an LLM in a tight loop could
  // exhaust the host. Per-agent cap protects against a single misbehaving
  // agent; the global cap protects against a fleet collectively saturating
  // the daemon.
  const EXEC_MAX_PER_AGENT = 2;
  const EXEC_MAX_TOTAL = 8;
  const inflightExec = new Map<string, number>();
  let totalInflight = 0;

  fastify.post('/internal/execute', async (request, reply) => {
    const { code, language, agentId } = (request.body ?? {}) as {
      code?: string;
      language?: string;
      agentId?: string;
    };
    if (!code || (language !== 'python' && language !== 'javascript')) {
      return reply.status(400).send({ error: 'code + language (python|javascript) required' });
    }
    const aid = agentId?.trim() || 'unknown';

    if (totalInflight >= EXEC_MAX_TOTAL) {
      reply.header('Retry-After', '5');
      return reply.status(429).send({ error: `Sandbox saturated (${totalInflight}/${EXEC_MAX_TOTAL}), retry later` });
    }
    const cur = inflightExec.get(aid) ?? 0;
    if (cur >= EXEC_MAX_PER_AGENT) {
      reply.header('Retry-After', '5');
      return reply.status(429).send({ error: `Agent ${aid}: too many concurrent executions (${cur}/${EXEC_MAX_PER_AGENT})` });
    }
    inflightExec.set(aid, cur + 1);
    totalInflight++;

    const image = EXEC_IMAGES[language as 'python' | 'javascript'];
    const cmd =
      language === 'python'
        ? ['python', '-c', code as string]
        : ['node', '-e', code as string];

    let container: Dockerode.Container | null = null;
    let timedOut = false;
    try {
      container = await execDocker.createContainer({
        Image: image,
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {
          NetworkMode: 'none',
          AutoRemove: false,
          Memory: 256 * 1024 * 1024, // 256 MiB
          PidsLimit: 64,
        },
      });

      // Stream output before start so we don't miss the first bytes.
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      // Demux Docker's multiplexed stream manually (no Tty).
      execDocker.modem.demuxStream(
        stream,
        { write: (b: Buffer) => { stdoutChunks.push(Buffer.from(b)) } } as any,
        { write: (b: Buffer) => { stderrChunks.push(Buffer.from(b)) } } as any,
      );

      await container.start();

      const timer = setTimeout(() => {
        timedOut = true;
        container?.kill().catch(() => { });
      }, EXEC_TIMEOUT_MS);

      const wait = await container.wait();
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').slice(0, EXEC_OUTPUT_LIMIT);
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, EXEC_OUTPUT_LIMIT);

      return { stdout, stderr, exitCode: wait.StatusCode ?? -1, timedOut };
    } catch (err: any) {
      console.error('[/internal/execute] error:', err);
      return reply.status(500).send({ error: err?.message ?? String(err) });
    } finally {
      if (container) {
        try { await container.remove({ force: true }); } catch { }
      }
      const next = (inflightExec.get(aid) ?? 1) - 1;
      if (next <= 0) inflightExec.delete(aid);
      else inflightExec.set(aid, next);
      totalInflight = Math.max(0, totalInflight - 1);
    }
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
  const dagRegistryAddr = process.env.L2_DAG_REGISTRY_ADDRESS || deployments.DAGRegistry;
  const readDagRegistry = new ethers.Contract(dagRegistryAddr, DAGRegistryABI.abi, readProvider);

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
    // TaskSchema.refine already guarantees a positive numeric string here.
    const budgetWei = ethers.parseUnits(body.budget, decimals).toString();

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
        // server-to-server testing without a connected wallet. Schema has
        // already validated body.budget is a positive numeric string.
        const r = await apiFundedCreateTask(taskIdBytes32, body.budget);
        if (!r.ok) return reply.status(500).send(r.payload);
      } else {
        return reply.status(402).send({
          error: 'Task not found on-chain. Frontend must call createTask first.',
          taskIdBytes32,
        });
      }
    } else if (taskOnChain.owner.toLowerCase() !== user.address.toLowerCase()) {
      // Task exists on-chain but was created by someone other than the
      // authenticated caller. Without this check, anyone with a JWT could
      // re-broadcast another user's task to the AXL mesh by guessing
      // (or observing) their taskIdBytes32.
      return reply.status(403).send({
        error: 'Task owner mismatch — only the on-chain creator can broadcast it.',
        onChainOwner: taskOnChain.owner,
      });
    }

    // Colony scope authorization. If the task is tagged with a colonyId,
    // verify the caller is allowed to dispatch there:
    //   private  → only the colony owner can submit
    //   public   → anyone can submit
    //   missing  → 404, can't route to a non-existent colony
    if (body.colonyId) {
      const colony = colonyStore.get(body.colonyId)
      if (!colony || colony.archivedAt) {
        return reply.status(404).send({ error: 'Colony not found', colonyId: body.colonyId });
      }
      if (colony.visibility === 'private' && colony.owner !== user.address.toLowerCase()) {
        return reply.status(403).send({
          error: 'Colony is private — only its owner can submit tasks here',
          colonyId: body.colonyId,
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

    // Stamp the per-owner index so /v1/me/tasks can list this task on
    // the profile page. INSERT OR IGNORE — re-broadcasts of the same
    // content-addressed spec keep the original row.
    try {
      taskIndex.record({
        taskId: specHash,
        owner: user.address,
        spec: body.spec,
        budget: body.budget,
        source: 'web',
        model: (body as any).model ?? null,
        colonyId: body.colonyId ?? null,
      })
    } catch (err) {
      // Index failure must never block /task — log + continue.
      console.warn('[API] taskIndex.record failed (non-fatal):', err)
    }

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
    // Hydrate each agent with its colony memberships so the pool page can
    // cluster agents into colony sections without N+1 fetches. SQLite
    // listColoniesForAgent is a single indexed query per agent — fine for
    // demo-scale N. colonyStore is declared further down in createServer;
    // the closure resolves it lazily on request, by which time init ran.
    return list.map(a => ({
      ...a,
      colonies: colonyStore.listColoniesForAgent(a.agentId),
    }));
  });

  // GET /task/:taskId
  // Now fetches only from storage. Live state is reconstructed by frontend via WebSocket.
  fastify.get('/task/:taskId', async (request, reply) => {
    const { taskId } = request.params as any;
    let task: unknown = null
    try {
      task = await deps.storage.fetch(taskId);
    } catch (err) {
      // Storage miss is non-fatal — DB may still have a DAG snapshot for
      // a task whose spec we can't fetch (storage retried out).
      console.warn(`[GET /task/${taskId}] storage.fetch failed:`, err)
    }

    // Primary: SQLite-backed DAG snapshot. Survives API restarts.
    // Surface the full reasoning payload (result + transcript + counters)
    // so a deep-link reload repaints the explorer's per-node detail panel
    // without a separate fetch. JSON columns are parsed defensively —
    // bad rows fall back to undefined rather than 500-ing the whole task.
    const safeJsonParse = <T>(raw: string | null): T | undefined => {
      if (!raw) return undefined
      try { return JSON.parse(raw) as T } catch { return undefined }
    }
    let dagNodes = taskState.getDag(taskId).map(n => ({
      id: n.nodeId,
      subtask: n.subtask ?? '',
      status: n.status,
      agentId: n.agentId ?? undefined,
      outputHash: n.outputHash ?? undefined,
      result: n.result ?? undefined,
      transcript: safeJsonParse<unknown[]>(n.transcriptJson),
      toolsUsed: safeJsonParse<string[]>(n.toolsUsedJson),
      iterations: n.iterations ?? undefined,
      stopReason: n.stopReason ?? undefined,
    }))

    // Chain-fallback rebuild. If the DB has no rows (typical for tasks
    // whose live events fired before this DB existed) walk DAGRegistry,
    // then seed the rows so subsequent reads are cheap.
    if (dagNodes.length === 0) {
      try {
        const rebuilt = await rebuildDagFromChain(taskId)
        if (rebuilt && rebuilt.nodes.length > 0) {
          // Persist what we rebuilt so the next reader hits SQLite, not RPC.
          taskState.seedDag(
            taskId,
            rebuilt.nodes.map(n => ({ id: n.id, subtask: n.subtask })),
          )
          for (const n of rebuilt.nodes) {
            taskState.setStatus(taskId, n.id, {
              status: n.status,
              agentId: n.agentId,
              outputHash: n.outputHash,
            })
          }
          if (rebuilt.plannerAgentId) plannerByTask.set(taskId, rebuilt.plannerAgentId)
          // Chain rebuild can't recover the reasoning payload (transcript /
          // tools / counters live only in 0G Storage at outputHash); leave
          // those undefined so the primary-path shape still matches.
          dagNodes = rebuilt.nodes.map(n => ({
            id: n.id,
            subtask: n.subtask,
            status: n.status,
            agentId: n.agentId,
            outputHash: n.outputHash,
            result: undefined,
            transcript: undefined,
            toolsUsed: undefined,
            iterations: undefined,
            stopReason: undefined,
          }))
        }
      } catch (err) {
        console.warn(`[GET /task/${taskId}] chain rebuild failed:`, err)
      }
    }

    if (!task && dagNodes.length === 0) {
      reply.code(404)
      return { error: 'Task not found in storage or DB', taskId }
    }
    return {
      ...(task as any ?? {}),
      // useSwarmEvents.fetchState reads data.dag.nodes — keep the shape.
      dag: dagNodes.length > 0
        ? { nodes: dagNodes, plannerAgentId: plannerByTask.get(taskId) }
        : null,
    };
  });

  /**
   * Reconstruct a DAG from on-chain DAGRegistry state when the in-memory
   * cache has nothing — typical after an API restart for a task whose
   * DAG_READY / SUBTASK_DONE events fired in a previous process.
   *
   * Walks each registered node, derives its UI status from the chain
   * struct, and (for nodes with a recorded outputHash) fetches the stored
   * payload to recover the subtask description. Returns null when the
   * registry has no entry for this taskId.
   */
  // Local node shape used only inside the chain-rebuild path. Same fields
  // we feed into `taskState.setStatus` afterwards so the rebuild can
  // hydrate the DB row in one pass.
  type RebuiltDagNode = {
    id: string
    subtask: string
    status: 'idle' | 'claimed' | 'pending' | 'done' | 'failed'
    agentId?: string
    outputHash?: string
  }
  async function rebuildDagFromChain(
    taskId: string,
  ): Promise<{ nodes: RebuiltDagNode[]; plannerAgentId?: string } | null> {
    const taskIdBytes32 = deriveTaskId(taskId)
    let nodeIds: string[]
    try {
      nodeIds = await readDagRegistry.getTaskNodes(taskIdBytes32) as string[]
    } catch (err) {
      console.warn(`[rebuildDag] getTaskNodes failed for ${taskId}:`, err)
      return null
    }
    if (!nodeIds || nodeIds.length === 0) return null

    const ZERO_BYTES32 = '0x' + '0'.repeat(64)
    const ZERO_ADDR = '0x' + '0'.repeat(40)

    const built: RebuiltDagNode[] = await Promise.all(nodeIds.map(async (nid: string, idx: number) => {
      // Read the on-chain DAGNode struct. Tuple positions:
      //   0: nodeId  1: taskId  2: claimedBy  3: outputHash  4: validated
      let claimedBy: string = ''
      let outputHashRaw: string = ZERO_BYTES32
      let validated = false
      try {
        const onchain = await readDagRegistry.nodes(nid) as any
        claimedBy = (onchain.claimedBy ?? onchain[2] ?? '').toString()
        outputHashRaw = (onchain.outputHash ?? onchain[3] ?? ZERO_BYTES32).toString()
        validated = !!(onchain.validated ?? onchain[4])
      } catch (err) {
        console.warn(`[rebuildDag] nodes() failed for ${nid}:`, err)
      }

      const hasOutput = outputHashRaw !== ZERO_BYTES32
      const isClaimed = claimedBy !== '' && claimedBy.toLowerCase() !== ZERO_ADDR

      let status: RebuiltDagNode['status'] = 'idle'
      if (validated) status = 'done'
      else if (hasOutput) status = 'pending'
      else if (isClaimed) status = 'claimed'

      // Subtask text isn't on-chain; recover it by reading the worker's
      // stored output payload (which contains the original subtask string)
      // when one exists. Falls back to a placeholder for un-executed nodes.
      let subtask = `(node ${idx + 1})`
      if (hasOutput) {
        try {
          const payload = await deps.storage.fetch(outputHashRaw) as any
          if (payload && typeof payload.subtask === 'string') {
            subtask = payload.subtask
          }
        } catch {
          // storage miss — keep placeholder
        }
      }

      return {
        id: nid,
        subtask,
        status,
        agentId: isClaimed ? claimedBy : undefined,
        outputHash: hasOutput ? outputHashRaw : undefined,
      }
    }))

    return { nodes: built, plannerAgentId: undefined }
  }

  /**
   * GET /result/:taskId
   * Returns the aggregated subtask results for a completed task.
   * Results are collected from SUBTASK_DONE events broadcast by agents.
   */
  fastify.get('/result/:taskId', async (request, reply) => {
    const { taskId } = request.params as any;
    const result = taskResultsView(taskId);
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
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = AgentIdParamsSchema.parse(request.params);
    // Owner check — DELETE drains the wallet to the requester, so let only
    // the registered owner trigger it. Stale or external agentIds (no
    // matching secret) fall through to a best-effort container stop.
    const secret = deps.manager.getSecretMeta(id);
    if (secret?.ownerAddress &&
      secret.ownerAddress.toLowerCase() !== user.address.toLowerCase()) {
      return reply.status(403).send({ error: 'Only the owner can stop this agent' })
    }
    const result = await deps.manager.stop(id);
    return { ok: true, drained: result.drained ?? null };
  });

  /**
   * POST /agent/:id/withdraw
   * Owner pulls USDC from an agent's wallet without stopping it. Optional
   * { amount } body — omit to drain the full USDC balance. Native OG stays
   * with the agent so it can keep paying tx gas; use DELETE /agent/:id to
   * also reclaim OG.
   */
  fastify.post('/agent/:id/withdraw', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = AgentIdParamsSchema.parse(request.params);
    const body = AgentWithdrawSchema.parse(request.body ?? {});
    try {
      const result = await deps.manager.withdraw(id, user.address, body.amount);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.includes('Not authorized') ? 403
        : msg.includes('not found') ? 404
          : msg.includes('Invalid amount') || msg.includes('must be > 0') ? 400
            : 500;
      return reply.status(status).send({ error: msg });
    }
  });

  /**
   * POST /agent/:id/topup
   * Owner records a USDC deposit they just signed (USDC.transfer to
   * agentAddress). The transfer itself happens on the wallet side; this
   * endpoint just bumps the local stake floor so the surplus watchdog
   * doesn't immediately sweep the deposit back. Container is restarted
   * so the agent picks up the new floor.
   */
  fastify.post('/agent/:id/topup', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = AgentIdParamsSchema.parse(request.params);
    const body = AgentTopupSchema.parse(request.body ?? {});
    try {
      const result = await deps.manager.recordDeposit(id, user.address, body.amount);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.includes('Not authorized') ? 403
        : msg.includes('not found') ? 404
          : msg.includes('positive decimal') ? 400
            : 500;
      return reply.status(status).send({ error: msg });
    }
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

  // SDK surface — DB-backed key management + /v1/* endpoints. KeyStore
  // shares the SQLite file already opened above for taskIndex.
  const keyStore = new KeyStore({ dbPath })
  const sdkEnv: 'live' | 'test' = process.env.SDK_KEY_ENV === 'live' ? 'live' : 'test'

  // Webapp-driven (SIWE-JWT auth) — generate / list / revoke.
  await registerKeysRoutes(fastify, { keyStore, requireAuth, env: sdkEnv })

  // ColonyStore initialised early so /v1/tasks (SDK) can pass it in for
  // the privacy gate on colony-scoped task submissions. Same SQLite file
  // as KeyStore / TaskIndex.
  const colonyStore = new ColonyStore({ dbPath })

  // SDK-consumed (apiKeyAuth) — task submission, balance, agent pool.
  // Tasks/profile routes read results through `taskResultsAdapter` — same
  // `.get(taskId)` shape they used to consume, but every call hits the
  // SQLite-backed taskState instead of an in-memory map. A server crash
  // no longer drops result history; the adapter is a one-line shim.
  const taskResultsAdapter = {
    get(taskId: string) {
      return taskResultsView(taskId) ?? undefined
    },
  }

  await registerTasksRoutes(fastify, {
    keyStore,
    storage: deps.storage,
    network: deps.network,
    taskResults: taskResultsAdapter as any,
    taskIndex,
    colonyStore,
  })
  await registerBalanceRoutes(fastify, { keyStore })
  await registerAgentsRoutes(fastify, { keyStore, manager: deps.manager })

  // Webapp profile (SIWE-JWT) — owner-scoped task history + per-task result.
  await registerProfileRoutes(fastify, {
    taskIndex,
    requireAuth,
    taskResults: taskResultsAdapter as any,
  })

  // Colony surface — same SQLite file as KeyStore / TaskIndex. Two mounts:
  //   /v1/me/colonies — webapp (JWT). The resolver is a thin wrapper over
  //                     requireAuth that returns the resolved EOA, or null
  //                     if requireAuth already wrote a 401.
  //   /v1/colonies    — reserved for SDK (API-key auth). Mount it later by
  //                     calling registerColoniesRoutes again with an
  //                     apiKey-based resolveUser. The route file is
  //                     parameterised on prefix + resolver so the same
  //                     handlers serve both surfaces.
  await registerColoniesRoutes(fastify, {
    prefix: '/v1/me/colonies',
    store: colonyStore,
    manager: deps.manager,
    taskIndex,
    network: deps.network,
    resolveUser: async (req, reply) => {
      const user = requireAuth(req, reply)
      return user ? { address: user.address } : null
    },
  })

  // SDK mount — same handlers behind API-key auth. Inline resolver
  // mirrors apiKeyAuth's lookup so a missing/invalid key short-circuits
  // with the same JSON shape SDK consumers see on /v1/tasks/* errors.
  // Different prefix means the JWT and API-key surfaces never collide.
  await registerColoniesRoutes(fastify, {
    prefix: '/v1/colonies',
    store: colonyStore,
    manager: deps.manager,
    taskIndex,
    network: deps.network,
    resolveUser: async (req, reply) => {
      const header = req.headers.authorization
      if (!header || !header.startsWith('Bearer ')) {
        reply.status(401).send({ error: 'Missing API key', code: 'MISSING_KEY' })
        return null
      }
      const ctx = keyStore.lookup(header.slice(7).trim())
      if (!ctx) {
        reply.status(401).send({ error: 'Invalid or revoked API key', code: 'INVALID_KEY' })
        return null
      }
      return { address: ctx.userAddress }
    },
  })

  // Internal: agent self-reads its colony memberships every 30s. No auth —
  // only swarm_default Docker network can hit /internal/* endpoints. The
  // agentId path param is what the agent passes (it knows its own ID via
  // env); we just read SQLite by that key.
  fastify.get<{ Params: { agentId: string } }>('/internal/agents/:agentId/colonies', async (request) => {
    const { agentId } = request.params
    const colonyIds = colonyStore.listColoniesForAgent(agentId)
    return { colony_ids: colonyIds }
  })

  // Public colony discovery — no auth. Anyone (logged-in or not) can browse
  // public colonies for the explorer dropdown / pool grouping. Task
  // submission to a colony still requires auth + the visibility check
  // inside the /task and /v1/tasks handlers.
  fastify.get('/v1/colonies/public', async () => {
    const colonies = colonyStore.listPublic()
    return {
      colonies: colonies.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        owner: c.owner,
        created_at: c.createdAt,
        member_count: colonyStore.getMembers(c.id).length,
      })),
    }
  })

  console.log(`[API] SDK routes mounted (env=${sdkEnv})`)

  return fastify;
}

