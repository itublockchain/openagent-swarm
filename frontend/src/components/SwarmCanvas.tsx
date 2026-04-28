'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useTheme } from 'next-themes'

interface AgentNode {
  agentId: string
  model: string
  status: 'running' | 'stopped' | 'error'
  stakeAmount: string
}

interface Props {
  agents: AgentNode[]
  onSelect?: (agentId: string) => void
}

const STATUS_COLORS: Record<string, number> = {
  running: 0x22c55e, // green-500
  stopped: 0x64748b, // slate-500
  error:   0xef4444, // red-500
}

export function SwarmCanvas({ agents, onSelect }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!mountRef.current) return
    const mount = mountRef.current
    const W = mount.clientWidth
    const H = mount.clientHeight

    // Set background color based on theme
    const themeBg = resolvedTheme === 'dark' ? '#000000' : '#ffffff';
    
    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(themeBg)

    // Camera
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000)
    camera.position.set(0, 0, 20)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(W, H)
    mount.appendChild(renderer.domElement)

    // Ambient light
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(10, 10, 10)
    scene.add(dirLight)

    // Agent spheres
    const spheres: { mesh: THREE.Mesh; agentId: string; vel: THREE.Vector3 }[] = []

    agents.forEach((agent, i) => {
      const angle = (i / agents.length) * Math.PI * 2
      const radius = 6
      const geo = new THREE.SphereGeometry(0.8, 32, 32)
      const mat = new THREE.MeshStandardMaterial({
        color: STATUS_COLORS[agent.status] ?? 0x93c5fd,
        emissive: STATUS_COLORS[agent.status] ?? 0x93c5fd,
        emissiveIntensity: 0.2,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(
        Math.cos(angle) * radius + (Math.random() - 0.5) * 2,
        Math.sin(angle) * radius + (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 4
      )
      mesh.userData = { agentId: agent.agentId }
      scene.add(mesh)
      spheres.push({
        mesh,
        agentId: agent.agentId,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 0.02,
          (Math.random() - 0.5) * 0.02,
          (Math.random() - 0.5) * 0.01,
        )
      })
    })

    // Center node (planner)
    const centerGeo = new THREE.SphereGeometry(1.2, 32, 32)
    const centerMat = new THREE.MeshStandardMaterial({
      color: 0x818cf8,
      emissive: 0x818cf8,
      emissiveIntensity: 0.4,
    })
    const center = new THREE.Mesh(centerGeo, centerMat)
    scene.add(center)

    // Lines from center to agents
    const lines: THREE.Line[] = []
    spheres.forEach(({ mesh }) => {
      const points = [center.position.clone(), mesh.position.clone()]
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points)
      const lineMat = new THREE.LineBasicMaterial({ color: 0x334155, opacity: 0.4, transparent: true })
      const line = new THREE.Line(lineGeo, lineMat)
      scene.add(line)
      lines.push(line)
    })

    // Camera state
    let theta = 0
    let phi = Math.PI / 2
    let radius = 20

    const updateCamera = () => {
      camera.position.x = radius * Math.sin(phi) * Math.sin(theta)
      camera.position.y = radius * Math.cos(phi)
      camera.position.z = radius * Math.sin(phi) * Math.cos(theta)
      camera.lookAt(0, 0, 0)
    }
    updateCamera()

    // Mouse drag (Orbit)
    let isDragging = false
    let prevMouse = { x: 0, y: 0 }

    const onMouseDown = (e: MouseEvent) => { isDragging = true; prevMouse = { x: e.clientX, y: e.clientY } }
    const onMouseUp = () => { isDragging = false }
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return
      const dx = e.clientX - prevMouse.x
      const dy = e.clientY - prevMouse.y
      prevMouse = { x: e.clientX, y: e.clientY }
      
      theta -= dx * 0.01
      phi -= dy * 0.01
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi)) // Constrain vertical rotation
      updateCamera()
    }
    
    const onWheel = (e: WheelEvent) => {
      radius = Math.max(5, Math.min(60, radius + e.deltaY * 0.02))
      updateCamera()
    }

    // Click to select
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    const onClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObjects(spheres.map(s => s.mesh))
      if (hits.length > 0) {
        const agentId = hits[0].object.userData.agentId
        onSelect?.(agentId)
      }
    }

    mount.addEventListener('mousedown', onMouseDown)
    mount.addEventListener('mouseup', onMouseUp)
    mount.addEventListener('mousemove', onMouseMove)
    mount.addEventListener('wheel', onWheel)
    mount.addEventListener('click', onClick)

    // Animation
    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)

      // Swarm hareketi
      spheres.forEach(({ mesh, vel }, i) => {
        mesh.position.add(vel)
        // Sınırda geri döndür
        if (Math.abs(mesh.position.x) > 10) vel.x *= -1
        if (Math.abs(mesh.position.y) > 10) vel.y *= -1
        if (Math.abs(mesh.position.z) > 5) vel.z *= -1

        // Line güncelle
        const line = lines[i]
        if (line) {
          const pos = line.geometry.attributes.position
          pos.setXYZ(1, mesh.position.x, mesh.position.y, mesh.position.z)
          pos.needsUpdate = true
        }
      })

      // Center titreme
      center.position.set(
        Math.sin(Date.now() * 0.001) * 0.1,
        Math.cos(Date.now() * 0.0013) * 0.1,
        0
      )

      renderer.render(scene, camera)
    }
    animate()

    // Resize
    const onResize = () => {
      const W = mount.clientWidth
      const H = mount.clientHeight
      camera.aspect = W / H
      camera.updateProjectionMatrix()
      renderer.setSize(W, H)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(animId)
      mount.removeEventListener('mousedown', onMouseDown)
      mount.removeEventListener('mouseup', onMouseUp)
      mount.removeEventListener('mousemove', onMouseMove)
      mount.removeEventListener('wheel', onWheel)
      mount.removeEventListener('click', onClick)
      window.removeEventListener('resize', onResize)
      mount.removeChild(renderer.domElement)
      renderer.dispose()
    }
  }, [agents, resolvedTheme])

  return <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
}
