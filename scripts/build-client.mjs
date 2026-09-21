#!/usr/bin/env node
/**
 * Wrap the compiled browser half in the DSH client-module envelope.
 *
 * The shell serves every `dsh.client` bundle as one lazy-CJS registration:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 *
 * `tsc` emits plain CommonJS for `.client-build/client/index.js`, whose only
 * runtime import is the baseline `react` module, so wrapping is a pure textual
 * envelope and needs no bundler. Relative imports inside the browser half are
 * type-only by construction, so no relative `require` survives compilation.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const compiled = join(root, '.client-build', 'client', 'index.js')
const output = join(root, 'lib', 'client.js')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const moduleId = pkg.name

/** Indent every line of the compiled body by one tab. */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `\t\t${line}`))
    .join('\n')
}

const body = await readFile(compiled, 'utf8')
const envelope = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(moduleId)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${indent(body)}
\t\treturn module.exports;
\t}
});
`

await mkdir(dirname(output), { recursive: true })
await writeFile(output, envelope, 'utf8')
await rm(join(root, '.client-build'), { recursive: true, force: true })

process.stdout.write(`built ${output} (${String(envelope.length)} bytes)\n`)
