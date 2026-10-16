import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { encodeCanvas } from './images'

type Props = {
  file: File
  aspect: number // width ÷ height of the finished picture
  round?: boolean // shows a circle guide, for profile pictures and logos
  width: number // pixel width of the finished picture
  jpeg?: boolean // for pictures used in link previews
  title: string
  hint?: string
  onCancel: () => void
  onDone: (blob: Blob) => void
}

type View = { x: number; y: number; zoom: number }

// Full-screen crop: drag to move, pinch, scroll or use the slider to zoom.
// The frame shows exactly what will be saved.
export function ImageCropper({ file, aspect, round, width, jpeg, title, hint, onCancel, onDone }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [frame, setFrame] = useState({ w: 300, h: 300 / aspect })
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })
  const stage = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)

  // Load the photo.
  useEffect(() => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => setImg(image)
    image.onerror = () => setError('This file isn’t a photo we can open. Try a JPEG or PNG.')
    image.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  // Size the frame to the screen.
  useEffect(() => {
    const fit = () => {
      const maxW = Math.min(window.innerWidth - 32, 520)
      const maxH = window.innerHeight * 0.55
      const w = Math.min(maxW, maxH * aspect)
      setFrame({ w, h: w / aspect })
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [aspect])

  // Stop the page scrolling behind the cropper.
  useEffect(() => {
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = before }
  }, [])

  // The smallest scale at which the photo still fills the frame.
  const base = img ? Math.max(frame.w / img.naturalWidth, frame.h / img.naturalHeight) : 1
  const scale = base * view.zoom
  const drawnW = (img?.naturalWidth ?? 0) * scale
  const drawnH = (img?.naturalHeight ?? 0) * scale

  // Keep the photo covering the frame: no empty edges.
  function clamp(v: View): View {
    if (!img) return v
    const zoom = Math.min(5, Math.max(1, v.zoom))
    const w = img.naturalWidth * base * zoom
    const h = img.naturalHeight * base * zoom
    return { zoom, x: Math.min(0, Math.max(frame.w - w, v.x)), y: Math.min(0, Math.max(frame.h - h, v.y)) }
  }

  // Start centred whenever the photo or frame changes.
  useEffect(() => {
    if (!img) return
    const w = img.naturalWidth * base
    const h = img.naturalHeight * base
    setView({ zoom: 1, x: (frame.w - w) / 2, y: (frame.h - h) / 2 })
  }, [img, base, frame.w, frame.h])

  // Zoom around a point in the frame, so what's under your fingers stays put.
  function zoomTo(zoom: number, cx = frame.w / 2, cy = frame.h / 2) {
    setView((v) => {
      const z = Math.min(5, Math.max(1, zoom))
      const k = z / v.zoom
      return clamp({ zoom: z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k })
    })
  }

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function down(e: ReactPointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, local(e))
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom }
    }
  }

  function move(e: ReactPointerEvent) {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const now = local(e)
    pointers.current.set(e.pointerId, now)
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      zoomTo(pinch.current.zoom * (dist / pinch.current.dist), (a.x + b.x) / 2, (a.y + b.y) / 2)
    } else if (pointers.current.size === 1) {
      setView((v) => clamp({ ...v, x: v.x + now.x - prev.x, y: v.y + now.y - prev.y }))
    }
  }

  function up(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }

  // Mouse wheel and trackpad zoom.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(view.zoom * Math.exp(-e.deltaY / 400), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  function nudge(dx: number, dy: number) {
    setView((v) => clamp({ ...v, x: v.x + dx, y: v.y + dy }))
  }

  async function save() {
    if (!img) return
    setBusy(true)
    setError('')
    try {
      // Never upscale: a small photo gives a smaller (but sharp) picture.
      const srcW = frame.w / scale
      const outW = Math.round(Math.min(width, srcW))
      const outH = Math.round(outW / aspect)
      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, outW, outH)
      ctx.drawImage(img, -view.x / scale, -view.y / scale, srcW, frame.h / scale, 0, 0, outW, outH)
      onDone(await encodeCanvas(canvas, jpeg ? ['image/jpeg'] : undefined))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="cropper" role="dialog" aria-modal="true" aria-label={title}>
      <div className="cropper-head">
        <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <strong>{title}</strong>
        <button type="button" className="link-btn strong" onClick={save} disabled={!img || busy}>{busy ? 'Saving…' : 'Use photo'}</button>
      </div>
      <div className="cropper-body">
        <div
          ref={stage}
          className={`crop-stage ${round ? 'round' : ''}`}
          style={{ width: frame.w, height: frame.h }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          tabIndex={0}
          aria-label="Photo. Drag to move it, or use the arrow keys."
          onKeyDown={(e) => {
            const step = e.shiftKey ? 40 : 10
            if (e.key === 'ArrowLeft') nudge(step, 0)
            else if (e.key === 'ArrowRight') nudge(-step, 0)
            else if (e.key === 'ArrowUp') nudge(0, step)
            else if (e.key === 'ArrowDown') nudge(0, -step)
            else if (e.key === '+' || e.key === '=') zoomTo(view.zoom * 1.1)
            else if (e.key === '-') zoomTo(view.zoom / 1.1)
            else return
            e.preventDefault()
          }}
        >
          {img && (
            <img src={img.src} alt="" draggable={false}
              style={{ width: drawnW, height: drawnH, transform: `translate(${view.x}px, ${view.y}px)` }} />
          )}
          <span className="crop-grid" aria-hidden="true" />
        </div>
        {!img && !error && <p className="muted">Opening photo…</p>}
        <label className="crop-zoom">
          <span aria-hidden="true">−</span>
          <input type="range" min={1} max={5} step={0.01} value={view.zoom} onChange={(e) => zoomTo(Number(e.target.value))} aria-label="Zoom" />
          <span aria-hidden="true">+</span>
        </label>
        <p className="crop-hint">{hint ?? 'Drag to move. Pinch or use the slider to zoom.'}</p>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
