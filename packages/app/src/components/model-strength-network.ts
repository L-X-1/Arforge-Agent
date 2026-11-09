type Point = readonly [number, number, number]
type Color = readonly [number, number, number]
type Link = { a: number; b: number; enabled: number[] }

const seed: Point = [0, 0, 0]
const low: Point[] = [
  seed,
  [-0.34, 0.14, 0.03],
  [-0.55, -0.08, 0.21],
  [-0.36, -0.43, 0.14],
  [0.09, -0.47, 0.08],
  [0.53, -0.22, -0.12],
]
const high: Point[] = [
  seed,
  [-0.45, 0.04, 0.19],
  [-0.76, -0.18, 0.12],
  [-0.59, -0.49, -0.11],
  [-0.3, -0.43, 0.11],
  [0.7, -0.27, 0.16],
  [0.34, -0.47, 0.09],
  [0.43, 0.09, 0.22],
  [0.79, 0.12, -0.13],
  [0.6, 0.45, 0.05],
  [0.28, 0.35, -0.09],
  [-0.31, 0.38, 0.09],
  [-0.66, 0.35, -0.06],
  [-0.84, 0.12, -0.15],
  [0.86, -0.04, -0.22],
  [0.12, -0.18, 0.28],
]
// The full form distributes 29 nodes around the central seed on a Fibonacci sphere.
const full: Point[] = [
  seed,
  ...Array.from({ length: 29 }, (_, index): Point => {
    const y = 1 - (2 * (index + 0.5)) / 29
    const radius = Math.sqrt(1 - y * y)
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    return [0.86 * radius * Math.cos(angle), 0.82 * y, 0.86 * radius * Math.sin(angle)]
  }),
]
const forms = [[seed], low, high, full]

function networkLinks() {
  const links = new Map<string, Link>()
  const link = (a: number, b: number, level: number) => {
    const key = a < b ? `${a}/${b}` : `${b}/${a}`
    const entry = links.get(key) ?? { a, b, enabled: [0, 0, 0, 0] }
    entry.enabled[level] = 1
    links.set(key, entry)
  }
  for (let i = 1; i < low.length; i++) link(i - 1, i, 1)
  for (const [level, nodes, degree] of [
    [2, high, 2],
    [3, full, 3],
  ] as const) {
    nodes.forEach(([x, y, z], i) => {
      const nearest = nodes
        .map(([nx, ny, nz], j) => ({ j, distance: (x - nx) ** 2 + (y - ny) ** 2 + (z - nz) ** 2 }))
        .filter(({ j }) => j !== i && (i === 0 || j !== 0))
        .sort((a, b) => a.distance - b.distance)
      for (const { j } of nearest.slice(0, i === 0 ? degree + 3 : degree)) link(i, j, level)
    })
    if (level === 2)
      for (const [a, b] of [
        [0, 1],
        [0, 7],
        [4, 6],
        [1, 11],
        [7, 10],
        [0, 15],
      ])
        link(a, b, level)
  }
  return [...links.values()]
}

const links = networkLinks()
const light: Color[] = [
  [27, 135, 103],
  [29, 124, 156],
  [174, 114, 41],
]
const dark: Color[] = [
  [117, 238, 193],
  [128, 207, 248],
  [250, 210, 142],
]
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const rgba = (color: Color, alpha: number) => `rgba(${color.join(",")},${Math.min(1, Math.max(0, alpha))})`

export function paintStrengthNetwork(
  ctx: CanvasRenderingContext2D,
  view: { level: number; time: number; tiltX: number; tiltY: number; dark: boolean; wave: number; spin: number },
) {
  const { level, time, tiltX, tiltY, dark: darkMode, wave, spin } = view
  const { width, height } = ctx.canvas
  const scale = height * 0.327
  ctx.clearRect(0, 0, width, height)
  ctx.save()
  ctx.translate(width / 2, height * 0.472)
  ctx.scale(scale, scale)
  ctx.lineCap = "round"
  const lower = forms[Math.floor(level)]
  const upper = forms[Math.ceil(level)]
  const blend = level - Math.floor(level)
  const rotation = 0.47 + Math.sin(time * 0.43) * 0.22 + spin + tiltX * 0.48
  const elevation = -0.12 + tiltY * 0.44
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const cx = Math.cos(elevation)
  const sx = Math.sin(elevation)
  const colors = darkMode ? dark : light
  const palette = (index: number) => colors[index % colors.length]
  const points = full.slice(0, upper.length).map((_, i) => {
    const a = lower[i] ?? seed
    const b = upper[i]
    const x = lerp(a[0], b[0], blend)
    const y = lerp(a[1], b[1], blend)
    const z = lerp(a[2], b[2], blend)
    const rz = z * cos - x * sin
    const depth = y * sx + rz * cx
    const perspective = 1 + depth * 0.18
    return {
      x: (x * cos + z * sin) * perspective,
      y: (y * cx - rz * sx) * perspective,
      depth,
      alpha: lerp(i < lower.length ? 1 : 0, 1, blend),
      i,
    }
  })

  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, level ? 0.95 : 0.34)
  halo.addColorStop(0, rgba(palette(0), darkMode ? 0.18 : 0.13))
  halo.addColorStop(1, rgba(palette(0), 0))
  ctx.fillStyle = halo
  ctx.fillRect(-1, -1, 2, 2)
  if (wave < 1) {
    ctx.beginPath()
    ctx.arc(0, 0, 0.14 + wave * 1.04, 0, 2 * Math.PI)
    ctx.strokeStyle = rgba(palette(0), (1 - wave) * 0.48)
    ctx.lineWidth = 0.012
    ctx.stroke()
  }

  const geometry = links.flatMap(({ a, b, enabled }) => {
    const alpha = lerp(enabled[Math.floor(level)], enabled[Math.ceil(level)], blend)
    if (alpha < 0.006) return []
    const p = points[a]
    const q = points[b]
    return [{ a, b, p, q, alpha, depth: (p.depth + q.depth) / 2 }]
  })
  geometry.sort((a, b) => a.depth - b.depth)
  for (const { a, b, p, q, alpha, depth } of geometry) {
    const color = palette(a + b * 2)
    const bend = (a + b) % 2 ? 0.15 : -0.15
    const mx = (p.x + q.x) / 2 + (q.y - p.y) * bend
    const my = (p.y + q.y) / 2 - (q.x - p.x) * bend
    const strength = alpha * (0.4 + (depth + 0.9) * 0.26)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    ctx.quadraticCurveTo(mx, my, q.x, q.y)
    ctx.strokeStyle = rgba(color, strength * (darkMode ? 0.9 : 0.77))
    ctx.lineWidth = 0.011 + Math.max(0, depth) * 0.009
    ctx.stroke()

    const phase = (time * (0.56 + (a % 5) * 0.064) + (a * 3 + b * 7) * 0.081) % 1
    if ((a + b) % 3 || phase > 0.8) continue
    const along = (t: number) => ({
      x: (1 - t) ** 2 * p.x + 2 * t * (1 - t) * mx + t * t * q.x,
      y: (1 - t) ** 2 * p.y + 2 * t * (1 - t) * my + t * t * q.y,
    })
    const tip = along(phase / 0.8)
    const tail = along(Math.max(0, phase / 0.8 - 0.17))
    const flow = ctx.createLinearGradient(tail.x, tail.y, tip.x + 0.0001, tip.y)
    flow.addColorStop(0, rgba(color, 0))
    flow.addColorStop(1, rgba(color, alpha * 0.96))
    ctx.beginPath()
    ctx.moveTo(tail.x, tail.y)
    ctx.lineTo(tip.x, tip.y)
    ctx.strokeStyle = flow
    ctx.lineWidth = 0.022
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(tip.x, tip.y, 0.014, 0, 2 * Math.PI)
    ctx.fillStyle = rgba(darkMode ? [223, 255, 240] : color, alpha)
    ctx.fill()
  }

  points.sort((a, b) => a.depth - b.depth)
  for (const { x, y, depth, alpha, i } of points) {
    if (alpha < 0.006) continue
    const color = i || level ? palette(i) : darkMode ? ([172, 191, 162] as const) : ([86, 111, 82] as const)
    const front = (depth + 0.9) / 1.8
    const size = i ? 0.025 + front * 0.021 : 0.05
    const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 3.15)
    glow.addColorStop(0, rgba(color, alpha * (darkMode ? 0.74 : 0.4)))
    glow.addColorStop(1, rgba(color, 0))
    ctx.fillStyle = glow
    ctx.fillRect(x - size * 3.2, y - size * 3.2, size * 6.4, size * 6.4)
    ctx.beginPath()
    ctx.arc(x, y, size, 0, 2 * Math.PI)
    ctx.fillStyle = rgba(color, alpha * (0.52 + front * 0.46))
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, size * 0.41, 0, 2 * Math.PI)
    ctx.fillStyle = rgba([245, 255, 246], alpha * (0.55 + front * 0.38))
    ctx.fill()
  }
  ctx.restore()
}
