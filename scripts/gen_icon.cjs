// Regenerate the app-icon rasters from the SVG source of truth (SPEC §14):
// app/electron/icon/icon.svg → icon.png (1024 px, rasterized via Electron's own
// Chromium so the render matches the in-app <img> exactly) → icon.icns
// (sips + iconutil). Run from app/: ./node_modules/.bin/electron ../scripts/gen_icon.cjs
const { app, BrowserWindow } = require('electron')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ICON_DIR = path.join(__dirname, '..', 'app', 'electron', 'icon')
const SVG = path.join(ICON_DIR, 'icon.svg')
const PNG = path.join(ICON_DIR, 'icon.png')
const ICNS = path.join(ICON_DIR, 'icon.icns')
const SIZE = 1024

const SVG_B64 = fs.readFileSync(SVG).toString('base64')
const DRAW = `
  (async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,${SVG_B64}'
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = ${SIZE}
    c.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE})
    return c.toDataURL('image/png')
  })()
`

setTimeout(() => { console.error('timed out'); process.exit(1) }, 20000)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  await win.loadURL('data:text/html,<html></html>')
  const dataUrl = await win.webContents.executeJavaScript(DRAW)
  fs.writeFileSync(PNG, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('wrote ' + PNG)

  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-icon-')) + '/icon.iconset'
  fs.mkdirSync(iconset)
  for (const s of [16, 32, 128, 256, 512]) {
    execSync(`sips -z ${s} ${s} "${PNG}" --out "${iconset}/icon_${s}x${s}.png" > /dev/null`)
    execSync(`sips -z ${s * 2} ${s * 2} "${PNG}" --out "${iconset}/icon_${s}x${s}@2x.png" > /dev/null`)
  }
  execSync(`iconutil -c icns -o "${ICNS}" "${iconset}"`)
  console.log('wrote ' + ICNS)
  process.exit(0)
}).catch((err) => { console.error(err); process.exit(1) })
