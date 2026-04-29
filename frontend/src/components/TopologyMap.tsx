'use client'

import React, { useMemo, useRef, useState, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Float, Sphere, Text, Billboard, Stars } from '@react-three/drei'
import * as THREE from 'three'
import { useSwarmEvents } from '@/hooks/useSwarmEvents'
import { useTheme } from 'next-themes'

interface ThemeColors {
  bg: string
  pulse: string
  line: string
  flow: string
  text: string
  textOutline: string
}

// Status → ring colour. Drives the orbital ring around each sphere so the
// agent's health is readable at a glance even though its body colour is
// driven by identity instead.
const STATUS_RING: Record<string, string> = {
  running: '#22c55e',
  error: '#ef4444',
  pending: '#f59e0b',
  stopped: '#94a3b8',
}

// Deterministic agent hue. djb2-ish hash → golden-ratio rotation around
// the wheel so adjacent ids spread out instead of clustering.
function hashHue(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
  }
  return Math.abs(Math.round(h * 0.61803398875)) % 360
}

interface AgentNodeProps {
  id: string
  name?: string
  position: [number, number, number]
  status: string
  onSelect?: (id: string) => void
  isPulsing?: boolean
  themeColors: ThemeColors
  groupRef: React.RefObject<THREE.Group | null>
  baseScaleFactor: number
  isDark: boolean
}

const AgentNode = ({
  id,
  name,
  position,
  status,
  onSelect,
  isPulsing,
  themeColors,
  groupRef,
  baseScaleFactor,
  isDark,
}: AgentNodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null)
  const matRef = useRef<THREE.MeshStandardMaterial>(null)
  const ringRef = useRef<THREE.Mesh>(null)
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null)
  const labelRef = useRef<THREE.Group>(null)
  const labelTextMatRef = useRef<THREE.Material & { opacity?: number } | null>(null)
  const impulse = useRef(new THREE.Vector3(0, 0, 0))
  const { camera } = useThree()
  const spawnTime = useRef<number | null>(null)

  // Per-instance random offsets give every node its own breathing rhythm
  // so the swarm doesn't move in lockstep.
  const randomPhase = useMemo(() => Math.random() * Math.PI * 2, [])
  const bubblingSpeed = useMemo(() => 0.5 + Math.random() * 1.5, [])

  // Identity colour — stable per id. Slightly brighter on dark theme so
  // the spheres pop against the black backdrop.
  const baseColor = useMemo(() => {
    const c = new THREE.Color()
    const hue = hashHue(id) / 360
    const sat = status === 'stopped' ? 0.35 : 0.6
    const light = isDark ? 0.55 : 0.5
    c.setHSL(hue, sat, light)
    return c
  }, [id, status, isDark])

  const ringColor = STATUS_RING[status] ?? STATUS_RING.stopped

  const labelText = useMemo(() => {
    if (name && name.trim()) return name.toUpperCase()
    if (!id) return 'NODE'
    return id.slice(0, 6).toUpperCase()
  }, [id, name])

  useFrame((state) => {
    const t = state.clock.elapsedTime

    if (spawnTime.current === null) spawnTime.current = t
    const elapsedSinceSpawn = t - spawnTime.current
    const entranceDuration = 1.4
    const progress = Math.min(elapsedSinceSpawn / entranceDuration, 1)
    const easeProgress = 1 - Math.pow(1 - progress, 3)

    if (groupRef.current) {
      groupRef.current.position.add(impulse.current)
      impulse.current.multiplyScalar(0.9)

      const [tx, ty, tz] = position
      if (progress < 1) {
        groupRef.current.position.x = THREE.MathUtils.lerp(0, tx, easeProgress)
        groupRef.current.position.y = THREE.MathUtils.lerp(0, ty, easeProgress)
        groupRef.current.position.z = THREE.MathUtils.lerp(0, tz, easeProgress)
      } else {
        groupRef.current.position.x += (tx - groupRef.current.position.x) * 0.05
        groupRef.current.position.y += (ty - groupRef.current.position.y) * 0.05
        groupRef.current.position.z += (tz - groupRef.current.position.z) * 0.05
      }

      // Tiny drift so the swarm feels alive even on idle.
      groupRef.current.position.x += Math.sin(t * 2 + randomPhase) * 0.003
      groupRef.current.position.y += Math.cos(t * 1.5 + randomPhase) * 0.003
    }

    if (meshRef.current) {
      meshRef.current.rotation.y += 0.0012
      const animatedScale = progress < 1 ? easeProgress : 1
      const finalBaseScale = baseScaleFactor * animatedScale
      if (isPulsing) {
        meshRef.current.scale.setScalar(finalBaseScale * (1.06 + Math.sin(t * 4) * 0.025))
      } else {
        const breathing = 1 + Math.sin(t * bubblingSpeed * 0.4 + randomPhase) * 0.008
        meshRef.current.scale.setScalar(finalBaseScale * breathing)
      }
    }

    // Material emissive: identity-tinted glow at idle; status colour when
    // the node is selected or active. Error nodes pulse on the ring, not
    // the body, so the body never goes red.
    if (matRef.current) {
      if (isPulsing) {
        matRef.current.emissive.set(ringColor)
        matRef.current.emissiveIntensity = 0.45 + Math.sin(t * 4) * 0.1
      } else {
        matRef.current.emissive.copy(baseColor)
        matRef.current.emissiveIntensity = isDark ? 0.18 : 0.08
      }
    }

    // Ring: error nodes get a slow opacity pulse; running nodes glow
    // steadily; everything else stays calm.
    if (ringRef.current && ringMatRef.current) {
      ringRef.current.rotation.z += 0.0025
      let target = 0.85
      if (status === 'error') target = 0.6 + Math.sin(t * 1.6) * 0.35
      else if (status === 'running') target = 0.85 + Math.sin(t * 1.1) * 0.1
      ringMatRef.current.opacity = target
    }

    // Label entrance + idle bob + pulse animation.
    if (labelRef.current) {
      const labelDelay = 0.5
      const labelDuration = 0.55
      const labelProgress = Math.max(0, Math.min(1, (elapsedSinceSpawn - labelDelay) / labelDuration))
      const labelEase = 1 - Math.pow(1 - labelProgress, 3)

      const baseLabelScale = 0.85 + labelEase * 0.15
      const pulseLabelScale = isPulsing ? 1 + Math.sin(t * 6) * 0.04 : 1
      labelRef.current.scale.setScalar(baseLabelScale * pulseLabelScale)
      const bob = Math.sin(t * 1.2 + randomPhase) * 0.02
      labelRef.current.position.y = baseScaleFactor * 1.05 + bob

      if (labelTextMatRef.current) labelTextMatRef.current.opacity = labelEase
    }
  })

  const handlePointerOver = (e: { stopPropagation: () => void }) => {
    document.body.style.cursor = 'pointer'
    e.stopPropagation()
    if (groupRef.current) {
      const pushDir = groupRef.current.position.clone().sub(camera.position).normalize()
      pushDir.multiplyScalar(0.7)
      impulse.current.copy(pushDir)
    }
  }

  return (
    <group ref={groupRef}>
      <Float speed={0.55} rotationIntensity={0.08} floatIntensity={0.16}>
        {/* Identity-coloured sphere. Standard PBR material — soft sheen
            without the plastic feel a metalness=0 matte gives. */}
        <Sphere
          ref={meshRef}
          args={[0.4, 64, 64]}
          onClick={(e) => {
            e.stopPropagation()
            onSelect?.(id)
          }}
          onPointerOver={handlePointerOver}
          onPointerOut={() => { document.body.style.cursor = 'auto' }}
        >
          <meshStandardMaterial
            ref={matRef}
            color={baseColor}
            roughness={0.55}
            metalness={0.18}
            emissive={baseColor}
            emissiveIntensity={isDark ? 0.18 : 0.08}
          />
        </Sphere>

        {/* Saturn-style status ring orbiting the sphere. Tilt is fixed so
            it reads as a deliberate band, and a slow self-spin adds life
            independently of the camera's auto-rotation. */}
        <mesh ref={ringRef} rotation={[Math.PI / 2 - 0.35, 0.25, 0]}>
          <torusGeometry args={[0.56, 0.022, 14, 80]} />
          <meshBasicMaterial
            ref={ringMatRef}
            color={ringColor}
            toneMapped={false}
            transparent
            opacity={0.85}
            depthWrite={false}
          />
        </mesh>
      </Float>

      {/* Label sits above the sphere, billboarded to the camera. Outline
          + depthTest=false keep the glyphs readable on any background. */}
      <Billboard ref={labelRef} position={[0, baseScaleFactor * 1.05, 0]} follow={true}>
        <Text
          fontSize={0.18}
          color={themeColors.text}
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.05}
          fontWeight={700}
          outlineWidth={0.018}
          outlineColor={themeColors.textOutline}
          outlineOpacity={0.95}
          renderOrder={999}
          onSync={(troika: { material: THREE.Material }) => {
            const mat = troika.material as THREE.Material & {
              depthTest?: boolean
              depthWrite?: boolean
              transparent?: boolean
              opacity?: number
            }
            mat.depthTest = false
            mat.depthWrite = false
            mat.transparent = true
            labelTextMatRef.current = mat as THREE.Material & { opacity?: number }
          }}
        >
          {labelText}
        </Text>
      </Billboard>
    </group>
  )
}

interface ConnectionsProps {
  agents: { id: string; agentId?: string }[]
  agentRefs: React.RefObject<THREE.Group | null>[]
  themeColors: ThemeColors
  isDark: boolean
}

// Full-mesh straight lines, single LineSegments buffer.
const P2PConnections = ({ agents, agentRefs, themeColors, isDark }: ConnectionsProps) => {
  const geomRef = useRef<THREE.BufferGeometry>(null)
  const matRef = useRef<THREE.LineBasicMaterial>(null)

  const pairs = useMemo(() => {
    const p: { i: number; j: number }[] = []
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) p.push({ i, j })
    }
    return p
  }, [agents.length])

  useFrame((state) => {
    const geom = geomRef.current
    const mat = matRef.current
    if (!geom || pairs.length === 0) return

    const positions = new Float32Array(pairs.length * 6)
    pairs.forEach((pair, idx) => {
      const start = agentRefs[pair.i]?.current?.position
      const end = agentRefs[pair.j]?.current?.position
      if (start && end) {
        positions[idx * 6 + 0] = start.x
        positions[idx * 6 + 1] = start.y
        positions[idx * 6 + 2] = start.z
        positions[idx * 6 + 3] = end.x
        positions[idx * 6 + 4] = end.y
        positions[idx * 6 + 5] = end.z
      }
    })
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.attributes.position.needsUpdate = true

    if (mat) {
      const t = state.clock.elapsedTime
      const baseline = isDark ? 0.78 : 0.62
      mat.opacity = baseline + Math.sin(t * 0.8) * 0.05
    }
  })

  if (pairs.length === 0) return null

  return (
    <group>
      <lineSegments>
        <bufferGeometry ref={geomRef} />
        <lineBasicMaterial
          ref={matRef}
          color={themeColors.line}
          transparent
          opacity={isDark ? 0.78 : 0.62}
          blending={isDark ? THREE.AdditiveBlending : THREE.NormalBlending}
          toneMapped={false}
          depthWrite={false}
        />
      </lineSegments>
      <FlowParticles pairs={pairs} agentRefs={agentRefs} color={themeColors.flow} />
    </group>
  )
}

const ELECTRON_SIZE = 0.12

interface FlowProps {
  pairs: { i: number; j: number }[]
  agentRefs: React.RefObject<THREE.Group | null>[]
  color: string
}

const FlowParticles = ({ pairs, agentRefs, color }: FlowProps) => {
  const streams = Math.min(6, Math.max(2, Math.ceil(pairs.length * 0.25)))

  const coreRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])

  type Packet = { pair: number; dir: 1 | -1; progress: number; speed: number }
  const packetsRef = useRef<Packet[] | null>(null)

  useFrame((_, delta) => {
    const core = coreRef.current
    if (!core || pairs.length === 0) return
    const dt = Math.min(delta, 0.05)

    if (!packetsRef.current || packetsRef.current.length !== streams) {
      packetsRef.current = Array.from({ length: streams }, () => ({
        pair: 0,
        dir: 1 as 1 | -1,
        progress: 1,
        speed: 0.32 + Math.random() * 0.24,
      }))
    }
    const packets = packetsRef.current

    for (let s = 0; s < packets.length; s++) {
      const p = packets[s]

      if (p.progress >= 1) {
        p.pair = Math.floor(Math.random() * pairs.length)
        p.dir = Math.random() < 0.5 ? 1 : -1
        p.progress = 0
        p.speed = 0.32 + Math.random() * 0.24
      }

      p.progress += dt * p.speed

      const { i, j } = pairs[p.pair]
      const aPos = agentRefs[i]?.current?.position
      const bPos = agentRefs[j]?.current?.position

      const t = p.progress
      const visibility = Math.min(1, Math.sin(t * Math.PI) * 1.6)

      if (aPos && bPos && visibility > 0) {
        const start = p.dir > 0 ? aPos : bPos
        const end = p.dir > 0 ? bPos : aPos
        dummy.position.set(
          start.x + (end.x - start.x) * t,
          start.y + (end.y - start.y) * t,
          start.z + (end.z - start.z) * t,
        )
        dummy.scale.setScalar(ELECTRON_SIZE * visibility)
      } else {
        dummy.scale.setScalar(0)
        dummy.position.set(0, 0, 0)
      }
      dummy.updateMatrix()
      core.setMatrixAt(s, dummy.matrix)
    }
    core.instanceMatrix.needsUpdate = true
  })

  if (pairs.length === 0) return null

  return (
    <instancedMesh ref={coreRef} args={[undefined, undefined, streams]} renderOrder={6}>
      <sphereGeometry args={[1, 32, 32]} />
      <meshBasicMaterial
        color={color}
        toneMapped={false}
        transparent
        opacity={0.95}
        depthWrite={false}
      />
    </instancedMesh>
  )
}

// Slow drift on two coloured fill lights so the spheres aren't lit
// statically.
const AmbientDrift = () => {
  const a = useRef<THREE.PointLight>(null)
  const b = useRef<THREE.PointLight>(null)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (a.current) {
      a.current.position.x = Math.cos(t * 0.25) * 9
      a.current.position.z = Math.sin(t * 0.25) * 9
      a.current.position.y = -3 + Math.sin(t * 0.4) * 1.2
    }
    if (b.current) {
      b.current.position.x = Math.cos(t * 0.18 + Math.PI) * 7
      b.current.position.z = Math.sin(t * 0.18 + Math.PI) * 7
      b.current.position.y = 4 + Math.cos(t * 0.35) * 1.2
    }
  })
  return (
    <>
      <pointLight ref={a} color="#60a5fa" intensity={0.7} distance={28} />
      <pointLight ref={b} color="#f472b6" intensity={0.45} distance={26} />
    </>
  )
}

interface AgentInput {
  agentId?: string
  id?: string
  name?: string
  status: string
  stakeAmount?: string
}

export function TopologyMap({
  agents,
  onSelect,
  selectedAgentId,
}: {
  agents: AgentInput[]
  onSelect?: (id: string) => void
  selectedAgentId?: string | null
}) {
  const { events } = useSwarmEvents()
  const { resolvedTheme } = useTheme()
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const [isTabVisible, setIsTabVisible] = useState(true)

  useEffect(() => {
    const onVis = () => setIsTabVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const isDark = resolvedTheme === 'dark'

  const themeColors: ThemeColors = useMemo(
    () => ({
      bg: isDark ? '#000000' : '#ffffff',
      pulse: isDark ? '#ffffff' : '#0a0a0a',
      // Mesh edges: blue, additive on dark, normal on light.
      line: isDark ? '#3B82F6' : '#1d4ed8',
      // Cyan electron — matches the cool blue mesh, doesn't collide with
      // the red error semantics on the status ring.
      flow: isDark ? '#67e8f9' : '#0891b2',
      text: isDark ? '#ffffff' : '#0a0a0a',
      textOutline: isDark ? '#000000' : '#ffffff',
    }),
    [isDark]
  )

  const agentNodes = useMemo(() => {
    const count = agents.length
    const stakeValues = agents.map(a => parseFloat(a.stakeAmount || '10'))
    const minStake = Math.min(...stakeValues, 10)

    return agents.map((agent, i) => {
      const angle = (i / Math.max(1, count)) * Math.PI * 2
      const radius = 5
      const id = agent.agentId || agent.id || ''
      const currentStake = parseFloat(agent.stakeAmount || '10')
      const baseScaleFactor = 1.0 + Math.min(1.0, (currentStake / minStake - 1) * 0.05)

      let yOffset = 0
      if (count > 5) yOffset = Math.sin(i * 2) * 2.5

      return {
        ...agent,
        id,
        baseScaleFactor,
        position: [Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius] as [number, number, number],
      }
    })
  }, [agents])

  const agentRefs = useMemo(
    () => Array.from({ length: agents.length }, () => React.createRef<THREE.Group>()),
    [agents.length]
  )

  useEffect(() => {
    if (events.length > 0) {
      const latest = events[0]
      const agentId = latest.agentId
      if (agentId) {
        setActiveAgentId(agentId)
        const timer = setTimeout(() => setActiveAgentId(null), 1000)
        return () => clearTimeout(timer)
      }
    }
  }, [events])

  return (
    <div className="w-full h-full rounded-xl overflow-hidden relative" style={{ backgroundColor: themeColors.bg }}>
      <Canvas camera={{ position: [0, 10, 15], fov: 45 }} dpr={[1, 2]}>
        <color attach="background" args={[themeColors.bg]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 8, 6]} intensity={0.95} />
        <AmbientDrift />

        {isDark && (
          <Stars radius={60} depth={40} count={800} factor={1.6} saturation={0} fade speed={0.3} />
        )}

        <P2PConnections
          agents={agentNodes}
          agentRefs={agentRefs}
          themeColors={themeColors}
          isDark={isDark}
        />

        {agentNodes.map((agent, i) => (
          <AgentNode
            key={agent.id}
            id={agent.id}
            name={agent.name}
            position={agent.position}
            status={agent.status}
            onSelect={onSelect}
            isPulsing={activeAgentId === agent.agentId || selectedAgentId === agent.agentId}
            themeColors={themeColors}
            groupRef={agentRefs[i]}
            baseScaleFactor={agent.baseScaleFactor}
            isDark={isDark}
          />
        ))}

        <OrbitControls enableZoom={true} autoRotate={isTabVisible} autoRotateSpeed={0.3} />
      </Canvas>
    </div>
  )
}
