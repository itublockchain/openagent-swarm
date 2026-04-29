'use client'

import React, { useMemo, useRef, useState, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Float, Sphere, MeshDistortMaterial, Text, Billboard } from '@react-three/drei'
import * as THREE from 'three'
import { useSwarmEvents } from '@/hooks/useSwarmEvents'
import { useTheme } from 'next-themes'

interface ThemeColors {
  bg: string
  active: string
  idle: string
  error: string
  pulse: string
  line: string
  text: string
  panel: string
  textOutline: string
}

interface AgentNodeProps {
  id: string
  name?: string
  position: [number, number, number]
  status: string
  onSelect?: (id: string) => void
  isPulsing?: boolean
  themeColors: ThemeColors
  index: number
  groupRef: React.RefObject<THREE.Group | null>
  baseScaleFactor: number
}

const AgentNode = ({ id, name, position, status, onSelect, isPulsing, themeColors, groupRef, baseScaleFactor }: AgentNodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null)
  // MeshDistortMaterial's impl type isn't exported cleanly; use a permissive
  // shape so we can poke distort/speed each frame.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const materialRef = useRef<any>(null)
  const labelRef = useRef<THREE.Group>(null)
  const labelTextMatRef = useRef<THREE.Material & { opacity?: number } | null>(null)
  const impulse = useRef(new THREE.Vector3(0, 0, 0))
  const { camera } = useThree()

  const spawnTime = useRef<number | null>(null)

  const randomPhase = useMemo(() => Math.random() * Math.PI * 2, [])
  const bubblingSpeed = useMemo(() => 0.5 + Math.random() * 1.5, [])

  const baseColor = status === 'running' ? themeColors.active : (status === 'error' ? themeColors.error : themeColors.idle)
  const color = isPulsing ? themeColors.pulse : baseColor

  // Short, always-visible label. Prefer the human name; fall back to the
  // first 6 chars of the id (e.g. "0X83AE") so the user can still tell
  // nodes apart at a glance.
  const labelText = useMemo(() => {
    if (name && name.trim()) return name.toUpperCase()
    if (!id) return 'NODE'
    return id.slice(0, 6).toUpperCase()
  }, [id, name])

  useFrame((state) => {
    const t = state.clock.elapsedTime

    if (spawnTime.current === null) {
      spawnTime.current = t
    }

    const elapsedSinceSpawn = t - spawnTime.current
    const entranceDuration = 1.4
    const progress = Math.min(elapsedSinceSpawn / entranceDuration, 1)
    const easeProgress = 1 - Math.pow(1 - progress, 3)

    if (groupRef.current) {
      groupRef.current.position.add(impulse.current)
      impulse.current.multiplyScalar(0.9)

      const targetX = position[0]
      const targetY = position[1]
      const targetZ = position[2]

      if (progress < 1) {
        groupRef.current.position.x = THREE.MathUtils.lerp(0, targetX, easeProgress)
        groupRef.current.position.y = THREE.MathUtils.lerp(0, targetY, easeProgress)
        groupRef.current.position.z = THREE.MathUtils.lerp(0, targetZ, easeProgress)
      } else {
        groupRef.current.position.x += (targetX - groupRef.current.position.x) * 0.05
        groupRef.current.position.y += (targetY - groupRef.current.position.y) * 0.05
        groupRef.current.position.z += (targetZ - groupRef.current.position.z) * 0.05
      }

      groupRef.current.position.x += Math.sin(t * 2 + randomPhase) * 0.003
      groupRef.current.position.y += Math.cos(t * 1.5 + randomPhase) * 0.003
    }

    if (meshRef.current) {
      meshRef.current.rotation.y += 0.003

      const animatedScale = progress < 1 ? easeProgress : 1
      const finalBaseScale = baseScaleFactor * animatedScale

      if (isPulsing) {
        // Tighter, smoother pulse instead of the previous jittery 20Hz beat
        meshRef.current.scale.setScalar(finalBaseScale * (1.12 + Math.sin(t * 6) * 0.06))
      } else {
        const breathing = 1 + Math.sin(t * bubblingSpeed * 0.5 + randomPhase) * 0.025
        meshRef.current.scale.setScalar(finalBaseScale * breathing)
      }
    }

    if (materialRef.current) {
      // Idle: nearly clean sphere, just a hint of life.
      // Pulse: a small bump in distortion for emphasis.
      // Spawn: starts loose and settles in over the entrance.
      if (isPulsing) {
        materialRef.current.distort = 0.18
        materialRef.current.speed = 4
      } else if (progress < 1) {
        materialRef.current.distort = 0.25 * (1 - easeProgress) + 0.05
        materialRef.current.speed = 3 * (1 - easeProgress) + 1
      } else {
        materialRef.current.distort = 0.05 + Math.sin(t * 0.6 + randomPhase) * 0.015
        materialRef.current.speed = 1
      }
    }

    // Label entrance + idle bob + pulse animation
    if (labelRef.current) {
      const labelDelay = 0.5
      const labelDuration = 0.55
      const labelProgress = Math.max(0, Math.min(1, (elapsedSinceSpawn - labelDelay) / labelDuration))
      const labelEase = 1 - Math.pow(1 - labelProgress, 3)

      const baseLabelScale = 0.85 + labelEase * 0.15
      const pulseLabelScale = isPulsing ? 1 + Math.sin(t * 6) * 0.04 : 1
      labelRef.current.scale.setScalar(baseLabelScale * pulseLabelScale)

      // Subtle vertical drift so it feels alive without distracting
      const bob = Math.sin(t * 1.2 + randomPhase) * 0.02
      labelRef.current.position.y = baseScaleFactor * 0.95 + bob

      if (labelTextMatRef.current) {
        labelTextMatRef.current.opacity = labelEase
      }
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
      <Float speed={1.0} rotationIntensity={0.2} floatIntensity={0.35}>
        <Sphere
          ref={meshRef}
          args={[0.4, 96, 96]}
          onClick={(e) => {
            e.stopPropagation()
            onSelect?.(id)
          }}
          onPointerOver={handlePointerOver}
          onPointerOut={() => { document.body.style.cursor = 'auto' }}
        >
          <MeshDistortMaterial
            ref={materialRef}
            color={color}
            speed={1}
            distort={0.05}
            radius={1}
            emissive={color}
            emissiveIntensity={isPulsing ? 1.4 : 0.45}
            roughness={0.25}
            metalness={0.1}
          />
        </Sphere>
      </Float>

      {/* Floating label — no pill, no frame. Billboarded so it tracks the
          camera, and depthTest=false + high renderOrder keep it on top even
          when the sphere rotates in front of it. The outline gives the glyphs
          enough contrast to stay readable on any background. */}
      <Billboard
        ref={labelRef}
        position={[0, baseScaleFactor * 0.95, 0]}
        follow={true}
      >
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

const P2PConnections = ({ agents, color, agentRefs }: { agents: { id: string }[]; color: string; agentRefs: React.RefObject<THREE.Group | null>[] }) => {
  const geomRef = useRef<THREE.BufferGeometry>(null)

  const pairs = useMemo(() => {
    const p: { i: number; j: number }[] = []
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        p.push({ i, j })
      }
    }
    return p
  }, [agents.length])

  useFrame(() => {
    if (!geomRef.current || pairs.length === 0) return

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

    geomRef.current.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geomRef.current.attributes.position.needsUpdate = true
  })

  return (
    <lineSegments>
      <bufferGeometry ref={geomRef} />
      <lineBasicMaterial color={color} transparent opacity={0.2} linewidth={1} />
    </lineSegments>
  )
}

interface AgentInput {
  agentId?: string
  id?: string
  name?: string
  status: string
  stakeAmount?: string
}

export function TopologyMap({ agents, onSelect, selectedAgentId }: { agents: AgentInput[]; onSelect?: (id: string) => void; selectedAgentId?: string | null }) {
  const { events } = useSwarmEvents()
  const { resolvedTheme } = useTheme()
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const [isTabVisible, setIsTabVisible] = useState(true)

  useEffect(() => {
    const onVis = () => setIsTabVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const themeColors: ThemeColors = useMemo(() => {
    const isDark = resolvedTheme === 'dark'
    return {
      bg: isDark ? '#000000' : '#ffffff',
      active: isDark ? '#22c55e' : '#16a34a',
      idle: isDark ? '#3B82F6' : '#1d4ed8',
      error: '#EF4444',
      pulse: isDark ? '#ffffff' : '#0a0a0a',
      line: isDark ? '#3B82F6' : '#94a3b8',
      text: isDark ? '#ffffff' : '#0a0a0a',
      panel: isDark ? '#0a0a0a' : '#ffffff',
      textOutline: isDark ? '#000000' : '#ffffff',
    }
  }, [resolvedTheme])

  const agentNodes = useMemo(() => {
    const count = agents.length

    const stakeValues = agents.map(a => parseFloat(a.stakeAmount || '10'))
    const minStake = Math.min(...stakeValues, 10)

    return agents.map((agent, i) => {
      const angle = (i / Math.max(1, count)) * Math.PI * 2
      const radius = 5
      const id = agent.agentId || agent.id || ''

      const currentStake = parseFloat(agent.stakeAmount || '10')

      // 10 USDC -> 1x, 50 USDC -> 1.2x.
      const baseScaleFactor = 1.0 + Math.min(1.0, (currentStake / minStake - 1) * 0.05)

      let yOffset = 0
      if (count > 5) {
        yOffset = Math.sin(i * 2) * 2.5
      }

      return {
        ...agent,
        id,
        baseScaleFactor,
        position: [
          Math.cos(angle) * radius,
          yOffset,
          Math.sin(angle) * radius,
        ] as [number, number, number],
      }
    })
  }, [agents])

  const agentRefs = useMemo(() => {
    return Array.from({ length: agents.length }, () => React.createRef<THREE.Group>())
  }, [agents.length])

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
        {/* Three-point-ish lighting for cleaner sphere shading */}
        <ambientLight intensity={0.45} />
        <directionalLight position={[5, 8, 6]} intensity={0.9} />
        <pointLight position={[-8, -4, -6]} color={themeColors.idle} intensity={0.55} />
        <pointLight position={[0, 6, 8]} color={themeColors.active} intensity={0.25} />

        <P2PConnections agents={agentNodes} color={themeColors.line} agentRefs={agentRefs} />

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
            index={i}
            groupRef={agentRefs[i]}
            baseScaleFactor={agent.baseScaleFactor}
          />
        ))}

        <OrbitControls enableZoom={true} autoRotate={isTabVisible} autoRotateSpeed={0.3} />
      </Canvas>
    </div>
  )
}
