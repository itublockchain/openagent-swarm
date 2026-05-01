'use client'

import { useEffect, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { useTheme } from 'next-themes'

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 aRand;

  uniform float uTime;
  uniform vec2  uMouse;
  uniform float uMouseRadius;
  uniform float uMouseStrength;
  uniform float uPixelRatio;
  uniform float uPointSize;
  uniform float uDriftAmp;

  void main() {
    vec3 home = position;

    float t = uTime;
    vec2 drift = vec2(
      sin(t * 0.6 + aRand.x * 6.2831) + cos(t * 0.4 + aRand.y * 3.1415) * 0.5,
      cos(t * 0.5 + aRand.y * 6.2831) + sin(t * 0.3 + aRand.x * 3.1415) * 0.5
    ) * uDriftAmp;

    vec3 displaced = vec3(home.xy + drift, home.z);

    vec2 fromMouse = displaced.xy - uMouse;
    float dist = length(fromMouse);
    if (dist < uMouseRadius && dist > 0.0001) {
      // Smoothstep S-curve gives a soft bell: zero slope at both center and edge,
      // so particles ease in/out instead of snapping at the radius boundary.
      float t = 1.0 - dist / uMouseRadius;
      float falloff = smoothstep(0.0, 1.0, t);
      displaced.xy += normalize(fromMouse) * falloff * uMouseStrength;
    }

    vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * mvPos;
    gl_PointSize = uPointSize * uPixelRatio;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform vec3  uColor;
  uniform float uOpacity;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float alpha = smoothstep(0.5, 0.42, d);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha * uOpacity);
  }
`

type SamplingOptions = {
  width: number
  height: number
  step: number
  text: string
  sizeRatio: number
  maxSize: number
  yOffset: number
  alignBottomPx: number | null
}

function samplePositions({ width, height, step, text, sizeRatio, maxSize, yOffset, alignBottomPx }: SamplingOptions): Float32Array {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return new Float32Array()

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = 'white'
  ctx.textAlign = 'center'

  // Scale with viewport width, capped so it doesn't get absurd on ultrawide.
  // Also ensure it fits vertically — caps to 80% of section height.
  const fontSize = Math.min(width * sizeRatio, maxSize, height * 0.8)
  ctx.font = `900 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`

  if (alignBottomPx != null) {
    // Anchor SPORE letters' visual bottom to a target Y. 'alphabetic' baseline puts
    // the y coord on the cap-baseline; for all-caps no-descender words like SPORE,
    // that's the visible bottom.
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, width / 2, alignBottomPx)
  } else {
    ctx.textBaseline = 'middle'
    // yOffset is a fraction of section height; negative shifts text upward.
    ctx.fillText(text, width / 2, height / 2 + yOffset * height)
  }

  const data = ctx.getImageData(0, 0, width, height).data
  const positions: number[] = []

  // Convert to centered world coords with y flipped (canvas y grows down, world y grows up).
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4 + 3
      if (data[idx] > 128) {
        const jitterX = (Math.random() - 0.5) * step * 0.6
        const jitterY = (Math.random() - 0.5) * step * 0.6
        positions.push(
          x - width / 2 + jitterX,
          height / 2 - y + jitterY,
          0,
        )
      }
    }
  }

  return new Float32Array(positions)
}

function sampleRands(count: number): Float32Array {
  const arr = new Float32Array(count * 2)
  for (let i = 0; i < arr.length; i++) arr[i] = Math.random()
  return arr
}

type SporeTextBackdropProps = {
  text?: string
  sizeRatio?: number
  maxSize?: number
  pointSize?: number
  /** Fraction of section height. Negative shifts text upward; e.g. -0.18 pulls up by 18%. */
  yOffset?: number
  /** When set, text bottom is aligned to the bottom of this element. Overrides yOffset. */
  alignBottomToRef?: RefObject<HTMLElement | null>
}

export function SporeTextBackdrop({
  text = 'SPORE',
  sizeRatio = 0.22,
  maxSize = 280,
  pointSize = 2.8,
  yOffset = 0,
  alignBottomToRef,
}: SporeTextBackdropProps = {}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const uniformsRef = useRef<Record<string, THREE.IUniform> | null>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let width = mount.clientWidth || 1
    let height = mount.clientHeight || 1

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(
      -width / 2, width / 2, height / 2, -height / 2, -1000, 1000,
    )
    camera.position.z = 10

    const themeColor = new THREE.Color(resolvedTheme === 'dark' ? 0xe2e8f0 : 0x000000)

    const uniforms: Record<string, THREE.IUniform> = {
      uTime:          { value: 0 },
      uMouse:         { value: new THREE.Vector2(99999, 99999) },
      uMouseRadius:   { value: 170 },
      uMouseStrength: { value: 26 },
      uPixelRatio:    { value: dpr },
      uPointSize:     { value: pointSize },
      uDriftAmp:      { value: 3.8 },
      uColor:         { value: themeColor },
      uOpacity:       { value: resolvedTheme === 'dark' ? 0.9 : 0.95 },
    }
    uniformsRef.current = uniforms

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms,
      transparent: true,
      depthWrite: false,
    })

    let geometry: THREE.BufferGeometry | null = null
    let points: THREE.Points | null = null

    const computeAlignBottomPx = (): number | null => {
      const target = alignBottomToRef?.current
      if (!target) return null
      const tRect = target.getBoundingClientRect()
      const mRect = mount.getBoundingClientRect()
      return tRect.bottom - mRect.top
    }

    const buildPoints = () => {
      if (points) {
        scene.remove(points)
        geometry?.dispose()
      }
      // Density: bigger viewport → larger step (fewer, bigger gaps) so particle count stays stable.
      const step = width < 640 ? 4 : width < 1024 ? 5 : 6
      const positions = samplePositions({
        width: Math.max(width, 320),
        height: Math.max(height, 240),
        step,
        text,
        sizeRatio,
        maxSize,
        yOffset,
        alignBottomPx: computeAlignBottomPx(),
      })
      const count = positions.length / 3
      const rands = sampleRands(count)

      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('aRand', new THREE.BufferAttribute(rands, 2))

      points = new THREE.Points(geometry, material)
      scene.add(points)
    }

    buildPoints()

    // Lerped mouse: targetMouse is set instantly from pointer events; the uniform
    // is eased toward it each frame. Smooths over fast pointer flicks and gives
    // particles a slight inertia/trail feel instead of snapping to the cursor.
    const targetMouse = new THREE.Vector2(99999, 99999)
    const onMouseMove = (e: MouseEvent) => {
      const rect = mount.getBoundingClientRect()
      const insideX = e.clientX >= rect.left && e.clientX <= rect.right
      const insideY = e.clientY >= rect.top && e.clientY <= rect.bottom
      if (!insideX || !insideY) {
        targetMouse.set(99999, 99999)
        return
      }
      const localX = e.clientX - rect.left - rect.width / 2
      const localY = -(e.clientY - rect.top - rect.height / 2)
      targetMouse.set(localX, localY)
    }
    const onMouseLeave = () => targetMouse.set(99999, 99999)
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('mouseleave', onMouseLeave)

    // Resize via ResizeObserver — debounced rebuild of particles to avoid thrashing.
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRebuild = () => {
      if (rebuildTimer) clearTimeout(rebuildTimer)
      rebuildTimer = setTimeout(buildPoints, 120)
    }
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (w !== width || h !== height) {
        width = w || width
        height = h || height
        renderer.setSize(width, height, false)
        camera.left   = -width / 2
        camera.right  =  width / 2
        camera.top    =  height / 2
        camera.bottom = -height / 2
        camera.updateProjectionMatrix()
      }
      scheduleRebuild()
    })
    ro.observe(mount)
    if (alignBottomToRef?.current) ro.observe(alignBottomToRef.current)

    // Pause when tab hidden.
    let visible = !document.hidden
    const onVisibility = () => { visible = !document.hidden }
    document.addEventListener('visibilitychange', onVisibility)

    let raf = 0
    const start = performance.now()
    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!visible) return
      if (!reduceMotion) {
        uniforms.uTime.value = (performance.now() - start) * 0.001
      }
      // Ease the shader's mouse uniform toward the real cursor. 0.12 is slow
      // enough to feel like the field has weight, fast enough not to lag.
      const m = uniforms.uMouse.value as THREE.Vector2
      m.x += (targetMouse.x - m.x) * 0.12
      m.y += (targetMouse.y - m.y) * 0.12
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseleave', onMouseLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
      if (rebuildTimer) clearTimeout(rebuildTimer)
      geometry?.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
      uniformsRef.current = null
    }
    // resolvedTheme intentionally excluded — handled in a separate effect that just
    // updates uniforms without re-initializing the WebGL context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, sizeRatio, maxSize, pointSize, yOffset, alignBottomToRef])

  useEffect(() => {
    const u = uniformsRef.current
    if (!u) return
    const isDark = resolvedTheme === 'dark'
    ;(u.uColor.value as THREE.Color).set(isDark ? 0xe2e8f0 : 0x000000)
    u.uOpacity.value = isDark ? 0.9 : 0.95
  }, [resolvedTheme])

  return (
    <div
      ref={mountRef}
      aria-hidden
      className="absolute inset-0 pointer-events-none [mask-image:radial-gradient(ellipse_at_center,black_55%,transparent_85%)]"
    />
  )
}
