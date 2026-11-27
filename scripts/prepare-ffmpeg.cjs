/**
 * Copies the ffmpeg and ffprobe binaries that npm installed (ffmpeg-static,
 * @ffprobe-installer/ffprobe) into src-tauri/resources/ffmpeg, which the
 * installer bundles next to the app. Run by `npm run build` before bundling;
 * `npm run dev` finds them there too.
 */
const fs = require('fs')
const path = require('path')

const out = path.join(__dirname, '..', 'src-tauri', 'resources', 'ffmpeg')
fs.mkdirSync(out, { recursive: true })

function copy(from, name) {
  if (!from || !fs.existsSync(from)) {
    console.error(`[ffmpeg] ${name} is missing — run "npm install" (not --ignore-scripts) first.`)
    process.exit(1)
  }
  const target = path.join(out, name + path.extname(from))
  const same =
    fs.existsSync(target) && fs.statSync(target).size === fs.statSync(from).size
  if (!same) fs.copyFileSync(from, target)
  console.log(`[ffmpeg] ${name}: ${target}${same ? ' (up to date)' : ''}`)
}

copy(require('ffmpeg-static'), 'ffmpeg')
copy(require('@ffprobe-installer/ffprobe').path, 'ffprobe')
