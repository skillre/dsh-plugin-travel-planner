#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const artifactDirectory = join(root, 'release-artifact')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))

if (compatibility.schemaVersion !== 1) {
  throw new Error('compatibility.json schemaVersion must be 1')
}
if (compatibility.package !== manifest.name) {
  throw new Error('compatibility.json package must match package.json name')
}
if (!Array.isArray(compatibility.verified) || compatibility.verified.length === 0) {
  throw new Error('At least one verified DSH compatibility record is required before release')
}
for (const [index, record] of compatibility.verified.entries()) {
  const label = `compatibility.json verified[${index}]`
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${label} must be an object`)
  }
  if (typeof record.dsh !== 'string' || record.dsh === '') throw new Error(`${label}.dsh is required`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.verifiedAt ?? '')) {
    throw new Error(`${label}.verifiedAt must be an ISO date`)
  }
  if (record.result !== 'passed') throw new Error(`${label}.result must be passed`)
  if (
    !Array.isArray(record.checks) ||
    !record.checks.includes('dump-config') ||
    !record.checks.includes('bounded-startup')
  ) {
    throw new Error(`${label}.checks must include dump-config and bounded-startup`)
  }
  if (manifest.dsh?.client !== undefined && !record.checks.includes('browser')) {
    throw new Error(`${label}.checks must include browser for a Client package`)
  }
}

await rm(artifactDirectory, { recursive: true, force: true })
await mkdir(artifactDirectory)
const packed = spawnSync(
  'npm',
  ['pack', '--json', '--ignore-scripts', '--pack-destination', artifactDirectory],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)
if (packed.error !== undefined) throw packed.error
if (packed.status !== 0) throw new Error(`npm pack exited ${packed.status ?? 'without status'}`)

const results = JSON.parse(packed.stdout)
if (!Array.isArray(results) || results.length !== 1 || typeof results[0]?.filename !== 'string') {
  throw new Error('npm pack must produce exactly one tarball')
}
const result = results[0]
const packedPaths = new Set((result.files ?? []).map((file) => file.path))
for (const required of ['package.json', 'compatibility.json', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts']) {
  if (!packedPaths.has(required)) throw new Error(`Release tarball is missing ${required}`)
}
await copyFile(join(root, 'CHANGELOG.md'), join(artifactDirectory, 'CHANGELOG.md'))
await writeFile(
  join(artifactDirectory, 'release.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      package: manifest.name,
      version: manifest.version,
      tag: `v${manifest.version}`,
      tarball: result.filename,
      integrity: result.integrity,
      shasum: result.shasum,
    },
    null,
    2,
  )}\n`,
)
process.stdout.write(`Prepared ${result.filename} without publishing it.\n`)
