// Regenerate the app-icon rasters from the SVG source of truth (SPEC §14):
// app/electron/icon/icon.svg → icon.png (1024 px, rasterized via Electron's own
// Chromium so the render matches the in-app <img> exactly) → icon.ico (the §3
// Windows app/installer icon: PNG-compressed entries at 256/128/64/48/32/16 px,
// each rendered from the same SVG at its native size) → icon.icns
// (sips + iconutil). Run from app/: ./node_modules/.bin/electron ../scripts/gen_icon.cjs
const { app, BrowserWindow } = require('electron')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ICON_DIR = path.join(__dirname, '..', 'app', 'electron', 'icon')
const SVG = path.join(ICON_DIR, 'icon.svg')
const PNG = path.join(ICON_DIR, 'icon.png')
const ICO = path.join(ICON_DIR, 'icon.ico')
const ICNS = path.join(ICON_DIR, 'icon.icns')
const SIZE = 1024
const ICO_SIZES = [256, 128, 64, 48, 32, 16]

const SVG_B64 = fs.readFileSync(SVG).toString('base64')
const draw = (size) => `
  (async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,${SVG_B64}'
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = ${size}
    c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
    return c.toDataURL('image/png')
  })()
`
const DRAW = draw(SIZE)

// Pack PNG blobs into an ICO container: ICONDIR header, one 16-byte ICONDIRENTRY
// per image, then the PNG payloads. 256 px encodes as a width/height byte of 0.
const buildIco = (images) => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, png }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e + 0) // width
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1) // height
    dir.writeUInt8(0, e + 2) // palette colors (0 = truecolor)
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // color planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(png.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((im) => im.png)])
}

setTimeout(() => { console.error('timed out'); process.exit(1) }, 20000)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  await win.loadURL('data:text/html,<html></html>')
  const dataUrl = await win.webContents.executeJavaScript(DRAW)
  fs.writeFileSync(PNG, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('wrote ' + PNG)

  const icoImages = []
  for (const size of ICO_SIZES) {
    const url = await win.webContents.executeJavaScript(draw(size))
    icoImages.push({ size, png: Buffer.from(url.split(',')[1], 'base64') })
  }
  fs.writeFileSync(ICO, buildIco(icoImages))
  console.log('wrote ' + ICO)

  // icns needs sips/iconutil — macOS-only tools, so each host renders what it
  // can (Chromium output is not byte-identical across OSes anyway: same
  // geometry, different edge antialiasing).
  if (process.platform === 'darwin') {
    const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-icon-')) + '/icon.iconset'
    fs.mkdirSync(iconset)
    for (const s of [16, 32, 128, 256, 512]) {
      execSync(`sips -z ${s} ${s} "${PNG}" --out "${iconset}/icon_${s}x${s}.png" > /dev/null`)
      execSync(`sips -z ${s * 2} ${s * 2} "${PNG}" --out "${iconset}/icon_${s}x${s}@2x.png" > /dev/null`)
    }
    execSync(`iconutil -c icns -o "${ICNS}" "${iconset}"`)
    console.log('wrote ' + ICNS)
  } else {
    console.log('skipped ' + ICNS + ' (sips/iconutil are macOS-only)')
  }
  process.exit(0)
}).catch((err) => { console.error(err); process.exit(1) })
