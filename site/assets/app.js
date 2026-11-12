/**
 * app.js — the gallery app.
 *
 * Data comes from data/gallery.json, built from events/ by
 * scripts/build-gallery.mjs. Events are selected from the hamburger menu;
 * artists are the filmstrip at the bottom. Vegas renders the slideshow.
 */

import vegas from '../vendor/vegas/vegas.js'
import { normalizeBestOf } from './best-of.js'
import { slugify } from './slug.js'

/* --------------------------------------------------------------------------
   Config + state
   -------------------------------------------------------------------------- */

const SITE_TITLE = 'Oddbjørn Steffensen Concert Photography'
const BUILD_VERSION = document.querySelector('meta[name="gallery-version"]')?.content || ''
const versioned = (url) => BUILD_VERSION ? `${url}?v=${encodeURIComponent(BUILD_VERSION)}` : url
const SLIDE_DELAY = 7200
const TRANSITION_DURATION = 1500
const ARROW_TRANSITION_DURATION = 450
const TRANSITIONS = ['fade', 'fade', 'fade2', 'blur']

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const state = {
  collection: null,
  all: [],
  events: [],
  eventId: null,
  eventGroup: null,
  view: [],
  index: 0,
  filter: '',
  mode: 'events',
  bestofId: null,
  bestOfOrder: null,
  bestOfOrderId: null,
  paused: reducedMotion,
  delay: SLIDE_DELAY,
  vegas: null,
  artistTiles: [],
  bandcamp: {},
  bandcampOpen: false,
  bandcampArtist: null,
  menuOpen: false,
  elapsed: 0,
  startedAt: 0,
  timeout: 0
}

const $ = (selector, root = document) => root.querySelector(selector)

const dom = {
  stage: $('#stage'),
  caption: $('#caption'),
  artists: $('#artists'),
  eventsToggle: $('#events-toggle'),
  eventsMenu: $('#events-menu'),
  eventList: $('#event-list'),
  currentEvent: $('#current-event'),
  bandcampPanel: $('#bandcamp-panel'),
  bandcampFrame: $('#bandcamp-frame'),
  footer: $('.footer'),
  intro: $('#intro')
}

/* --------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */

function artistKey(item) {
  return item.artist || 'Unattributed'
}

function shuffle(list) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function currentEvent() {
  return state.events.find((event) => event.id === state.eventId) || null
}

function bestOfCollections() {
  const collections = state.collection?.bestOf?.collections
  return Array.isArray(collections) ? collections : []
}

function currentBestOf() {
  return bestOfCollections().find((collection) => collection.id === state.bestofId) || null
}

function bestOfItems() {
  const collections = bestOfCollections()
  if (state.bestofId) {
    if (state.bestOfOrder && state.bestOfOrderId === state.bestofId) return state.bestOfOrder
    return currentBestOf()?.items || []
  }

  const seen = new Set()
  const items = []
  for (const collection of collections) {
    for (const item of collection.items) {
      const key = item.src || item.file
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  return items
}

function bestOfArtist() {
  const collection = currentBestOf()
  return collection?.kind === 'artist' ? (collection.artist || collection.name) : null
}

function normalizeEvents(collection) {
  if (Array.isArray(collection.events) && collection.events.length) {
    return collection.events
  }

  // Compatibility with manifests built before the event layer existed.
  const groups = new Map()
  for (const item of collection.slides) {
    const id = item.eventId || 'event'
    const name = item.eventName || collection.event || collection.title || 'Event'
    if (!groups.has(id)) groups.set(id, { id, name, count: 0, artists: new Map() })
    const event = groups.get(id)
    event.count += 1
    const artist = artistKey(item)
    event.artists.set(artist, (event.artists.get(artist) || 0) + 1)
  }

  return [...groups.values()]
    .map((event) => ({
      id: event.id,
      name: event.name,
      count: event.count,
      artists: [...event.artists.entries()].map(([name, count]) => ({ name, count }))
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function eventGroupKey(eventId) {
  return slugify(String(eventId || '').split('/')[0])
}

function eventItems() {
  if (state.eventGroup) {
    const scoped = state.all.filter((item) => eventGroupKey(item.eventId) === state.eventGroup)
    if (scoped.length) return scoped
  }
  if (!state.eventId) return [...state.all]
  return state.all.filter((item) => item.eventId === state.eventId)
}

function visibleItems() {
  if (state.mode === 'bestof') return bestOfItems()

  const items = eventItems()
  if (!state.filter) return items
  return items.filter((item) => artistKey(item) === state.filter)
}

function replaceRoute(path) {
  try {
    history.replaceState(null, '', `${path}${location.search}${location.hash}`)
  } catch {
    /* file:// and some embeds disallow history updates */
  }
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

async function boot() {
  bindEvents()

  try {
    const configPromise = loadRuntimeConfig()
    const response = await fetch(versioned('data/gallery.json'), { cache: 'no-cache' })
    if (!response.ok) throw new Error(`data/gallery.json responded ${response.status}`)

    const collection = await response.json()
    if (!Array.isArray(collection.slides)) {
      throw new Error('data/gallery.json has no slides array')
    }

    collection.slides = collection.slides.filter(
      (item) => item && typeof item.src === 'string' && item.src
    )
    if (!collection.slides.length) {
      throw new Error('data/gallery.json contains no photographs')
    }

    const bestOf = normalizeBestOf(collection.bestOf)
    if (bestOf) collection.bestOf = bestOf
    else delete collection.bestOf

    state.collection = collection
    state.all = collection.slides
    state.events = normalizeEvents(collection)
    state.eventId = state.events[0]?.id || null

    const config = await configPromise
    state.bandcamp = normalizeBandcamp(config.bandcamp)

    document.body.classList.add('is-ready')
    mount()
    applyRouteFromPath()
  } catch (error) {
    console.warn('[gallery]', error.message)
    dom.intro.hidden = false
  }
}

function mount() {
  if (!state.collection) return

  document.title = SITE_TITLE
  renderEventList()
  buildArtistTiles()
  updateChrome()
  syncBandcamp()
  buildSlideshow({ index: hashIndex() })
  requestAnimationFrame(updateStageBounds)
}

function updateStageBounds() {
  if (!dom.footer) return
  const footerTop = dom.footer.getBoundingClientRect().top
  const bottom = Math.max(0, window.innerHeight - footerTop)
  document.documentElement.style.setProperty('--stage-bottom', `${bottom}px`)
}

/* --------------------------------------------------------------------------
   Event menu
   -------------------------------------------------------------------------- */

function renderEventList() {
  dom.eventList.replaceChildren()

  for (const collection of bestOfCollections()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'event-item event-item-bestof event-item-bestof-collection'
    button.dataset.bestof = collection.id
    const active = state.mode === 'bestof' && state.bestofId === collection.id
    button.setAttribute('aria-current', String(active))
    button.setAttribute('aria-label', `${collection.name}, best of, ${collection.count} photographs`)

    const name = document.createElement('span')
    name.className = 'event-name'
    name.textContent = collection.name

    const tally = document.createElement('span')
    tally.className = 'event-count'
    tally.textContent = String(collection.count)

    button.append(name, tally)
    button.addEventListener('click', () => selectBestOf(collection.id))
    dom.eventList.append(button)
  }

  for (const event of state.events) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'event-item'
    button.dataset.event = event.id
    const active = state.mode === 'events' && event.id === state.eventId
    button.setAttribute('aria-current', String(active))
    button.setAttribute('aria-label', `${event.name}, ${event.count} photographs`)

    const name = document.createElement('span')
    name.className = 'event-name'
    name.textContent = event.name

    const count = document.createElement('span')
    count.className = 'event-count'
    count.textContent = String(event.count)

    button.append(name, count)
    button.addEventListener('click', () => selectEvent(event.id))
    dom.eventList.append(button)
  }

  const about = document.createElement('a')
  about.className = 'event-item event-item-link'
  about.href = 'about.html'
  const aboutName = document.createElement('span')
  aboutName.className = 'event-name'
  aboutName.textContent = 'About'
  about.append(aboutName)
  dom.eventList.append(about)

  dom.eventsToggle.hidden = false
  const eventsControl = dom.eventsToggle.closest('.events-control')
  if (eventsControl) eventsControl.hidden = false
  dom.eventsToggle.setAttribute('aria-label', 'Open menu')
  dom.currentEvent.textContent = 'Menu'

}

function selectEvent(id) {
  closeEventsMenu({ restoreFocus: true })
  const wasBestOf = state.mode === 'bestof'
  const wasGroup = Boolean(state.eventGroup)
  const event = state.events.find((item) => item.id === id)
  state.mode = 'events'
  state.bestofId = null
  state.bestOfOrder = null
  state.bestOfOrderId = null
  state.eventGroup = null
  if (id === state.eventId && !wasBestOf && !wasGroup) return

  state.eventId = id
  state.filter = ''
  lastPreferredSrc = null

  renderEventList()
  buildArtistTiles()
  updateChrome()
  syncBandcamp()
  buildSlideshow({ index: 0 })
  if (event) replaceRoute(`/${slugify(event.name)}/`)
}

function selectEventGroup(group) {
  closeEventsMenu({ restoreFocus: true })
  state.mode = 'events'
  state.eventId = null
  state.bestofId = null
  state.bestOfOrder = null
  state.bestOfOrderId = null
  state.eventGroup = group
  state.filter = ''
  lastPreferredSrc = null

  renderEventList()
  buildArtistTiles()
  updateChrome()
  syncBandcamp()
  buildSlideshow({ index: 0 })
  dom.eventsToggle.setAttribute('aria-label', `Choose an event or Best-of. Current group: ${group}`)
  replaceRoute(`/${group}/`)
}

function toggleEventsMenu() {
  if (state.menuOpen) {
    closeEventsMenu({ restoreFocus: true })
    return
  }

  state.menuOpen = true
  dom.eventsMenu.hidden = false
  dom.eventsToggle.setAttribute('aria-expanded', 'true')
  requestAnimationFrame(() => {
    dom.eventList.querySelector('button')?.focus({ preventScroll: true })
  })
}

function closeEventsMenu({ restoreFocus = false } = {}) {
  if (!state.menuOpen) return

  state.menuOpen = false
  dom.eventsMenu.hidden = true
  dom.eventsToggle.setAttribute('aria-expanded', 'false')

  if (restoreFocus) dom.eventsToggle.focus({ preventScroll: true })
}

/* --------------------------------------------------------------------------
   Slideshow
   -------------------------------------------------------------------------- */

let lastPreferredSrc = null

function buildSlideshow({ index = 0, src = null } = {}) {
  clearTimer()

  if (state.vegas) {
    try {
      state.vegas.destroy()
    } catch (error) {
      console.warn('[gallery] could not destroy Vegas', error)
    }
    state.vegas = null
  }
  dom.stage.replaceChildren()

  // Event views are random; curated best-of collections keep their order.
  let items = visibleItems()
  if (state.mode === 'events') items = shuffle(items)

  let start = index
  const preferred = src || lastPreferredSrc
  if (preferred) {
    const found = items.findIndex((item) => item.src === preferred)
    if (found >= 0) start = found
  }
  lastPreferredSrc = null

  state.view = items
  state.index = items.length ? Math.min(Math.max(0, start), items.length - 1) : 0

  updateArtistStrip()
  updateChrome()

  if (!items.length) {
    return
  }

  state.vegas = vegas(dom.stage, {
    slides: items.map((item, i) => ({
      src: item.src,
      transition: TRANSITIONS[i % TRANSITIONS.length]
    })),
    slide: state.index,
    autoplay: false,
    timer: false,
    delay: state.delay,
    transition: 'fade',
    transitionDuration: reducedMotion ? 250 : TRANSITION_DURATION,
    animation: null,
    cover: false,
    align: 'center',
    valign: 'center',
    loop: true,
    overlay: false,
    walk: (index) => onSlide(index)
  })
}

function onSlide(index) {
  state.index = index
  renderCaption()
  syncBestofStripActive()

  try {
    const url = `${location.pathname}${location.search}#${index + 1}`
    history.replaceState(null, '', url)
  } catch {
    /* file:// and some embeds disallow history updates */
  }

  resetTimer()
  prefetch(index)
}

function prefetch(index) {
  if (state.view.length < 2) return
  for (let offset = 1; offset <= 2; offset += 1) {
    const item = state.view[(index + offset) % state.view.length]
    if (!item) continue
    const image = new Image()
    image.decoding = 'async'
    image.src = item.src
  }
}

function step(delta, { fast = false } = {}) {
  if (!state.vegas || state.view.length < 2) return
  clearTimer()

  const previousDuration = state.vegas.settings.transitionDuration
  if (fast) {
    state.vegas.settings.transitionDuration = reducedMotion ? 140 : ARROW_TRANSITION_DURATION
  }

  try {
    if (delta > 0) state.vegas.next()
    else state.vegas.previous()
  } finally {
    if (fast) state.vegas.settings.transitionDuration = previousDuration
  }
}

function goTo(index) {
  if (!state.vegas || index < 0 || index >= state.view.length) return
  if (index === state.index) return
  clearTimer()
  state.vegas.jump(index)
}

function hashIndex() {
  const value = Number(location.hash.replace(/^#\/?/, ''))
  return Number.isInteger(value) && value > 0 ? value - 1 : 0
}

/* --------------------------------------------------------------------------
   Autoplay clock
   -------------------------------------------------------------------------- */

function clearTimer() {
  clearTimeout(state.timeout)
  state.timeout = 0
  state.elapsed = 0
  state.startedAt = 0
}

function resetTimer() {
  clearTimer()
  if (!state.paused) startTimer()
}

function startTimer() {
  if (state.paused || state.view.length < 2 || !state.vegas) return

  if (state.elapsed >= state.delay) state.elapsed = 0
  state.startedAt = performance.now() - state.elapsed

  const remaining = Math.max(50, state.delay - state.elapsed)
  clearTimeout(state.timeout)
  state.timeout = setTimeout(() => {
    if (!state.paused) state.vegas?.next()
  }, remaining)
}

function pauseTimer() {
  if (state.startedAt) {
    state.elapsed = Math.min(state.delay, performance.now() - state.startedAt)
  }
  clearTimeout(state.timeout)
}

function togglePause() {
  if (state.view.length < 2) return

  state.paused = !state.paused
  if (state.paused) pauseTimer()
  else startTimer()
}

/* --------------------------------------------------------------------------
   Caption
   -------------------------------------------------------------------------- */

let captionEls = null

function ensureCaption() {
  if (captionEls) return captionEls

  const artist = document.createElement('h2')
  artist.className = 'caption-artist'

  const link = document.createElement('a')
  link.className = 'caption-link'
  artist.append(link)

  const context = document.createElement('span')
  context.className = 'caption-context visually-hidden'

  dom.caption.append(artist, context)
  captionEls = { artist, link, context }
  return captionEls
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text
}

function renderCaption() {
  const item = state.view[state.index]
  if (!item) return

  const els = ensureCaption()

  const name = item.artist || 'Unknown artist'
  els.artist.classList.toggle('is-unknown', !item.artist)
  setText(els.link, name)

  const entry = state.bandcamp[item.artist]
  if (entry?.homepage) {
    els.link.href = entry.homepage
    els.link.target = '_blank'
    els.link.rel = 'noreferrer noopener'
    els.link.title = `Open ${name} on Bandcamp`
    els.link.classList.add('has-homepage')
  } else {
    els.link.removeAttribute('href')
    els.link.removeAttribute('target')
    els.link.removeAttribute('rel')
    els.link.removeAttribute('title')
    els.link.classList.remove('has-homepage')
  }

  const collection = currentBestOf()
  const context = [
    item.artist || 'Unknown artist'
  ]
  const place = state.mode === 'bestof'
    ? collection?.name
    : (item.eventName || currentEvent()?.name)
  if (place && place !== item.artist) context.push(`at ${place}`)
  if (item.date) context.push(item.date)
  context.push(`photograph ${state.index + 1} of ${state.view.length}`)
  setText(els.context, context.join('. '))
}

/* --------------------------------------------------------------------------
   Artist strip
   -------------------------------------------------------------------------- */

function buildArtistTiles() {
  const items = eventItems()
  const eventPick = items.length ? items[Math.floor(Math.random() * items.length)] : null
  state.eventCover = eventPick?.thumb || eventPick?.src || null
  state.eventCoverSrc = eventPick?.src || null
  const groups = new Map()

  for (const item of items) {
    const name = artistKey(item)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(item)
  }

  state.artistTiles = [...groups.entries()]
    .map(([name, items]) => ({
      name,
      items,
      // One cover per artist folder, picked at random on each page load.
      cover: items[Math.floor(Math.random() * items.length)],
      // Optional Bandcamp player configured for this artist.
      bandcamp: state.bandcamp[name] || null
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  renderArtistStrip()
}

function buildArtistStrip() {
  if (state.mode === 'bestof') {
    renderBestofStrip()
    return
  }
  buildArtistTiles()
}

function renderBestofStrip() {
  dom.artists.classList.remove('is-snapping')
  dom.artists.style.removeProperty('--strip-shift')
  dom.artists.replaceChildren()

  const items = bestOfItems()
  for (const [index, item] of items.entries()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'artist-tile artist-tile-photo'
    button.dataset.bestofIndex = String(index)
    button.title = item.artist
      ? `${item.artist}${item.date ? ` · ${item.date}` : ''}`
      : `Best-of photograph ${index + 1}`

    const frame = document.createElement('span')
    frame.className = 'artist-tile-frame'

    const image = new Image()
    image.alt = ''
    image.draggable = false
    image.loading = 'lazy'
    image.decoding = 'async'
    bindThumbnail(image, item, frame)
    frame.append(image)

    button.append(frame)
    button.addEventListener('click', () => showBestofPhoto(index))
    dom.artists.append(button)
  }

  updateArtistStrip()
}

function centerStripButton(button) {
  if (!button) return
  const max = Math.max(0, dom.artists.scrollWidth - dom.artists.clientWidth)
  const left = button.offsetLeft - (dom.artists.clientWidth - button.clientWidth) / 2
  dom.artists.scrollTo({ left: Math.min(max, Math.max(0, left)), behavior: 'auto' })
}

function syncBestofStripActive() {
  if (state.mode !== 'bestof') return

  for (const button of dom.artists.children) {
    const index = Number(button.dataset.bestofIndex)
    const item = state.view[index]
    const active = Number.isInteger(index) && index === state.index
    button.setAttribute('aria-pressed', String(active))
    button.setAttribute(
      'aria-label',
      item
        ? `Show photograph ${index + 1} of ${state.view.length}: ${item.artist || 'Unknown artist'}`
        : 'Best-of photograph'
    )
    if (active) centerStripButton(button)
  }
}

function showBestofPhoto(index) {
  if (state.mode !== 'bestof') return
  goTo(index)
}

function bindThumbnail(image, item, frame) {
  let triedFull = false

  image.addEventListener('error', () => {
    const full = item?.src ? new URL(item.src, document.baseURI).href : ''
    if (!triedFull && full && image.src !== full) {
      triedFull = true
      image.src = item.src
      return
    }
    frame.classList.add('is-missing')
    image.hidden = true
  })

  const src = item?.thumb || item?.src
  if (src) image.src = src
  else frame.classList.add('is-missing')
}

function appendTileLabel(button, name, count) {
  const label = document.createElement('span')
  label.className = 'artist-tile-name'
  label.append(document.createTextNode(`${name} `))

  const tally = document.createElement('span')
  tally.className = 'artist-tile-count'
  tally.textContent = `(${count})`
  label.append(tally)
  button.append(label)
}

function renderEventTile() {
  const event = currentEvent()
  const items = eventItems()
  const count = items.length
  const eventName = event?.name || 'All artists'
  const name = `All artists · ${eventName}`

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'artist-tile artist-tile-event'
  button.dataset.eventTile = 'true'
  button.title = `${name} · ${count} photograph${count === 1 ? '' : 's'}`

  const frame = document.createElement('span')
  frame.className = 'artist-tile-frame'

  const image = new Image()
  image.alt = ''
  image.draggable = false
  image.loading = 'lazy'
  image.decoding = 'async'
  bindThumbnail(image, { thumb: state.eventCover, src: state.eventCoverSrc }, frame)
  frame.append(image)

  button.append(frame)
  appendTileLabel(button, name, count)
  button.addEventListener('click', showAllArtists)
  dom.artists.append(button)
}

function renderArtistStrip() {
  dom.artists.classList.remove('is-snapping')
  dom.artists.style.removeProperty('--strip-shift')
  dom.artists.replaceChildren()

  renderEventTile()

  for (const tile of state.artistTiles) {
    const count = tile.items.length
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'artist-tile'
    button.dataset.artist = tile.name
    button.title = `${tile.name} · ${count} photograph${count === 1 ? '' : 's'}${tile.bandcamp ? ` · ${tile.bandcamp.label}` : ''}`

    const frame = document.createElement('span')
    frame.className = 'artist-tile-frame'

    const image = new Image()
    image.alt = ''
    image.draggable = false
    image.loading = 'lazy'
    image.decoding = 'async'
    bindThumbnail(image, tile.cover, frame)
    frame.append(image)

    button.append(frame)
    appendTileLabel(button, tile.name, count)
    button.addEventListener('click', () => toggleArtist(tile))
    dom.artists.append(button)
  }

  updateArtistStrip()
}

function updateArtistStrip() {
  const inBestOf = state.mode === 'bestof'

  for (const button of dom.artists.children) {
    if (inBestOf) {
      const index = Number(button.dataset.bestofIndex)
      const item = state.view[index]
      const active = Number.isInteger(index) && index === state.index

      button.setAttribute('aria-pressed', String(active))
      button.setAttribute(
        'aria-label',
        item
          ? `Show photograph ${index + 1} of ${state.view.length}: ${item.artist || 'Unknown artist'}`
          : 'Best-of photograph'
      )

      if (active) centerStripButton(button)
      continue
    }

    const isEventTile = button.dataset.eventTile === 'true'
    const name = button.dataset.artist
    const active = isEventTile ? !state.filter : state.filter === name
    const eventName = currentEvent()?.name || 'this event'
    const tile = state.artistTiles.find((entry) => entry.name === name)
    const count = isEventTile ? eventItems().length : (tile?.items.length || 0)

    button.setAttribute('aria-pressed', String(active))

    if (isEventTile) {
      button.setAttribute(
        'aria-label',
        active
          ? `Reshuffle all ${count} photographs across all artists in ${eventName}`
          : `Show a random mix of all ${count} photographs across all artists in ${eventName}`
      )
    } else {
      button.setAttribute(
        'aria-label',
        active
          ? `Show all ${count} photographs instead of ${name}`
          : `Show only ${name}, ${count} photograph${count === 1 ? '' : 's'}${tile?.bandcamp ? ` (${tile.bandcamp.label} player)` : ''}`
      )
    }

    if (active) centerStripButton(button)
  }
}

function toggleArtist(tile) {
  if (state.filter === tile.name) setFilter('')
  else setFilter(tile.name, tile.cover.src)
}

function showAllArtists() {
  state.filter = ''
  lastPreferredSrc = null
  updateChrome()
  buildSlideshow({ index: 0 })
  syncBandcamp()
}

function selectBestOf(id = null) {
  closeEventsMenu({ restoreFocus: true })
  const collections = bestOfCollections()
  if (!collections.length) return
  const selected = id === null ? null : collections.find((collection) => collection.id === id)
  if (id !== null && !selected) return

  state.mode = 'bestof'
  state.bestofId = id
  state.eventGroup = null
  state.filter = ''
  const collection = currentBestOf()
  state.bestOfOrder = collection?.kind === 'artist' ? shuffle(collection.items) : null
  state.bestOfOrderId = state.bestOfOrder ? collection.id : null
  lastPreferredSrc = null
  updateChrome()
  renderEventList()
  renderBestofStrip()
  syncBandcamp()
  buildSlideshow({ index: 0 })
  replaceRoute(selected ? `/${slugify(selected.name)}/` : '/best-of/')
}

function applyRouteFromPath() {
  const segment = location.pathname.split('/').filter(Boolean)[0] || ''
  const slug = slugify(decodeURIComponent(segment).replace(/\.html$/i, ''))
  if (!slug || slug === 'index') return

  const collections = bestOfCollections()
  if (slug === 'best-of' && collections.length) {
    selectBestOf(null)
    return
  }

  const bestOf = collections.find((collection) => slugify(collection.name) === slug)
  if (bestOf) {
    selectBestOf(bestOf.id)
    return
  }

  const event = state.events.find((item) => {
    const eventSlug = slugify(item.name)
    return eventSlug === slug || eventSlug.replaceAll('-', '') === slug.replaceAll('-', '')
  })
  if (event) {
    selectEvent(event.id)
    return
  }

  const groups = [...new Set(state.events.map((item) => eventGroupKey(item.id)).filter(Boolean))]
  if (groups.includes(slug)) selectEventGroup(slug)
}

/* --------------------------------------------------------------------------
   Chrome: stats, filter, controls
   -------------------------------------------------------------------------- */

function updateChrome() {
  const event = currentEvent()
  dom.currentEvent.textContent = state.mode === 'bestof'
    ? 'Best of'
    : (event?.name || 'Events')
}

function setFilter(name, startSrc = null) {
  if (name === state.filter) return

  const currentSrc = state.view[state.index]?.src || null
  state.filter = name
  lastPreferredSrc = startSrc || (name ? null : currentSrc)
  updateChrome()
  buildSlideshow()
  syncBandcamp()
}

/* --------------------------------------------------------------------------
   Bandcamp player
   -------------------------------------------------------------------------- */

async function loadRuntimeConfig() {
  try {
    const response = await fetch(versioned('gallery.config.json'), { cache: 'no-cache' })
    if (!response.ok) return {}
    return await response.json()
  } catch {
    return {}
  }
}

function normalizeBandcamp(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {}

  const map = {}
  for (const [artist, raw] of Object.entries(entries)) {
    const entry = normalizeBandcampEntry(raw)
    if (entry) map[artist] = entry
  }
  return map
}

function normalizeBandcampEntry(raw) {
  if (!raw) return null

  const data = typeof raw === 'string' ? { embed: raw } : raw
  let embed = String(data.embed || data.url || data.src || '').trim()

  // Allow pasting a complete Share/Embed iframe snippet.
  const iframe = /<iframe[^>]*\bsrc=["']([^"']+)["']/i.exec(embed)
  if (iframe) embed = iframe[1]
  if (embed.startsWith('//')) embed = `https:${embed}`
  embed = safeUrl(embed)
  if (!embed) return null

  const height = Number(data.height)
  const label = typeof data.label === 'string' && data.label.trim()
    ? data.label.trim()
    : 'Bandcamp'

  return {
    embed,
    height: Number.isFinite(height) && height >= 42 ? height : 42,
    label,
    page: safeUrl(data.page),
    homepage: safeUrl(data.homepage)
  }
}

function safeUrl(value) {
  if (!value) return ''
  try {
    const url = new URL(String(value), location.href)
    return /^https?:$/.test(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function syncBandcamp() {
  const artist = state.mode === 'bestof' ? bestOfArtist() : state.filter
  const entry = artist ? state.bandcamp[artist] : null
  if (!entry) {
    hideBandcamp()
    return
  }

  if (state.bandcampOpen && state.bandcampArtist === artist) return

  state.bandcampOpen = true
  state.bandcampArtist = artist
  dom.bandcampPanel.setAttribute('aria-hidden', 'false')
  dom.bandcampPanel.setAttribute('aria-label', `${entry.label} player for ${artist}`)
  dom.bandcampFrame.title = `${entry.label} player for ${artist}`
  dom.bandcampFrame.src = entry.embed
  dom.bandcampFrame.hidden = false
}

function hideBandcamp() {
  if (state.bandcampOpen) {
    dom.bandcampFrame.src = 'about:blank'
  }
  state.bandcampOpen = false
  state.bandcampArtist = null
  dom.bandcampFrame.hidden = true
  dom.bandcampPanel.setAttribute('aria-hidden', 'true')
  dom.bandcampPanel.setAttribute('aria-label', 'Music player')
}

/* --------------------------------------------------------------------------
   Fullscreen
   -------------------------------------------------------------------------- */

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
    } else {
      await document.exitFullscreen()
    }
  } catch (error) {
    console.warn('[gallery] fullscreen unavailable', error)
  }
}

/* --------------------------------------------------------------------------
   Events
   -------------------------------------------------------------------------- */

let swipe = null
let resumeOnVisible = false
let suppressStripClick = false
let stripGlideFrame = 0

function bindEvents() {
  dom.eventsToggle.addEventListener('click', toggleEventsMenu)

  dom.eventList.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEventsMenu({ restoreFocus: true })
      return
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return

    const buttons = [...dom.eventList.querySelectorAll('button')]
    const current = buttons.indexOf(document.activeElement)
    if (current < 0) return

    event.preventDefault()
    event.stopPropagation()

    let next = current
    if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1

    buttons[next].focus({ preventScroll: true })
  })

  window.addEventListener('resize', updateStageBounds)
  if ('ResizeObserver' in window) {
    new ResizeObserver(updateStageBounds).observe(dom.footer)
  }

  // Drag the artist filmstrip with a mouse (touch already scrolls natively).
  dom.artists.addEventListener('click', (event) => {
    if (!suppressStripClick) return
    suppressStripClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

  dom.artists.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    if (dom.artists.scrollWidth <= dom.artists.clientWidth + 1) return

    cancelAnimationFrame(stripGlideFrame)
    stripGlideFrame = 0
    dom.artists.classList.remove('is-snapping')
    dom.artists.style.removeProperty('--strip-shift')

    const startX = event.clientX
    const startScroll = dom.artists.scrollLeft
    const pointerId = event.pointerId
    let moved = false
    let lastX = event.clientX
    let lastTime = performance.now()
    let velocity = 0

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const dx = moveEvent.clientX - startX
      const now = performance.now()
      const dt = Math.max(1, now - lastTime)
      const stepVelocity = -(moveEvent.clientX - lastX) / dt
      velocity = dt > 80 ? 0 : velocity * 0.68 + stepVelocity * 0.32
      lastX = moveEvent.clientX
      lastTime = now

      if (!moved && Math.abs(dx) > 3) {
        moved = true
        dom.artists.classList.add('is-dragging')
      }

      if (!moved) return
      moveEvent.preventDefault()

      const max = dom.artists.scrollWidth - dom.artists.clientWidth
      const target = startScroll - dx
      const clamped = Math.min(Math.max(0, target), max)

      let overshoot = 0
      if (target < 0) overshoot = -target
      else if (target > max) overshoot = target - max

      const shift = overshoot ? (target < 0 ? 1 : -1) * overshoot * 0.35 : 0
      dom.artists.style.setProperty('--strip-shift', `${shift}px`)
      dom.artists.scrollLeft = clamped
    }

    const onEnd = (endEvent) => {
      if (endEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      dom.artists.classList.remove('is-dragging')

      if (moved) {
        dom.artists.classList.add('is-snapping')
        dom.artists.style.setProperty('--strip-shift', '0px')
        setTimeout(() => {
          dom.artists.classList.remove('is-snapping')
          dom.artists.style.removeProperty('--strip-shift')
        }, 520)

        const stillMoving = performance.now() - lastTime < 90
        const glide = stillMoving ? Math.max(-1.8, Math.min(1.8, velocity)) : 0
        if (Math.abs(glide) > 0.02) {
          startStripGlide(glide)
        }

        suppressStripClick = true
        setTimeout(() => { suppressStripClick = false }, 0)
      }
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  })

  document.addEventListener('click', (event) => {
    if (!state.menuOpen) return
    if (event.target instanceof Element && event.target.closest('.events-control')) return
    closeEventsMenu()
  })

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return

    if (state.menuOpen) {
      if (event.key === 'Escape') closeEventsMenu({ restoreFocus: true })
      return
    }

    if (event.key === 'Escape' && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }

    const target = event.target
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) {
      return
    }
    if (dom.intro.hidden === false) return

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        step(1, { fast: true })
        break
      case 'ArrowLeft':
        event.preventDefault()
        step(-1, { fast: true })
        break
      case ' ':
      case 'Spacebar':
        // Let a focused button activate itself.
        if (target instanceof Element && target.closest('button, a')) return
        event.preventDefault()
        togglePause()
        break
      case 'f':
      case 'F':
        event.preventDefault()
        toggleFullscreen()
        break
      case 'Home':
        event.preventDefault()
        goTo(0)
        break
      case 'End':
        event.preventDefault()
        goTo(state.view.length - 1)
        break
      default:
        if (/^[1-9]$/.test(event.key)) {
          const index = Number(event.key) - 1
          if (index < state.view.length) goTo(index)
        }
    }
  })

  window.addEventListener('hashchange', () => {
    const index = hashIndex()
    if (index < state.view.length) goTo(index)
  })

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resumeOnVisible = !state.paused
      if (!state.paused) togglePause()
      return
    }
    if (resumeOnVisible) {
      resumeOnVisible = false
      if (state.paused) togglePause()
    }
  })

  // Touch: horizontal swipe changes slides.
  window.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || !dom.intro.hidden) return
    const target = event.target
    if (target instanceof Element && target.closest('.artists, .events-control, button, a')) return
    swipe = { x: event.clientX, y: event.clientY, id: event.pointerId }
  }, { passive: true })

  window.addEventListener('pointerup', (event) => {
    if (!swipe || swipe.id !== event.pointerId) return
    const dx = event.clientX - swipe.x
    const dy = event.clientY - swipe.y
    swipe = null
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      step(dx < 0 ? 1 : -1)
    }
  }, { passive: true })

  window.addEventListener('pointercancel', () => {
    swipe = null
  })
}

function startStripGlide(initialVelocity) {
  cancelAnimationFrame(stripGlideFrame)

  let velocity = initialVelocity
  let last = performance.now()

  const glide = (now) => {
    const dt = Math.min(32, now - last)
    last = now

    if (Math.abs(velocity) < 0.01) {
      stripGlideFrame = 0
      return
    }

    const max = dom.artists.scrollWidth - dom.artists.clientWidth
    let next = dom.artists.scrollLeft + velocity * dt

    if (next <= 0) {
      next = 0
      velocity = 0
    } else if (next >= max) {
      next = max
      velocity = 0
    }

    dom.artists.scrollLeft = next
    velocity *= Math.pow(0.92, dt / 16)
    stripGlideFrame = requestAnimationFrame(glide)
  }

  stripGlideFrame = requestAnimationFrame(glide)
}

/* --------------------------------------------------------------------------
   Go
   -------------------------------------------------------------------------- */

boot()
