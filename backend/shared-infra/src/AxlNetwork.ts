import { INetworkPort } from '@swarm/shared';
import { AXLEvent, EventType } from '@swarm/shared';
import { createHash } from 'node:crypto';

// Lifetime of an event before pollMessages drops it. 5s was way too tight
// (0G testnet RPC can lag ~30s), and we now align with the API's WebSocket
// bridge tolerance (60s) so the two layers don't disagree about whether
// an event is "stale". Replay risk is still bounded by seenEvents.
const EVENT_TTL_MS = 60_000;

// Lifetime of a knownNodes entry. Agents reboot with new Yggdrasil pubkeys
// (and old pubkeys never get pruned by the bridge for ~minutes), so without
// a TTL the set grows monotonically across docker-compose down/up cycles
// and broadcasts get sent to dead addresses. 5 min is well above any
// healthy event cadence — a peer we haven't heard from in 5 min is gone.
const KNOWN_NODE_TTL_MS = 5 * 60_000;

// Topology cache TTL. Yggdrasil's spanning tree converges over seconds, not
// per request — caching for 5s cuts ~10x bridge HTTP load on busy bursts
// without any meaningful staleness in the broadcast view.
const TOPOLOGY_CACHE_TTL_MS = 5_000;

// Background warm-up cadence. Refreshes the topology cache + prunes stale
// knownNodes so emit() doesn't pay the latency on the hot path.
const TOPOLOGY_WARMUP_MS = 5_000;

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

  constructor(axlUrl: string = process.env.AXL_URL || 'http://127.0.0.1:9002') {
    this.baseUrl = axlUrl;
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
    } catch (err) {
      console.error('[AxlNetwork] connection failed:', err);
      throw err;
    }
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
        // up:true means the TCP link to that peer is currently live.
        // Filtering here avoids the bridge dialling dead links.
        if (p?.up && p?.public_key) targets.add(p.public_key);
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
      // Key MUST match pollMessages' format — payload fingerprint included.
      // If they diverge, the gossip-loopback event we just emitted comes
      // back through pollMessages with a different key, doesn't match the
      // seenEvents entry we just added, and gets handled a SECOND time.
      // That second handling is what produces "Already staked" reverts:
      // SUBTASK_DONE re-fires claimFirstAvailable, which races into a
      // re-execution while the original is mid-stake.
      const eventId = `${event.type}:${event.agentId}:${event.timestamp}:${payloadFingerprint(event.payload)}`;
      this.seenEvents.add(eventId);

      // Trigger local handlers immediately so we process our own events
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
      // and reality. "12 delivered, 47 dead, of 64" is the truth that
      // the previous "to 64 nodes" log hid.
      console.log(
        `[AxlNetwork] Broadcast ${event.type}: ${ok} delivered, ${dead} dead, ${skipped} skipped, of ${targetCount}`,
      );
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
