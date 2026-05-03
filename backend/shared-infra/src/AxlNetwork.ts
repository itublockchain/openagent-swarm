import { INetworkPort } from '@swarm/shared';
import { AXLEvent, EventType } from '@swarm/shared';
import { createHash } from 'node:crypto';

// Lifetime of an event before pollMessages drops it. 5s was way too tight
// (0G testnet RPC can lag ~30s), and we now align with the API's WebSocket
// bridge tolerance (60s) so the two layers don't disagree about whether
// an event is "stale". Replay risk is still bounded by seenEvents.
const EVENT_TTL_MS = 60_000;

// Lifetime of a knownNodes entry. Old assumption: 5 min TTL is "well above
// any healthy event cadence". Reality: an idle swarm (no submissions for a
// few minutes) prunes every peer to zero, then the next broadcast goes
// "0 delivered, 1 skipped of 1" — no agent receives the task. 30 min is
// long enough to survive idle stretches between user submits while
// `sendToPeer` still evicts genuinely-dead pubkeys after 3 failed sends,
// so we don't accumulate junk indefinitely across container restarts.
const KNOWN_NODE_TTL_MS = 30 * 60_000;

// Topology cache TTL. Yggdrasil's spanning tree converges over seconds, not
// per request — caching for 5s cuts ~10x bridge HTTP load on busy bursts
// without any meaningful staleness in the broadcast view.
const TOPOLOGY_CACHE_TTL_MS = 5_000;

// Background warm-up cadence. Refreshes the topology cache + prunes stale
// knownNodes so emit() doesn't pay the latency on the hot path.
const TOPOLOGY_WARMUP_MS = 5_000;

// AXL-level heartbeat cadence. The bridge marks idle TCP peer links as
// `up:false` after a few minutes of silence, which collapses gossip
// routing — agents see SUBTASK_DONE broadcast as "X delivered" but the
// recipients never get it because there's no live route. Sending a tiny
// broadcast every minute exercises every known peer's sendToPeer path,
// which keeps the bridge's link state warm and routing healthy.
const HEARTBEAT_INTERVAL_MS = 60_000;

// Gossip relay fan-out. When we receive a fresh event, we re-broadcast it
// to N random peers so it propagates beyond the sender's local topology
// view. seenEvents already guards against loops/storms; 3 is enough to
// turn sparse star-topology into effective mesh coverage with bounded
// amplification (each event's tree depth is small).
const GOSSIP_RELAY_PEERS = 3;

// Stable, short fingerprint of a payload for the seenEvents key. Without it
// two distinct payloads emitted by the same agent at the same ms (rare but
// possible during burst broadcasts) would dedup against each other and the
// second event would silently drop.
function payloadFingerprint(payload: unknown): string {
  try {
    return createHash('sha1').update(JSON.stringify(payload ?? '')).digest('hex').slice(0, 12);
  } catch {
    return 'na';
  }
}

interface CachedTopology {
  ts: number;
  ourKey: string;
  targets: Set<string>;
}

export class AxlNetwork implements INetworkPort {
  private handlers = new Map<string, Set<(event: AXLEvent<any>) => void | Promise<void>>>();
  private isPolling = false;
  private readonly baseUrl: string;
  // pubkey → lastSeenMs. Replaces the old Set<string> so we can age out
  // peers that disappear (restart, network drop, container die).
  private knownNodes = new Map<string, number>();
  private topologyCache: CachedTopology | null = null;
  private warmupTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Identifier stamped on outgoing HEARTBEATs so receivers can attribute
  // the keepalive to a sender (and rememberNode them). Falls back to the
  // env var's AGENT_ID if nothing was passed in — both API and agent set
  // this in their respective entrypoints.
  private readonly nodeId: string;

  constructor(axlUrl: string = process.env.AXL_URL || 'http://127.0.0.1:9002') {
    this.baseUrl = axlUrl;
    this.nodeId = process.env.AGENT_ID || process.env.NODE_ID || 'axl-node';
  }

  async connect(): Promise<void> {
    try {
      // Check if AXL node is responsive
      const res = await fetch(`${this.baseUrl}/topology`);
      if (!res.ok) {
        throw new Error(`Failed to connect to AXL node. Status: ${res.status}`);
      }
      console.log(`[AxlNetwork] connected to AXL node at ${this.baseUrl}`);

      // Prime the cache so the first emit() doesn't pay the round-trip.
      await this.refreshTopology().catch(err =>
        console.warn('[AxlNetwork] initial topology warm-up failed:', err),
      );

      this.isPolling = true;
      this.pollMessages();
      this.startWarmupLoop();
      this.startHeartbeatLoop();
    } catch (err) {
      console.error('[AxlNetwork] connection failed:', err);
      throw err;
    }
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) return;
    // Fire one immediately so peer discovery lights up the link as soon
    // as we connect, without waiting a full minute for the first tick.
    this.sendHeartbeat().catch(() => {});
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(err => console.warn('[AxlNetwork] heartbeat error:', err));
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  private async sendHeartbeat(): Promise<void> {
    // Minimal payload — receivers don't read it, they just rememberNode
    // the sender. Keep it small so even at 1/min × N peers it's noise-free.
    const event: AXLEvent<{ ping: 1 }> = {
      type: EventType.HEARTBEAT,
      agentId: this.nodeId,
      payload: { ping: 1 },
      timestamp: Date.now(),
    };
    await this.emit(event);
  }

  private seenEvents = new Set<string>(); // Prevent gossip loops

  private startWarmupLoop(): void {
    if (this.warmupTimer) return;
    this.warmupTimer = setInterval(() => {
      this.refreshTopology().catch(() => {});
      this.pruneKnownNodes();
    }, TOPOLOGY_WARMUP_MS);
    // Don't keep the event loop alive on this interval alone — when the
    // agent decides to exit, this timer shouldn't pin the process open.
    if (typeof this.warmupTimer.unref === 'function') this.warmupTimer.unref();
  }

  private pruneKnownNodes(): void {
    const cutoff = Date.now() - KNOWN_NODE_TTL_MS;
    let pruned = 0;
    for (const [pk, ts] of this.knownNodes) {
      if (ts < cutoff) {
        this.knownNodes.delete(pk);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[AxlNetwork] pruned ${pruned} stale knownNodes (size=${this.knownNodes.size})`);
    }
  }

  private rememberNode(pk: string | null | undefined): void {
    if (!pk) return;
    this.knownNodes.set(pk, Date.now());
  }

  /**
   * Refresh and cache the broadcast target set. Combines:
   *  - topology.peers filtered to up:true (direct, live TCP connections —
   *    most reliable),
   *  - topology.tree (Yggdrasil spanning tree — broader but laggier),
   *  - knownNodes (peers who have talked to us recently).
   * Falls back to the previous cache (or knownNodes alone) on fetch
   * failure rather than silently dropping the broadcast.
   */
  private async refreshTopology(): Promise<CachedTopology> {
    try {
      const res = await fetch(`${this.baseUrl}/topology`);
      if (!res.ok) throw new Error(`topology HTTP ${res.status}`);
      const topology: any = await res.json();

      const targets = new Set<string>();
      const peers: any[] = topology.peers || [];
      for (const p of peers) {
        // Previously filtered by `p.up` to skip dead TCP links, but the
        // bridge marks idle-but-reachable peers as down too. Accepting
        // every public_key it knows about + relying on sendToPeer's
        // 3-retry dead-eviction is more reliable than this hint flag.
        if (p?.public_key) targets.add(p.public_key);
      }
      const tree: any[] = topology.tree || [];
      for (const t of tree) {
        if (t?.public_key) targets.add(t.public_key);
      }
      for (const pk of this.knownNodes.keys()) targets.add(pk);

      const cached: CachedTopology = {
        ts: Date.now(),
        ourKey: topology.our_public_key || '',
        targets,
      };
      this.topologyCache = cached;
      return cached;
    } catch (err) {
      // Fall back to cached or knownNodes-only — never silent drop.
      if (this.topologyCache) {
        return this.topologyCache;
      }
      const targets = new Set<string>(this.knownNodes.keys());
      return { ts: Date.now(), ourKey: '', targets };
    }
  }

  private async getBroadcastTargets(): Promise<CachedTopology> {
    const cached = this.topologyCache;
    if (cached && Date.now() - cached.ts < TOPOLOGY_CACHE_TTL_MS) {
      // Always merge fresh knownNodes — they may have grown since last refresh.
      for (const pk of this.knownNodes.keys()) cached.targets.add(pk);
      return cached;
    }
    return this.refreshTopology();
  }

  private async pollMessages() {
    while (this.isPolling) {
      try {
        const res = await fetch(`${this.baseUrl}/recv`);
        if (res.status === 204) {
          // Idle backoff between empty polls. 50ms instead of 100ms cuts
          // average gossip-to-handler latency on every event by ~25ms,
          // which compounds across ~10 events per task.
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }

        if (res.status === 200) {
          const body = await res.text();
          const fromPeer = res.headers.get('X-From-Peer-Id');

          try {
            const parsed = JSON.parse(body) as AXLEvent<any>;
            const now = Date.now();

            // Ignore stale messages or messages without timestamp.
            if (!parsed.timestamp || isNaN(parsed.timestamp) || (now - parsed.timestamp > EVENT_TTL_MS)) {
              continue;
            }

            const eventId = `${parsed.type}:${parsed.agentId}:${parsed.timestamp}:${payloadFingerprint(parsed.payload)}`;

            if (this.seenEvents.has(eventId)) continue;
            this.seenEvents.add(eventId);
            if (this.seenEvents.size > 10000) {
              // FIFO-ish: remove oldest 1000 instead of clearing all
              const arr = Array.from(this.seenEvents);
              this.seenEvents = new Set(arr.slice(1000));
            }

            // HEARTBEAT is an AXL-internal keepalive — refresh the
            // sender in knownNodes (its only purpose) and short-circuit:
            // no app handler dispatch, no gossip relay (the original
            // sender already broadcast to everyone), no log spam.
            if (parsed.type === EventType.HEARTBEAT) {
              this.rememberNode(parsed.senderPubKey);
              this.rememberNode(fromPeer);
              continue;
            }

            console.log(`[AxlNetwork V3-FIXED] Received NEW event: ${parsed.type} from ${parsed.agentId}`);

            // Remember the sender (with timestamp for TTL pruning).
            this.rememberNode(parsed.senderPubKey);
            this.rememberNode(fromPeer);

            const channel = `axl-events:${parsed.type}`;
            const globalChannel = 'axl-events';

            if (this.handlers.has(channel)) {
              for (const handler of this.handlers.get(channel)!) {
                await handler(parsed);
              }
            }

            if (this.handlers.has(globalChannel)) {
              for (const handler of this.handlers.get(globalChannel)!) {
                await handler(parsed);
              }
            }

            // Gossip relay: re-broadcast the event to N random live peers
            // so it propagates beyond the sender's local topology view.
            // seenEvents dedup on every node bounds the amplification —
            // each node forwards at most once. Fire-and-forget; failures
            // are logged inside the relay path.
            this.relayEvent(parsed).catch(err =>
              console.warn('[AxlNetwork] gossip relay error:', err),
            );
          } catch (parseErr) {
            console.error(`[AxlNetwork] Failed to parse message body:`, parseErr);
          }
        }
      } catch (err) {
        console.error(`[AxlNetwork] Polling error:`, err);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Per-peer send with bounded retry + dead-pubkey eviction. Returns
   *  - 'ok' on successful delivery,
   *  - 'dead' if every retry failed (and we've removed the pubkey from
   *    knownNodes so future broadcasts skip it),
   *  - 'skipped' if peerId is empty or self.
   */
  private async sendToPeer(peerId: string, ourKey: string, payload: string): Promise<'ok' | 'dead' | 'skipped'> {
    if (!peerId || peerId === ourKey) return 'skipped';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${this.baseUrl}/send`, {
          method: 'POST',
          headers: {
            'X-Destination-Peer-Id': peerId,
            'Content-Type': 'application/json',
          },
          body: payload,
        });
        if (r.ok) return 'ok';
        // 502 BadGateway from the bridge means dialPeerConnection failed —
        // peer is unreachable. Don't waste two more retries on it.
        if (r.status === 502) break;
      } catch {
        // network/transport error — retry with backoff
      }
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
    // Three strikes — evict from knownNodes so the next broadcast doesn't
    // try this corpse again. Tree-derived entries reappear on the next
    // refreshTopology() if the peer is actually live.
    this.knownNodes.delete(peerId);
    return 'dead';
  }

  /**
   * Re-broadcast a received event to a small random sample of peers, so
   * agents outside the original sender's topology view still get it.
   * Bounded amplification: every node relays at most once per event
   * (seenEvents guarantee), and we fan out to GOSSIP_RELAY_PEERS each.
   */
  private async relayEvent(event: AXLEvent<any>): Promise<void> {
    const cached = await this.getBroadcastTargets();
    const all = Array.from(cached.targets).filter(pk =>
      pk && pk !== cached.ourKey && pk !== event.senderPubKey,
    );
    if (all.length === 0) return;
    // Random N — Fisher-Yates partial shuffle.
    const n = Math.min(GOSSIP_RELAY_PEERS, all.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (all.length - i));
      [all[i], all[j]] = [all[j], all[i]];
    }
    const sample = all.slice(0, n);
    const payload = JSON.stringify(event);
    await Promise.all(sample.map(pk => this.sendToPeer(pk, cached.ourKey, payload)));
  }

  async emit<T>(event: AXLEvent<T>): Promise<void> {
    try {
      const isHeartbeat = event.type === EventType.HEARTBEAT;

      // Key MUST match pollMessages' format — payload fingerprint included.
      // If they diverge, the gossip-loopback event we just emitted comes
      // back through pollMessages with a different key, doesn't match the
      // seenEvents entry we just added, and gets handled a SECOND time.
      // That second handling is what produces "Already staked" reverts:
      // SUBTASK_DONE re-fires claimFirstAvailable, which races into a
      // re-execution while the original is mid-stake.
      const eventId = `${event.type}:${event.agentId}:${event.timestamp}:${payloadFingerprint(event.payload)}`;
      this.seenEvents.add(eventId);

      // Trigger local handlers immediately so we process our own events.
      // Heartbeats skip this — no app handler is registered for them and
      // we don't want to even build the unused dispatch promise.
      if (!isHeartbeat) {
        const channel = `axl-events:${event.type}`;
        const globalChannel = 'axl-events';
        const triggerHandlers = async () => {
          if (this.handlers.has(channel)) {
            for (const handler of this.handlers.get(channel)!) {
              await handler(event);
            }
          }
          if (this.handlers.has(globalChannel)) {
            for (const handler of this.handlers.get(globalChannel)!) {
              await handler(event);
            }
          }
        };
        triggerHandlers().catch(err => console.error('[AxlNetwork] local trigger error:', err));
      }

      const cached = await this.getBroadcastTargets();
      event.senderPubKey = cached.ourKey;
      const payload = JSON.stringify(event);

      const targetCount = cached.targets.size;
      const results = await Promise.all(
        Array.from(cached.targets).map(pk => this.sendToPeer(pk, cached.ourKey, payload)),
      );
      const ok = results.filter(r => r === 'ok').length;
      const dead = results.filter(r => r === 'dead').length;
      const skipped = results.filter(r => r === 'skipped').length;
      // delivered/dead surfaces the gap between optimistic target count
      // and reality. Heartbeat broadcasts skip the log so the operator's
      // tail isn't drowned by 1/min keepalive lines.
      if (!isHeartbeat) {
        console.log(
          `[AxlNetwork] Broadcast ${event.type}: ${ok} delivered, ${dead} dead, ${skipped} skipped, of ${targetCount}`,
        );
      }
    } catch (err) {
      console.error(`[AxlNetwork] Broadcast error:`, err);
    }
  }

  on<T>(type: EventType | '*', handler: (event: AXLEvent<T>) => void | Promise<void>): void {
    const channel = type === '*' ? 'axl-events' : `axl-events:${type}`;
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler as any);
  }

  off<T>(type: EventType | '*', handler?: (event: AXLEvent<T>) => void | Promise<void>): void {
    const channel = type === '*' ? 'axl-events' : `axl-events:${type}`;
    const handlers = this.handlers.get(channel);
    if (!handlers) return;

    if (handler) {
      handlers.delete(handler as any);
    } else {
      handlers.clear();
    }

    if (handlers.size === 0) {
      this.handlers.delete(channel);
    }
  }

  async disconnect(): Promise<void> {
    this.isPolling = false;
    if (this.warmupTimer) {
      clearInterval(this.warmupTimer);
      this.warmupTimer = null;
    }
  }
}
