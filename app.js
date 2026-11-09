'use strict'

const $ = sel => document.querySelector(sel)

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp'])
// Containers/codecs the <video> element can usually handle natively
const NATIVE_EXTS = new Set(['.mp4', '.m4v', '.webm', '.ogv'])
// Extra WebRTC trackers appended to every torrent (browsers can't use udp/tcp ones)
const EXTRA_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz'
]

// Sintel — free (CC) movie, seeded with WebRTC peers, good for testing
const SAMPLE_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent'

/* ---------- small helpers ---------- */

function el (tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

function ext (name) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

function fmtBytes (n) {
  if (!Number.isFinite(n) || n < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

const fmtSpeed = n => `${fmtBytes(n)}/s`

function fmtTime (ms) {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

let toastTimer = null
function toast (msg, isError = false) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.toggle('error', isError)
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 8000 : 4000)
}

/* ---------- library + client boot ---------- */

// v3 dist bundle is an ES module exporting the class (no window global)
async function loadLibrary () {
  const sources = [
    './webtorrent.min.js',
    'https://esm.sh/webtorrent@3/dist/webtorrent.min.js'
  ]
  for (const src of sources) {
    try {
      const mod = await import(src)
      if (mod && mod.default) return mod.default
    } catch (err) { /* try next source */ }
  }
  throw new Error('WebTorrent library failed to load (local webtorrent.min.js and CDN were both unreachable).')
}

let client = null
let playingCard = null // TorrentCard currently owning the player
const cards = []

async function boot () {
  const status = $('#bootStatus')
  try {
    if (!('serviceWorker' in navigator)) {
      throw new Error('This browser/context does not support service workers. Open the page via http://localhost… or https:// (not file://).')
    }

    // Library load and service-worker registration are independent — run them together
    const [WebTorrent, controller] = await Promise.all([
      loadLibrary(),
      navigator.serviceWorker.register('./sw.min.js', { scope: './' })
    ])
    await navigator.serviceWorker.ready

    client = new WebTorrent()
    client.on('error', err => toast(`Client error: ${err.message}`, true))
    // v3 streaming: a service worker serves torrent data as HTTP with range support
    client.createServer({ controller })

    status.hidden = true
    $('#magnetInput').disabled = false
    $('#addBtn').disabled = false
    $('#sampleBtn').disabled = false
    $('#magnetInput').focus()
  } catch (err) {
    status.textContent = `Startup failed: ${err.message}`
    status.classList.add('error')
  }
}

/* ---------- torrent card ---------- */

// Owns the full lifecycle of one torrent's UI. Self-registers in `cards`.
// Single teardown path: torrent.destroy() (from Remove button or an error)
// emits 'close', which removes the card; nothing else dismantles state.
class TorrentCard {
  constructor (torrent) {
    this.torrent = torrent
    this.destroyed = false

    const removeBtn = el('button', null, 'Remove')
    const head = el('div', 'card-head')
    this.title = el('h2', null, 'Fetching metadata…')
    head.append(this.title, removeBtn)
    this.sub = el('div', 'card-sub', '…')
    this.fill = el('div', 'progress-fill')
    const bar = el('div', 'progress')
    bar.append(this.fill)
    this.stats = el('div', 'stats', 'waiting…')
    this.fileList = el('ul', 'files')
    this.root = el('article', 'card')
    this.root.append(head, this.sub, bar, this.stats, this.fileList)
    $('#torrents').prepend(this.root)
    cards.push(this)

    torrent.once('_infoHash', () => { this.sub.textContent = torrent.infoHash })
    torrent.once('ready', () => {
      this.title.textContent = torrent.name || torrent.infoHash
      this.renderFiles()
    })
    torrent.on('done', () => this.update())
    torrent.on('error', err => {
      toast(`${torrent.name || torrent.infoHash || 'torrent'}: ${err.message}`, true)
      torrent.destroy()
    })
    torrent.once('close', () => this.destroy())
    removeBtn.addEventListener('click', () => torrent.destroy())

    this.update()
  }

  renderFiles () {
    this.fileList.textContent = ''
    let anyVideo = false
    this.torrent.files.forEach(file => {
      const li = el('li')
      li.append(el('span', 'file-name', file.name), el('span', 'file-size', fmtBytes(file.length)))
      const e = ext(file.name)
      if (VIDEO_EXTS.has(e)) {
        anyVideo = true
        if (!NATIVE_EXTS.has(e)) li.append(el('span', 'badge warn', 'may not play'))
        const playBtn = el('button', 'play-btn', 'Play')
        playBtn.addEventListener('click', () => this.play(file))
        li.append(playBtn)
      } else {
        li.classList.add('other')
        li.title = 'Not a video file'
      }
      this.fileList.append(li)
    })
    if (!anyVideo) this.fileList.append(el('li', 'none', 'No video files found in this torrent.'))
  }

  update () {
    const { torrent } = this
    if (torrent.destroyed) return
    if (!torrent.ready) {
      this.fill.style.width = '0%'
      this.stats.textContent = 'Fetching metadata… needs at least one peer that has this torrent.'
      return
    }
    this.fill.style.width = `${(torrent.progress * 100).toFixed(1)}%`
    const parts = [
      `${(torrent.progress * 100).toFixed(1)}%`,
      `${fmtSpeed(torrent.downloadSpeed)} down`,
      `${fmtSpeed(torrent.uploadSpeed)} up`,
      `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`
    ]
    if (torrent.progress >= 1) {
      parts.push('complete')
    } else {
      parts.push(`${fmtBytes(torrent.downloaded)} of ${fmtBytes(torrent.length)}`)
      if (Number.isFinite(torrent.timeRemaining) && torrent.timeRemaining > 0) {
        parts.push(`~${fmtTime(torrent.timeRemaining)} left`)
      }
      if (torrent.numPeers === 0) parts.push('looking for peers…')
    }
    this.stats.textContent = parts.join(' · ')
  }

  play (file) {
    playingCard = this
    $('#playerWrap').hidden = false
    $('#nowPlaying').textContent = `${file.name} — ${this.torrent.name || this.torrent.infoHash}`
    const video = $('#player')
    file.streamTo(video) // sets video.src to the service-worker HTTP stream
    video.play().catch(() => {}) // autoplay may be blocked until user interacts
    video.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.root.remove()
    const i = cards.indexOf(this)
    if (i >= 0) cards.splice(i, 1)
    if (playingCard === this) hidePlayer()
  }
}

/* ---------- adding torrents ---------- */

async function addTorrent (torrentId) {
  try {
    if (await client.get(torrentId)) { toast('This torrent is already in the list.'); return }
    new TorrentCard(client.add(torrentId, { announce: EXTRA_TRACKERS }))
  } catch (err) {
    toast(`Could not add torrent: ${err.message}`, true)
  }
}

async function handleInput (raw) {
  if (raw.startsWith('magnet:')) { addTorrent(raw); return }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const res = await fetch(raw)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      addTorrent(new Uint8Array(await res.arrayBuffer()))
    } catch (err) {
      toast(`Could not fetch the .torrent file: ${err.message} (server must allow CORS)`, true)
    }
    return
  }
  toast('Paste a magnet link (starts with "magnet:") or a direct .torrent URL.', true)
}

/* ---------- player ---------- */

function hidePlayer () {
  playingCard = null
  const video = $('#player')
  video.pause()
  video.removeAttribute('src')
  video.load()
  $('#nowPlaying').textContent = ''
  $('#playerWrap').hidden = true
}

/* ---------- wiring ---------- */

$('#addForm').addEventListener('submit', e => {
  e.preventDefault()
  const input = $('#magnetInput')
  const value = input.value.trim()
  if (!value) return
  input.value = ''
  handleInput(value)
})

$('#sampleBtn').addEventListener('click', () => addTorrent(SAMPLE_MAGNET))

window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', e => {
  e.preventDefault()
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
  if (!file) return
  if (!/\.torrent$/i.test(file.name)) {
    toast('Only a .torrent file can be dropped here (magnet links go in the input).', true)
    return
  }
  file.arrayBuffer().then(buf => addTorrent(new Uint8Array(buf)))
})

$('#player').addEventListener('error', () => {
  if (playingCard) {
    toast('The browser reported a media error — this file’s codec/container is probably unsupported.', true)
  }
})

setInterval(() => cards.forEach(card => card.update()), 1000)

boot()
