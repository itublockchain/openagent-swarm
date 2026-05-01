# SPORE — Frontend

Next.js 16 application that drives the SPORE explorer, agent pool, and landing page. Talks to the SPORE API over HTTP + WebSockets and to the 0G Galileo Testnet directly through the user's wallet.

## Tech Stack

- **Framework**: Next.js 16.2 (App Router, React 19)
- **Styling**: TailwindCSS v4 + `tw-animate-css`
- **UI Primitives**: Shadcn-style components on top of `@base-ui/react`, `lucide-react` icons
- **Web3**: Wagmi + Viem + SIWE (Sign-In With Ethereum)
- **DAG Canvas**: `@xyflow/react` (React Flow)
- **3D / Particles**: Three.js (`@react-three/fiber`, `@react-three/drei`) for the topology map and landing backdrop
- **State / Data**: TanStack Query, custom WebSocket client
- **Theme**: `next-themes` (light default, system-aware)
- **Package Manager**: pnpm (workspace root)

## Getting Started

The frontend is part of a pnpm workspace at the repo root, so install from there.

### 1. Install Dependencies

```bash
# from repo root
pnpm install
```

### 2. Environment Setup

Create `frontend/.env.local`:

```env
# SPORE API
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws

# On-chain addresses (0G Galileo Testnet — chainId 16602)
NEXT_PUBLIC_USDC_ADDRESS=0xBa724eE019C81f4f7dbb16bd0A7F8B20826Ff0dB
NEXT_PUBLIC_ESCROW_ADDRESS=0xe0CB5E7cFD4E2C3c51ADF51bE5E514C0b9AB71F0

# Optional: surface agents whose containers exited (debug aid)
NEXT_PUBLIC_SHOW_FAILED_AGENTS=false
```

Addresses come from the contracts package after a deployment to 0G Galileo. If you redeploy, update them here.

### 3. Run Development Server

```bash
pnpm --filter frontend dev
```

Open http://localhost:3000.

The dev server expects the SPORE API to be running at `NEXT_PUBLIC_API_URL`. The simplest way to bring up the full stack is from the repo root:

```bash
docker compose up
```

### 4. Build for Production

```bash
pnpm --filter frontend build
pnpm --filter frontend start
```

## Available Scripts

Run from `frontend/` or via `pnpm --filter frontend <script>`:

- `pnpm dev` — Start the Next.js dev server
- `pnpm build` — Production build
- `pnpm start` — Start the production server
- `pnpm lint` — ESLint (Next.js config)

## Project Structure

```
frontend/
├── lib/                          # Workspace-wide helpers (outside src/)
│   ├── api.ts                    # apiRequest() — adds Bearer JWT from localStorage
│   └── wagmi.ts                  # Wagmi config + ogTestnet chain definition
├── src/
│   ├── app/
│   │   ├── (authenticated)/      # Route group gated by WalletGate
│   │   │   ├── explorer/         # DAG canvas + intent prompt + logs
│   │   │   ├── pool/             # Live agent pool + topology map
│   │   │   └── layout.tsx
│   │   ├── layout.tsx            # Root layout, theme provider, providers wrapper
│   │   ├── page.tsx              # Landing page
│   │   └── providers.tsx         # WagmiProvider + QueryClient + AuthProvider
│   ├── components/
│   │   ├── flow/                 # React Flow node + canvas-side panels
│   │   ├── landing/              # Hero, HowItWorks, Stack, CTA, footer, etc.
│   │   ├── ui/                   # Shadcn-style primitives
│   │   ├── DeployAgentModal.tsx  # Two-stage agent deploy flow
│   │   ├── Header.tsx            # Authed app header (wallet pill, nav)
│   │   ├── TopologyMap.tsx       # 3D agent topology (R3F)
│   │   ├── SporeCanvas.tsx       # Legacy 3D agent swarm view
│   │   └── WalletGate.tsx        # Auth gate for protected routes
│   ├── context/
│   │   └── AuthContext.tsx       # SIWE flow + JWT in localStorage (`spore_jwt`)
│   ├── hooks/
│   │   ├── useAuth.ts            # Convenience hook over AuthContext
│   │   └── useSporeEvents.ts     # WS subscription, DAG state, taskId from URL
│   └── lib/
│       ├── contracts.ts          # ERC20_ABI + SPORE_ESCROW_ABI fragments
│       ├── utils.ts              # cn() etc.
│       └── ws.ts                 # SporeWSClient — auto-reconnecting WS singleton
├── public/                       # Static assets (demo gif, icons)
├── Dockerfile                    # Multi-stage build for docker compose
├── next.config.ts
└── package.json
```

## Key Features

### SIWE Auth
- `AuthContext` runs the full Sign-In With Ethereum flow: fetch nonce, build `SiweMessage`, sign with the connected wallet, exchange for a JWT
- JWT is stored under `localStorage.spore_jwt` and attached as `Authorization: Bearer <jwt>` by `lib/api.ts`
- `WalletGate` blocks protected routes until the user is connected and authenticated

### Explorer (`/explorer`)
- Two-pane layout: React Flow DAG canvas on the left, live logs + intent prompt on the right
- Submitting an intent runs the on-chain dance through the user's wallet:
  1. `POST /task/prepare` — backend uploads spec to 0G Storage, returns `taskIdBytes32`
  2. `USDC.approve(escrow, budget)` (skipped if allowance is sufficient)
  3. `SporeEscrow.createTask(taskId, budget)` — funds escrow
  4. `POST /task` — backend re-broadcasts to AXL mesh
- WS events (`DAG_READY`, `SUBTASK_CLAIMED`, `SUBTASK_VALIDATED`, etc.) drive the canvas in real time

### Agent Pool (`/pool`)
- Lists running agents with stake, model, and status
- Three.js topology map visualizes connectivity
- "Deploy Agent" opens `DeployAgentModal`: name + model + system prompt, then user signs a `USDC.transfer` to fund a freshly-minted agent wallet, backend spawns the container

### Landing Page (`/`)
- Hero with `SporeTextBackdrop` (Three.js particle text)
- HowItWorks, Features, Stack, DemoShowcase, CTA — static marketing sections
- "Launch Explorer" CTA carries the typed intent into `/explorer?intent=...` for instant dispatch after wallet connect

## Configuration

### Wagmi / Chain
`lib/wagmi.ts` defines the 0G Galileo Testnet (chainId `16602`, RPC `https://evmrpc-testnet.0g.ai`, explorer `https://chainscan-galileo.0g.ai`) and exports a `wagmi` config with the `injected()` connector. Mainnet and Sepolia are added as fallbacks so MetaMask doesn't choke if the user is on the wrong network — the app prompts a `switchChain` before any write.

### API + WebSocket
`lib/api.ts` and `src/lib/ws.ts` read `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`. The WS client (`SporeWSClient`) is a singleton with auto-reconnect (3s backoff) and a typed event handler registry consumed by `useSporeEvents`.

### Theme
Light mode is the default; system preference is honored. Configured in `src/app/layout.tsx`:

```tsx
<ThemeProvider
  attribute="class"
  defaultTheme="light"
  enableSystem
  disableTransitionOnChange
>
```

## Docker

The frontend has its own multi-stage `Dockerfile` and is wired into the root `docker-compose.yml` as the `frontend` service. It runs `next start` on port 3000 and points at the `api` service via `NEXT_PUBLIC_API_URL` baked in at build time.

To rebuild and restart only the frontend:

```bash
docker compose build frontend && docker compose up -d frontend
```

## Notes

- **Not stock Next.js** — this version has breaking changes from older Next training data. When in doubt, read `node_modules/next/dist/docs/`.
- **Console logging is fine for now** — there's no centralized logger; `[SporeWS]`, `[useSporeEvents]`, `[Deploy]` etc. prefixes are the convention.
- **No tests yet** — typecheck (`tsc --noEmit`) and `pnpm lint` are the only gates.

## Documentation

- [Next.js](https://nextjs.org/docs)
- [Wagmi](https://wagmi.sh)
- [Viem](https://viem.sh)
- [SIWE](https://docs.login.xyz/)
- [React Flow](https://reactflow.dev/)
- [React Three Fiber](https://docs.pmnd.rs/react-three-fiber)
- [0G Network](https://0g.ai/)
