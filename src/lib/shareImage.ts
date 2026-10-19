import QRCode from 'qrcode'

// Draws a cook's ready-to-post social images in the browser: a full-photo
// story (1080x1920, Instagram/WhatsApp) and a clean square post (1080x1080).
// Nothing is uploaded; the cook saves or shares the picture straight away.

export type ShareImageInput = {
  shopName: string
  shopLogo: string | null // image address, or null for the shop's first letter
  dishName: string
  price: string // e.g. "£3.50 · Box of 4"
  photo: string | null
  url: string // full shop link, e.g. https://food.beastcase.net/s/amas-kitchen
}
export type ShareSize = 'story' | 'square'

const YELLOW = '#FFC72C'
const BLACK = '#111111'
const OFF_WHITE = '#FFFDF7'
const MUTED = '#5F5F5F'
const FONT = "'Inter Variable', Inter, system-ui, sans-serif"

// SVG pictures are drawn at their small built-in size and then stretched,
// which looks blurry, so they're given a large size first.
async function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (/\.svg(\?|$)/i.test(src)) {
    try {
      const text = await (await fetch(src)).text()
      const big = text.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) =>
        `<svg${attrs.replace(/\s(width|height)="[^"]*"/gi, '')} width="1600" height="1600" preserveAspectRatio="xMidYMid slice">`)
      const img = await loadPlain(URL.createObjectURL(new Blob([big], { type: 'image/svg+xml' })))
      if (img) return img
    } catch { /* fall through */ }
  }
  return loadPlain(src)
}
function loadPlain(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

// Draws `img` to fill the box, cropping the overflow (like CSS object-fit: cover).
function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const iw = img.naturalWidth || img.width || w
  const ih = img.naturalHeight || img.height || h
  const scale = Math.max(w / iw, h / ih)
  const sw = w / scale
  const sh = h / scale
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h)
}

// Breaks text into at most `maxLines` lines that fit `width`, ending with … if cut.
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= width || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    let last = lines[maxLines - 1]
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1)
    lines[maxLines - 1] = `${last.trimEnd()}…`
  }
  return lines
}

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text
  let t = text
  while (t && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

// The shop's logo in a circle, or its first letter on yellow.
function shopBadge(ctx: CanvasRenderingContext2D, logo: HTMLImageElement | null, name: string, x: number, y: number, size: number) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  ctx.fillStyle = YELLOW
  ctx.fill()
  ctx.clip()
  if (logo) cover(ctx, logo, x, y, size, size)
  else {
    ctx.fillStyle = BLACK
    ctx.font = `800 ${Math.round(size * 0.45)}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((name.trim()[0] ?? '?').toUpperCase(), x + size / 2, y + size / 2 + 2)
  }
  ctx.restore()
  ctx.beginPath()
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  ctx.lineWidth = Math.max(3, size * 0.05)
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
}

// BiteBY logo on an off-white pill.
function logoPill(ctx: CanvasRenderingContext2D, logo: HTMLImageElement | null, right: number, top: number, height: number) {
  if (!logo) return
  const logoH = height * 0.66
  const logoW = (logo.naturalWidth / logo.naturalHeight) * logoH
  const padX = height * 0.42
  const w = logoW + padX * 2
  ctx.fillStyle = OFF_WHITE
  roundRect(ctx, right - w, top, w, height, height / 2)
  ctx.fill()
  ctx.drawImage(logo, right - w + padX, top + (height - logoH) / 2, logoW, logoH)
}

async function qrImage(url: string) {
  const data = await QRCode.toDataURL(url, { width: 600, margin: 0, errorCorrectionLevel: 'M', color: { dark: BLACK, light: '#ffffff' } })
  return loadImage(data)
}

export async function drawShareImage(canvas: HTMLCanvasElement, size: ShareSize, input: ShareImageInput) {
  try {
    await Promise.all([document.fonts.load(`800 60px ${FONT}`), document.fonts.load(`600 40px ${FONT}`), document.fonts.load(`500 30px ${FONT}`)])
  } catch { /* falls back to the system font */ }
  const [photo, shopLogo, logo, verified, qr] = await Promise.all([
    input.photo ? loadImage(input.photo) : Promise.resolve(null),
    input.shopLogo ? loadImage(input.shopLogo) : Promise.resolve(null),
    loadImage('/logo-share.png'),
    loadImage('/verified.png'),
    qrImage(input.url),
  ])
  const shortUrl = input.url.replace(/^https?:\/\//, '').replace(/\?.*$/, '')
  if (size === 'story') story(canvas, input, shortUrl, { photo, shopLogo, logo, verified, qr })
  else square(canvas, input, shortUrl, { photo, shopLogo, logo, verified, qr })
}

type Images = { photo: HTMLImageElement | null; shopLogo: HTMLImageElement | null; logo: HTMLImageElement | null; verified: HTMLImageElement | null; qr: HTMLImageElement | null }

function shopRow(ctx: CanvasRenderingContext2D, input: ShareImageInput, im: Images, x: number, y: number, badge: number, fontPx: number, colour: string, maxW: number) {
  shopBadge(ctx, im.shopLogo, input.shopName, x, y, badge)
  ctx.font = `600 ${fontPx}px ${FONT}`
  ctx.fillStyle = colour
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const tick = fontPx * 1.05
  const name = fitText(ctx, input.shopName, maxW - badge - 24 - tick - 12)
  const nx = x + badge + 22
  ctx.fillText(name, nx, y + badge / 2 + 1)
  if (im.verified) ctx.drawImage(im.verified, nx + ctx.measureText(name).width + 12, y + (badge - tick) / 2, tick, tick)
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, h: number, fontPx: number, bg: string, fg: string, weight = 700) {
  ctx.font = `${weight} ${fontPx}px ${FONT}`
  const w = ctx.measureText(text).width + h * 0.9
  ctx.fillStyle = bg
  roundRect(ctx, x, y, w, h, h / 2)
  ctx.fill()
  ctx.fillStyle = fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + w / 2, y + h / 2 + 1)
  return w
}

// Style 3: the dish fills the screen, details over a dark fade at the bottom.
function story(canvas: HTMLCanvasElement, input: ShareImageInput, shortUrl: string, im: Images) {
  const W = 1080
  const H = 1920
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#2a2420'
  ctx.fillRect(0, 0, W, H)
  if (im.photo) cover(ctx, im.photo, 0, 0, W, H)

  let g = ctx.createLinearGradient(0, 0, 0, 420)
  g.addColorStop(0, 'rgba(0,0,0,0.55)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, 420)
  g = ctx.createLinearGradient(0, H * 0.42, 0, H)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(0.45, 'rgba(0,0,0,0.6)')
  g.addColorStop(1, 'rgba(0,0,0,0.9)')
  ctx.fillStyle = g
  ctx.fillRect(0, H * 0.42, W, H * 0.58)

  const pad = 72
  logoPill(ctx, im.logo, W - pad, 146, 104)
  shopRow(ctx, input, im, pad, 150, 96, 44, '#ffffff', W - pad * 2 - 300)

  // Bottom block, laid out upwards from the link line.
  const urlY = H - 150
  const qrSize = 230
  const qrX = W - pad - qrSize
  const qrY = urlY - 60 - qrSize
  ctx.fillStyle = '#ffffff'
  roundRect(ctx, qrX - 18, qrY - 18, qrSize + 36, qrSize + 36, 28)
  ctx.fill()
  if (im.qr) ctx.drawImage(im.qr, qrX, qrY, qrSize, qrSize)

  const btnH = 112
  const btnY = qrY + qrSize - btnH + 18
  pill(ctx, 'Order on BiteBY', pad, btnY, btnH, 46, YELLOW, BLACK, 700)

  ctx.font = `500 34px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(fitText(ctx, shortUrl, W - pad * 2), pad, urlY)

  const textW = W - pad * 2
  ctx.font = `500 46px ${FONT}`
  const priceY = qrY - 90
  ctx.fillStyle = '#ffffff'
  ctx.fillText(fitText(ctx, input.price, textW), pad, priceY)

  ctx.font = `800 104px ${FONT}`
  const lines = wrap(ctx, input.dishName, textW, 3)
  const lineH = 112
  let y = priceY - 50 - (lines.length - 1) * lineH - lineH / 2
  ctx.textBaseline = 'middle'
  for (const line of lines) {
    ctx.fillText(line, pad, y)
    y += lineH
  }
  const tagY = priceY - 50 - (lines.length - 1) * lineH - lineH - 84
  pill(ctx, 'Homemade · Order now', pad, tagY, 70, 32, YELLOW, BLACK, 600)
}

// Style 1: off-white card with the photo on top and the QR code beside the details.
function square(canvas: HTMLCanvasElement, input: ShareImageInput, shortUrl: string, im: Images) {
  const W = 1080
  const H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = OFF_WHITE
  ctx.fillRect(0, 0, W, H)

  const pad = 60
  const photoH = 520
  ctx.save()
  roundRect(ctx, pad, pad, W - pad * 2, photoH, 40)
  ctx.clip()
  ctx.fillStyle = '#efe7d6'
  ctx.fillRect(pad, pad, W - pad * 2, photoH)
  if (im.photo) cover(ctx, im.photo, pad, pad, W - pad * 2, photoH)
  ctx.restore()
  logoPill(ctx, im.logo, W - pad - 28, pad + 28, 80)

  // QR card on the right.
  const qrBox = 300
  const boxX = W - pad - qrBox
  const boxY = pad + photoH + 40
  ctx.fillStyle = '#ffffff'
  roundRect(ctx, boxX, boxY, qrBox, H - pad - boxY, 32)
  ctx.fill()
  ctx.strokeStyle = '#ece6d8'
  ctx.lineWidth = 3
  ctx.stroke()
  const qrSize = 220
  const qrTop = boxY + (H - pad - boxY - qrSize - 66) / 2
  if (im.qr) ctx.drawImage(im.qr, boxX + (qrBox - qrSize) / 2, qrTop, qrSize, qrSize)
  ctx.font = `700 30px ${FONT}`
  ctx.fillStyle = BLACK
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('Scan to order', boxX + qrBox / 2, qrTop + qrSize + 48)

  // Details on the left.
  const left = pad
  const textW = boxX - left - 40
  shopRow(ctx, input, im, left, boxY + 4, 72, 34, BLACK, textW)
  ctx.font = `800 54px ${FONT}`
  ctx.fillStyle = BLACK
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const lines = wrap(ctx, input.dishName, textW, 2)
  let y = boxY + 72 + 52
  for (const line of lines) {
    ctx.fillText(line, left, y)
    y += 60
  }
  ctx.font = `500 34px ${FONT}`
  ctx.fillStyle = MUTED
  ctx.fillText(fitText(ctx, input.price, textW), left, y - 4)

  pill(ctx, 'Order on BiteBY', left, H - pad - 120, 60, 28, YELLOW, BLACK, 700)
  ctx.font = `500 26px ${FONT}`
  ctx.fillStyle = MUTED
  ctx.textAlign = 'left'
  ctx.fillText(fitText(ctx, shortUrl, textW), left, H - pad - 20)
}

export function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
}
