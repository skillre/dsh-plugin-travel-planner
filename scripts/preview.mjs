#!/usr/bin/env node
// Preview-image checks for one plugin repository.
//
// This is the offline half of the display contract (see the fleet's
// docs/display-contract.md): it validates the SVG files that ship beside
// docs/DETAIL*.md, plus the locale metadata that points at them. It never
// touches the network and never needs a Lark login, so `npm run check` can
// call it on every commit.
//
// The Lark whiteboard is the editing source of truth; `push` and `pull` below
// round-trip through it and are deliberately NOT part of `npm run check`.

import { readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = process.cwd()

// DSH renders the detail banner at a 640x300 logical aspect (2.13:1); official
// preview images all use exactly that. A different ratio leaves dead space or
// squashes the artwork, so the ratio is part of the contract, not a preference.
const PREVIEW_ASPECT = 640 / 300
const ASPECT_TOLERANCE = 0.02
const MAX_PREVIEW_BYTES = 500 * 1024
const MAX_DESCRIPTION_CHARS = 120

const LANGUAGES = [
  { lang: 'en', locale: 'locale/en.json', detail: 'docs/DETAIL.md', image: 'docs/preview.svg' },
  { lang: 'zh', locale: 'locale/zh.json', detail: 'docs/DETAIL.zh.md', image: 'docs/preview.zh.svg' },
]

// Elements the Feishu whiteboard SVG parser maps to editable nodes, plus the
// defs-only gradient and shadow forms it accepts. Anything outside this set is
// either dropped or flattened into a bitmap on the board, which silently
// destroys editability.
const ALLOWED_ELEMENTS = new Set([
  'svg', 'defs', 'g', 'rect', 'circle', 'ellipse', 'polygon', 'line', 'polyline',
  'path', 'text', 'tspan', 'linearGradient', 'radialGradient', 'stop', 'filter',
  'feDropShadow', 'feGaussianBlur', 'feOffset', 'feFlood', 'feComposite', 'feMerge',
  'feMergeNode', 'use', 'symbol',
])
const FORBIDDEN_ELEMENTS = new Set(['pattern', 'clipPath', 'mask', 'image', 'script', 'style', 'foreignObject'])

const errors = []
const warnings = []
const fail = (message) => errors.push(message)
const warn = (message) => warnings.push(message)

const stripComments = (source) => source.replace(/<!--[\s\S]*?-->/g, '')

function readDimensions(source) {
  const open = source.match(/<svg\b[^>]*>/i)
  if (open === null) return undefined
  const tag = open[0]
  const width = Number(tag.match(/\bwidth\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  const height = Number(tag.match(/\bheight\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height, viewBox: tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1] }
}

function checkSvg(path, source) {
  const body = stripComments(source)

  if (!/<svg\b/i.test(body)) {
    fail(`${path}: no <svg> root element`)
    return
  }
  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(body)) {
    fail(`${path}: the <svg> root must declare xmlns="http://www.w3.org/2000/svg"`)
  }

  const dimensions = readDimensions(body)
  if (dimensions === undefined) {
    fail(`${path}: <svg> must declare numeric width and height`)
  } else {
    if (dimensions.viewBox === undefined) fail(`${path}: <svg> must declare a viewBox`)
    const aspect = dimensions.width / dimensions.height
    if (Math.abs(aspect - PREVIEW_ASPECT) > ASPECT_TOLERANCE) {
      fail(
        `${path}: aspect ${dimensions.width}:${dimensions.height} (${aspect.toFixed(2)}:1) is not the ` +
          `detail-banner ratio ${PREVIEW_ASPECT.toFixed(2)}:1 (640x300, or an integer multiple)`,
      )
    }
  }

  for (const match of body.matchAll(/<([A-Za-z][A-Za-z0-9._-]*)/g)) {
    const name = match[1]
    if (FORBIDDEN_ELEMENTS.has(name)) {
      fail(`${path}: <${name}> is not supported by the Feishu whiteboard parser and must not be used`)
    } else if (!ALLOWED_ELEMENTS.has(name)) {
      warn(`${path}: <${name}> is outside the parser's known element set; verify it renders on the board`)
    }
  }

  // External references would break offline rendering and self-containment.
  for (const match of body.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']+)["']/g)) {
    const target = match[1].trim()
    if (target.startsWith('#') || target.startsWith('data:')) continue
    fail(`${path}: external reference ${JSON.stringify(target)}; the preview must be self-contained`)
  }
  if (/@import|url\s*\(\s*["']?(?:https?:)?\/\//i.test(body)) {
    fail(`${path}: external stylesheet or remote URL reference; the preview must be self-contained`)
  }

  // The board reflows text with Noto Sans SC; text drawn as paths loses that.
  if (!/<text\b/.test(body)) warn(`${path}: no <text> elements; verify the artwork carries readable labels`)

  const bytes = Buffer.byteLength(source, 'utf8')
  if (bytes > MAX_PREVIEW_BYTES) {
    fail(`${path}: ${bytes} bytes exceeds the ${MAX_PREVIEW_BYTES}-byte preview budget`)
  }
}

function checkDetailMarkdown(path, source, imagePath) {
  const body = stripComments(source)
    .replace(/^\uFEFF/u, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, '')
    .trim()

  if (body === '') {
    fail(`${path}: the detail document is empty; it must reference the preview image`)
    return
  }

  const images = [...body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
  if (images.length === 0) {
    fail(`${path}: no image reference; the detail page must be carried by docs/preview*.svg`)
    return
  }
  if (images.length > 1) fail(`${path}: ${images.length} images; the detail document carries exactly one preview`)

  const [image] = images
  const alt = image[1].trim()
  if (alt === '') fail(`${path}: the image needs meaningful alt text, not an empty string`)
  else if (alt.length < 12) warn(`${path}: alt text ${JSON.stringify(alt)} is too terse to describe the picture`)

  const expected = relative('docs', join('docs', imagePath.split('/').at(-1))).split('\\').join('/')
  if (image[2] !== expected) {
    fail(`${path}: the image must be referenced as ${JSON.stringify(expected)}, found ${JSON.stringify(image[2])}`)
  }

  // Anything besides the single image reference belongs in the README; the
  // detail page is a picture, not a manual.
  const rest = body.replace(image[0], '').trim()
  if (rest !== '') {
    const lines = rest.split(/\r?\n/).filter((line) => line.trim() !== '').length
    fail(
      `${path}: ${lines} extra line(s) after the image; the detail page carries only the preview ` +
        'image and long-form text belongs in README.md',
    )
  }
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(join(ROOT, path), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    fail(`${path}: cannot be parsed as JSON (${error.message})`)
    return undefined
  }
}

function checkLocale(path, locale, entry) {
  if (locale === undefined) return fail(`${path}: missing; every plugin ships an en and a zh locale file`)
  const meta = locale.meta
  if (meta === undefined || typeof meta !== 'object' || meta === null) {
    return fail(`${path}: meta must be an object carrying title, description and detail`)
  }

  if (typeof meta.title !== 'string' || meta.title.trim() === '') {
    fail(`${path}: meta.title must be a non-empty product name`)
  } else if (meta.title.includes('-') && /^[a-z0-9-]+$/.test(meta.title)) {
    warn(`${path}: meta.title ${JSON.stringify(meta.title)} looks like the package slug, not a product name`)
  }

  if (typeof meta.description !== 'string' || meta.description.trim() === '') {
    fail(`${path}: meta.description must be a non-empty one-sentence summary`)
  } else {
    const description = meta.description.trim()
    if (description.length > MAX_DESCRIPTION_CHARS) {
      fail(
        `${path}: meta.description is ${description.length} characters; ` +
          `the card subtitle budget is ${MAX_DESCRIPTION_CHARS}`,
      )
    }
    if (/\n/.test(description)) fail(`${path}: meta.description must be a single line`)
    if (/[#*`[\]]|^\s*[-*] /m.test(description)) fail(`${path}: meta.description must be plain text, not Markdown`)
  }

  if (meta.detail === undefined) {
    fail(
      `${path}: meta.detail is missing; without it DSH falls back to README.md and the card shows the whole manual`,
    )
  } else if (typeof meta.detail !== 'string') {
    fail(`${path}: meta.detail must be a string`)
  } else if (meta.detail !== entry.detail) {
    fail(`${path}: meta.detail must be ${JSON.stringify(entry.detail)}`)
  }
}

function coveredByFiles(files, target) {
  return files.some((entry) => {
    const normalized = String(entry).replace(/^\.\//, '')
    if (normalized.endsWith('/')) return target.startsWith(normalized)
    if (!normalized.includes('*')) return target === normalized
    const expression = new RegExp(
      `^${normalized.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`,
    )
    return expression.test(target)
  })
}

async function checkRepository() {
  const manifest = await readJsonIfPresent('package.json')
  if (manifest === undefined) {
    fail('package.json: missing')
    return
  }

  const files = Array.isArray(manifest.files) ? manifest.files : []
  const shipsDocs = files.some((entry) => {
    const normalized = String(entry).replace(/^\.\//, '')
    return normalized === 'docs' || normalized === 'docs/' || normalized.startsWith('docs/')
  })
  if (!shipsDocs) {
    fail('package.json: files must include docs, or the published tarball carries no detail document or preview image')
  }
  if ((manifest.exports ?? {})['./locale/*.json'] === undefined) {
    fail('package.json: exports["./locale/*.json"] is missing; DSH then silently shows the bare package name')
  }

  for (const entry of LANGUAGES) {
    checkLocale(entry.locale, await readJsonIfPresent(entry.locale), entry)

    let detail
    try {
      detail = await readFile(join(ROOT, entry.detail), 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') fail(`${entry.detail}: cannot be read (${error.message})`)
      fail(`${entry.detail}: missing; meta.detail names it and DSH shows an invalid-document error without it`)
    }

    let image
    try {
      image = await readFile(join(ROOT, entry.image), 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') fail(`${entry.image}: cannot be read (${error.message})`)
      fail(`${entry.image}: missing preview image for language ${entry.lang}`)
    }

    if (detail !== undefined && image !== undefined) {
      checkDetailMarkdown(entry.detail, detail, entry.image)
      checkSvg(entry.image, image)
    }
  }
}

// ---------------------------------------------------------------------------
// Lark round-trip. The editing source of truth lives on a Feishu whiteboard;
// these commands only move the SVG between the board and docs/.

const BOARD_FILE = 'docs/PREVIEW.md'

async function readBoards() {
  let source
  try {
    source = await readFile(join(ROOT, BOARD_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${BOARD_FILE} is missing; it records each language's whiteboard`)
    throw error
  }
  const boards = new Map()
  // The registry is a Markdown table whose last cell is the whiteboard token,
  // so the column count stays flexible (doc URL, notes, …) while the language
  // id is always first.
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    const lang = cells[0].replace(/`/g, '').trim()
    if (!/^[a-z]{2}$/.test(lang)) continue
    const token = cells.at(-1).replace(/`/g, '').trim()
    if (!/^[A-Za-z0-9]+$/.test(token)) continue
    boards.set(lang, token)
  }
  if (boards.size === 0) throw new Error(`${BOARD_FILE}: no "| lang | ... | token |" rows found`)
  return boards
}

function runLark(args) {
  const result = spawnSync('lark-cli', args, { cwd: ROOT, encoding: 'utf8' })
  if (result.error !== undefined) throw new Error(`cannot run lark-cli: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`lark-cli exited ${result.status}: ${result.stderr.trim()}`)
  let answer
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    throw new Error(`lark-cli printed no JSON: ${result.stdout.slice(0, 400)}`)
  }
  if (answer.ok !== true) {
    throw new Error(`lark-cli refused: ${answer.error?.message ?? JSON.stringify(answer.error ?? answer)}`)
  }
  return answer.data
}

async function boardFor(lang) {
  const boards = await readBoards()
  const token = boards.get(lang)
  if (token === undefined) throw new Error(`no whiteboard recorded for language ${lang} in ${BOARD_FILE}`)
  const entry = LANGUAGES.find((candidate) => candidate.lang === lang)
  return { token, entry }
}

// The board owns its own canvas: an export comes back at whatever size the
// whiteboard happens to be, which is not the 640x300 detail-banner ratio. A
// pulled file is therefore refitted into the contract canvas instead of
// rejecting it, so editing on the board stays the normal workflow.
const CONTRACT_WIDTH = 640
const CONTRACT_HEIGHT = 300
const CONTRACT_SCALE = 2

function normalizePreview(source) {
  const root = source.match(/<svg\b[^>]*>/i)
  if (root === null) throw new Error('the export has no <svg> root')
  const tag = root[0]
  const openEnd = source.indexOf('>', source.indexOf(root[0])) + 1
  const closeStart = source.lastIndexOf('</svg>')
  if (closeStart < openEnd) throw new Error('the export has no closing </svg>')

  const viewBox = tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]
  const width = Number(tag.match(/\bwidth\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  const height = Number(tag.match(/\bheight\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  let box
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value)) || parts[2] <= 0 || parts[3] <= 0) {
      throw new Error(`the export has an unusable viewBox ${JSON.stringify(viewBox)}`)
    }
    box = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
  } else if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    box = { x: 0, y: 0, width, height }
  } else {
    throw new Error('the export declares neither a usable viewBox nor numeric width and height')
  }

  const inner = source.slice(openEnd, closeStart).trim()
  if (inner === '') throw new Error('the export carries no drawing')

  // The board pads its canvas around the drawing (a 1280x600 artwork comes back
  // as a 1448x800 viewBox with negative offsets). Cropping to the artboard rect
  // keeps the pulled banner full-bleed instead of letterboxed inside the
  // contract canvas. The artboard is the largest rect the export carries.
  const artboard = largestRect(inner)
  if (artboard !== undefined && artboard.width > 0 && artboard.height > 0) {
    box = { x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height }
  }

  const targetWidth = CONTRACT_WIDTH * CONTRACT_SCALE
  const targetHeight = CONTRACT_HEIGHT * CONTRACT_SCALE
  const scale = Math.min(targetWidth / box.width, targetHeight / box.height)
  const translateX = (targetWidth - box.width * scale) / 2 - box.x * scale
  const translateY = (targetHeight - box.height * scale) / 2 - box.y * scale

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${targetWidth}" height="${targetHeight}" ` +
    `viewBox="0 0 ${targetWidth} ${targetHeight}">\n` +
    `<g transform="translate(${translateX.toFixed(2)}, ${translateY.toFixed(2)}) scale(${scale.toFixed(4)})">\n` +
    `${inner}\n</g>\n</svg>\n`
  )
}

// The largest axis-aligned rect in a drawing, used as the artboard when a
// board export pads its canvas. Reads the flat coordinate attributes the board
// writes; a rect inside a nested transform is not considered.
function largestRect(source) {
  let best
  for (const match of source.matchAll(/<rect\b[^>]*>/g)) {
    const tag = match[0]
    const x = Number(tag.match(/\bx\s*=\s*["']([-0-9.]+)/)?.[1] ?? 0)
    const y = Number(tag.match(/\by\s*=\s*["']([-0-9.]+)/)?.[1] ?? 0)
    const width = Number(tag.match(/\bwidth\s*=\s*["']([0-9.]+)/)?.[1])
    const height = Number(tag.match(/\bheight\s*=\s*["']([0-9.]+)/)?.[1])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue
    if (width <= 0 || height <= 0) continue
    if (best === undefined || width * height > best.width * best.height) best = { x, y, width, height }
  }
  return best
}

async function push(lang) {
  const { token, entry } = await boardFor(lang)
  const source = await readFile(join(ROOT, entry.image), 'utf8')
  checkSvg(entry.image, source)
  if (errors.length > 0) throw new Error(`refusing to push an invalid preview:\n  ${errors.join('\n  ')}`)
  runLark([
    'whiteboard', '+update',
    '--whiteboard-token', token,
    '--input_format', 'svg',
    '--source', `@${entry.image}`,
    '--overwrite',
    '--as', 'bot',
  ])
  process.stdout.write(`pushed ${entry.image} to whiteboard ${token} (the board was rebuilt)\n`)
}

async function pull(lang) {
  const { token, entry } = await boardFor(lang)
  const temporary = `${entry.image}.export.svg`
  runLark([
    'whiteboard', '+export',
    '--whiteboard-token', token,
    '--output-type', 'svg',
    '--output', `./${temporary}`,
    '--overwrite',
    '--as', 'bot',
  ])
  const exported = await readFile(join(ROOT, temporary), 'utf8')
  let normalized
  try {
    normalized = normalizePreview(exported)
  } finally {
    await rm(join(ROOT, temporary), { force: true })
  }
  checkSvg(entry.image, normalized)
  if (errors.length > 0) {
    throw new Error(`the exported board does not satisfy the preview contract:\n  ${errors.join('\n  ')}`)
  }
  await writeFile(join(ROOT, entry.image), normalized)
  process.stdout.write(`pulled whiteboard ${token} into ${entry.image} (refitted to the ${CONTRACT_WIDTH}x${CONTRACT_HEIGHT} banner)\n`)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: { lang: { type: 'string' } },
})

const command = positionals[0] ?? 'check'
try {
  if (command === 'check') {
    await checkRepository()
  } else if (command === 'push' || command === 'pull') {
    const lang = values.lang ?? 'zh'
    if (!LANGUAGES.some((entry) => entry.lang === lang)) throw new Error('--lang must be en or zh')
    await (command === 'push' ? push(lang) : pull(lang))
  } else {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected check, push or pull`)
  }
} catch (error) {
  process.stderr.write(`preview: ${error.message}\n`)
  process.exit(1)
}

if (command === 'check') {
  for (const message of warnings) process.stderr.write(`WARN preview: ${message}\n`)
  if (errors.length > 0) {
    for (const message of errors) process.stderr.write(`FAIL preview: ${message}\n`)
    process.stderr.write(`preview: ${errors.length} error(s), ${warnings.length} warning(s).\n`)
    process.exit(1)
  }
  process.stdout.write(`preview: OK (${warnings.length} warning(s)).\n`)
}
