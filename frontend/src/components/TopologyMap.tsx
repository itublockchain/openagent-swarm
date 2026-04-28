'use client'

import React, { useMemo, useRef, useState, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Float, Sphere, MeshDistortMaterial, Text } from '@react-three/drei'
import * as THREE from 'three'
import { useSwarmEvents } from '@/hooks/useSwarmEvents'
import { useTheme } from 'next-themes'

interface AgentNodeProps {
  id: string
  position: [number, number, number]
  status: string
  onSelect?: (id: string) => void
  isPulsing?: boolean
  themeColors: any
  index: number
  groupRef: React.RefObject<THREE.Group | null>
  baseScaleFactor: number
}

const AgentNode = ({ id, position, status, onSelect, isPulsing, themeColors, index, groupRef, baseScaleFactor }: AgentNodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null)
  const materialRef = useRef<any>(null)
  const impulse = useRef(new THREE.Vector3(0, 0, 0))
  const { camera } = useThree()
  
  const spawnTime = useRef<number | null>(null)
  
  const randomPhase = useMemo(() => Math.random() * Math.PI * 2, [])
  const bubblingSpeed = useMemo(() => 0.5 + Math.random() * 1.5, [])
  
  const baseColor = status === 'running' ? themeColors.active : (status === 'error' ? themeColors.error : themeColors.idle)
  const color = isPulsing ? themeColors.pulse : baseColor
  
  useFrame((state) => {
    const t = state.clock.elapsedTime
    
    if (spawnTime.current === null) {
      spawnTime.current = t
    }

    const elapsedSinceSpawn = t - spawnTime.current
    const entranceDuration = 1.5
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
      meshRef.current.rotation.y += 0.005
      
      const animatedScale = progress < 1 ? easeProgress : 1
      const finalBaseScale = baseScaleFactor * animatedScale
      
      if (isPulsing) {
        meshRef.current.scale.setScalar(finalBaseScale * (1.2 + Math.sin(t * 20) * 0.1))
      } else {
        const breathing = 1 + Math.sin(t * bubblingSpeed + randomPhase) * 0.05
        meshRef.current.scale.setScalar(finalBaseScale * breathing)
      }
    }

    if (materialRef.current) {
      const distortionLevel = isPulsing ? 0.8 : (progress < 1 ? 2 * (1 - easeProgress) + 0.4 : 0.4 + Math.sin(t * bubblingSpeed + randomPhase) * 0.2)
      materialRef.current.distort = distortionLevel
      materialRef.current.speed = isPulsing ? 10 : (progress < 1 ? 5 : 2 + Math.cos(t * 0.5) * 1)
    }
  })

  const handlePointerOver = (e: any) => {
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
      <Float speed={1.5} rotationIntensity={0.5} floatIntensity={0.5}>
        <Sphere 
          ref={meshRef}
          args={[0.4, 64, 64]} 
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.(id);
          }}
          onPointerOver={handlePointerOver}
          onPointerOut={() => { document.body.style.cursor = 'auto' }}
        >
          <MeshDistortMaterial
            ref={materialRef}
            color={color}
            speed={2}
            distort={0.4}
            radius={1}
            emissive={color}
            emissiveIntensity={isPulsing ? 2 : 0.5}
          />
        </Sphere>
      </Float>
      <Text
        position={[0, baseScaleFactor * 0.8, 0]} 
        fontSize={0.2}
        color={themeColors.text}
        anchorX="center"
        anchorY="middle"
      >
        {id.split('-').pop()?.substring(0, 4).toUpperCase()}
      </Text>
    </group>
  )
}

const P2PConnections = ({ agents, color, agentRefs }: { agents: any[], color: string, agentRefs: React.RefObject<THREE.Group | null>[] }) => {
  const geomRef = useRef<THREE.BufferGeometry>(null)

  const pairs = useMemo(() => {
    const p: any[] = []
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

export function TopologyMap({ agents, onSelect }: { agents: any[], onSelect?: (id: string) => void }) {
  const { events } = useSwarmEvents();
  const { resolvedTheme } = useTheme();
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  const themeColors = useMemo(() => {
    const isDark = resolvedTheme === 'dark';
    return {
      bg: isDark ? '#000000' : '#ffffff',
      active: isDark ? '#22c55e' : '#000000',
      idle: isDark ? '#3B82F6' : '#000000',
      error: '#EF4444',
      pulse: isDark ? '#ffffff' : '#000000',
      line: isDark ? '#3B82F6' : '#000000',
      text: isDark ? '#ffffff' : '#000000'
    }
  }, [resolvedTheme]);

  // YENİ DENGELİ ÖLÇEKLENDİRME MANTIĞI
  const agentNodes = useMemo(() => {
    const count = agents.length;
    
    const stakeValues = agents.map(a => parseFloat(a.stakeAmount || "10")); // Default 10 if missing
    const minStake = Math.min(...stakeValues, 10); // En az 10 baz alalım

    return agents.map((agent, i) => {
      const angle = (i / Math.max(1, count)) * Math.PI * 2
      const radius = 5
      const id = agent.agentId || agent.id;
      
      const currentStake = parseFloat(agent.stakeAmount || "10");
      
      // Örn: 10 USDC -> 1x, 50 USDC -> 1.2x mantığı
      // Formula: 1.0 + Math.min(1.0, (Stake / MinStake - 1) * 0.05)
      const baseScaleFactor = 1.0 + Math.min(1.0, (currentStake / minStake - 1) * 0.05);

      let yOffset = 0;
      if (count > 5) {
        yOffset = Math.sin(i * 2) * 2.5; 
      }

      return {
        ...agent,
        id,
        baseScaleFactor,
        position: [
          Math.cos(angle) * radius,
          yOffset,
          Math.sin(angle) * radius
        ] as [number, number, number]
      }
    })
  }, [agents])

  const agentRefs = useMemo(() => {
    return Array.from({ length: agents.length }, () => React.createRef<THREE.Group>());
  }, [agents.length]);

  useEffect(() => {
    if (events.length > 0) {
      const latest = events[0];
      const agentId = latest.agentId;
      if (agentId) {
        setActiveAgentId(agentId);
        const timer = setTimeout(() => setActiveAgentId(null), 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [events]);

  return (
    <div className="w-full h-full rounded-xl overflow-hidden relative" style={{ backgroundColor: themeColors.bg }}>
      <Canvas camera={{ position: [0, 10, 15], fov: 45 }}>
        <color attach="background" args={[themeColors.bg]} />
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} intensity={1} />
        <pointLight position={[-10, -10, -10]} color={themeColors.idle} intensity={0.5} />
        
        <P2PConnections agents={agentNodes} color={themeColors.line} agentRefs={agentRefs} />
        
        {agentNodes.map((agent, i) => (
          <AgentNode 
            key={agent.id} 
            id={agent.id} 
            position={agent.position} 
            status={agent.status}
            onSelect={onSelect}
            isPulsing={activeAgentId === agent.agentId}
            themeColors={themeColors}
            index={i}
            groupRef={agentRefs[i]}
            baseScaleFactor={agent.baseScaleFactor}
          />
        ))}
        
        <OrbitControls enableZoom={true} autoRotate autoRotateSpeed={0.3} />
      </Canvas>
    </div>
  )
}
