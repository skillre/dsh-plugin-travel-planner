/**
 * Bundled-skill coverage for the travel planner.
 *
 * Everything here runs against a fake `Context` and a fake registry: no real
 * Cordis fiber and no profile. The spec pins the payload handed to the
 * registry, the Fiber binding of the disposer it returns, and every
 * soft-landing path — a missing service, a missing file and unusable
 * frontmatter must each warn and leave the plugin mounted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { bundledSkillDirectory, parseSkillMarkdown, registerTravelSkill } from '../src/host/skill.js'
import type { ParsedSkill, SkillRegistrationLike } from '../src/host/skill.js'

/** Assert a value is present and narrow it for the rest of the test. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`)
  return value
}

/** Parse a `SKILL.md` or fail with the parser's own reason, so a bad file is diagnosable. */
function requireParsed(source: string): ParsedSkill {
  const parsed = parseSkillMarkdown(source)
  if (!parsed.ok) throw new Error(`expected the SKILL.md to parse, but it was rejected: ${parsed.reason}`)
  return parsed.skill
}

/** Read the real bundled `SKILL.md`, failing with a clear message when it is missing. */
function readBundledSkillMarkdown(): string {
  const skillFile = join(bundledSkillDirectory(), 'SKILL.md')
  expect(
    existsSync(skillFile),
    `内置 skill 文件不存在：${skillFile}。它由 skills/travel-planner/SKILL.md 随包发布；本测试要求该文件已存在。`,
  ).toBe(true)
  return readFileSync(skillFile, 'utf8')
}

/** Registry double: records every payload and counts disposal calls. */
function registryDouble(): {
  readonly registry: { register(skill: SkillRegistrationLike): () => void }
  readonly registered: SkillRegistrationLike[]
  readonly disposeCount: () => number
} {
  const registered: SkillRegistrationLike[] = []
  let disposed = 0
  return {
    registered,
    disposeCount: () => disposed,
    registry: {
      register: (skill: SkillRegistrationLike) => {
        registered.push(skill)
        return () => {
          disposed += 1
        }
      },
    },
  }
}

/** Harness returned by {@link fakeContext}. */
interface FakeContext {
  /** The plugin context handed to `registerTravelSkill`. */
  readonly ctx: Context
  /** Dispose the plugin's fibers, as the runtime does on unload. */
  readonly unload: () => void
  /** Deliver a service that was missing when the plugin applied. */
  readonly provide: (value: unknown) => void
  /** Dependency lists passed to `ctx.inject`, in call order. */
  readonly injected: string[][]
  /** Warning lines the plugin logged. */
  readonly warnings: string[]
  /** Info lines the plugin logged. */
  readonly infos: string[]
}

/**
 * Build a fake context whose lifecycle mirrors Cordis.
 *
 * `effect` behaves like a fiber: the callback runs there and then, and the
 * disposer it returns is what teardown calls later. `inject` behaves like
 * `ctx.plugin({ inject, apply })`: the callback runs as soon as its service
 * exists — immediately when the service is already present, otherwise when
 * {@link FakeContext.provide} makes it appear, which is how a loader row that
 * mounts later is modelled.
 */
function fakeContext(options: { readonly skills?: unknown; readonly effectThrows?: boolean }): FakeContext {
  const disposers: (() => void)[] = []
  const warnings: string[] = []
  const infos: string[] = []
  const injected: string[][] = []
  const pending: (() => void)[] = []
  let skills = options.skills

  /**
   * Build the context handed to an injection callback.
   *
   * It writes into the same effect list as the parent: the child fiber's
   * disposal is registered on the parent fiber, so unloading the plugin tears
   * the child's effects down too.
   */
  const childContext = (): Context =>
    ({
      get: (name: string) => (name === 'skills' ? skills : undefined),
      effect: (callback: () => unknown) => {
        if (options.effectThrows === true) throw new Error('cannot create effect on inactive context')
        const disposer = callback()
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
        return () => undefined
      },
      logger: {
        info: (message: string) => infos.push(message),
        warn: (message: string) => warnings.push(message),
      },
    }) as unknown as Context

  const runPending = (): void => {
    while (skills !== undefined && pending.length > 0) {
      const run = pending.shift()
      run?.()
    }
  }

  const ctx = {
    get: (name: string) => (name === 'skills' ? skills : undefined),
    effect: (callback: () => unknown) => {
      if (options.effectThrows === true) throw new Error('cannot create effect on inactive context')
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return () => undefined
    },
    inject: (deps: readonly string[], callback: (scoped: Context) => void) => {
      injected.push([...deps])
      if (deps.includes('skills') && skills === undefined) {
        pending.push(() => {
          callback(childContext())
        })
        return
      }
      callback(childContext())
    },
    logger: {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
    },
  } as unknown as Context

  return {
    ctx,
    warnings,
    infos,
    injected,
    provide: (value: unknown) => {
      skills = value
      runPending()
    },
    unload: () => {
      // Cordis 按注册的反序撤销同一 fiber 的 effect。
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

/** Run a body against a throwaway skill directory that is always removed again. */
function withTempSkillDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'travel-skill-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('bundledSkillDirectory', () => {
  it('resolves to the skill directory shipped in this package', () => {
    const directory = bundledSkillDirectory()

    expect(directory.endsWith(join('skills', 'travel-planner'))).toBe(true)
    // `fileURLToPath` 保留 URL 末尾的斜杠，`resolve` 去掉它，路径读起来才和其它目录一致。
    expect(/[\\/]$/.test(directory)).toBe(false)
    expect(existsSync(join(directory, 'SKILL.md'))).toBe(true)
  })
})

describe('parseSkillMarkdown', () => {
  it('parses the SKILL.md shipped in this repository', () => {
    const parsed = requireParsed(readBundledSkillMarkdown())

    expect(parsed.name).toBe('travel-planner')
    expect(parsed.description.length).toBeGreaterThan(0)
    // 引号必须已经剥掉，否则模型看到的描述会带引号。
    expect(parsed.description.startsWith('"')).toBe(false)
    if (parsed.whenToUse !== undefined) expect(parsed.whenToUse.length).toBeGreaterThan(0)

    // 正文既不能以分隔行开头，也不能留下任何 frontmatter 分隔行或字段行。
    expect(parsed.content.startsWith('---')).toBe(false)
    expect(parsed.content).not.toMatch(/^---\s*$/m)
    expect(parsed.content).not.toMatch(/^(name|description|whenToUse):/m)
    expect(parsed.content.length).toBeGreaterThan(0)
  })

  it('strips one matching pair of quotes and keeps unquoted values as written', () => {
    const parsed = requireParsed(
      ['---', 'name: travel-planner', 'description: "带引号"', "whenToUse: '单引号'", '---', '', '# 正文'].join('\n'),
    )

    expect(parsed.description).toBe('带引号')
    expect(parsed.whenToUse).toBe('单引号')
    expect(parsed.content).toBe('# 正文')
  })

  it('rejects a file without frontmatter', () => {
    const parsed = parseSkillMarkdown('# 只有正文\n')

    expect(parsed.ok).toBe(false)
  })

  it('rejects a frontmatter without a closing fence', () => {
    const parsed = parseSkillMarkdown('---\nname: travel-planner\ndescription: 描述\n')

    expect(parsed.ok).toBe(false)
  })

  it('rejects a frontmatter whose name is not kebab-case', () => {
    const parsed = parseSkillMarkdown('---\nname: Travel Planner\ndescription: 描述\n---\n\n# 正文\n')

    expect(parsed.ok).toBe(false)
  })

  it('rejects a frontmatter without a description', () => {
    const parsed = parseSkillMarkdown('---\nname: travel-planner\n---\n\n# 正文\n')

    expect(parsed.ok).toBe(false)
  })
})

describe('registerTravelSkill', () => {
  it('registers the bundled skill with its frontmatter, path and resource base', () => {
    const double = registryDouble()
    const fake = fakeContext({ skills: double.registry })
    const parsed = requireParsed(readBundledSkillMarkdown())
    const directory = bundledSkillDirectory()

    registerTravelSkill(fake.ctx)

    const skill = required(double.registered[0], 'one registration')
    expect(skill.name).toBe('travel-planner')
    expect(skill.description).toBe(parsed.description)
    expect(skill.whenToUse).toBe(parsed.whenToUse)
    expect(skill.content).toBe(parsed.content)
    expect(skill.source).toBe('bundled')
    expect(skill.path).toBe(join(directory, 'SKILL.md'))
    expect(skill.path !== undefined && existsSync(skill.path)).toBe(true)
    expect(skill.resourceBase).toEqual({ kind: 'directory', path: directory })
    // 资源基目录必须是真正放着 SKILL.md 的那一个，模型才能据此找到 references/。
    expect(skill.resourceBase !== undefined && existsSync(join(skill.resourceBase.path, 'SKILL.md'))).toBe(true)
    expect(fake.warnings).toEqual([])

    // 注册只是开始：Fiber 卸载时目录项必须被撤销。
    expect(double.disposeCount()).toBe(0)
    fake.unload()
    expect(double.disposeCount()).toBe(1)
  })

  it('registers without warning when the profile has no skills service', () => {
    const double = registryDouble()
    const fake = fakeContext({})

    expect(() => {
      registerTravelSkill(fake.ctx)
    }).not.toThrow()

    // 没有 skill 目录是受支持的组合，不是故障：既不该注册，也不该报警。
    expect(double.registered).toEqual([])
    expect(fake.warnings).toEqual([])
  })

  it('still registers when the skills service arrives after the plugin applied', () => {
    const double = registryDouble()
    const fake = fakeContext({})

    registerTravelSkill(fake.ctx)
    // 服务还没到，注入只是挂在那里。
    expect(double.registered).toEqual([])
    expect(fake.injected).toEqual([['skills']])

    // Loader 的另一行稍后挂载 skills 注册表。
    fake.provide(double.registry)

    const skill = required(double.registered[0], 'one registration')
    expect(skill.name).toBe('travel-planner')
    expect(skill.source).toBe('bundled')
    expect(fake.warnings).toEqual([])

    // 即便注册发生在稍后的注入回调里，卸载仍然必须撤销它。
    expect(double.disposeCount()).toBe(0)
    fake.unload()
    expect(double.disposeCount()).toBe(1)
  })

  it('keeps `skills` out of the static inject list', async () => {
    const plugin = await import('../src/index.js')

    // 静态 inject 会把整个插件按在 PENDING 等注册表；skills 只能走动态注入。
    expect([...plugin.inject]).not.toContain('skills')

    const fake = fakeContext({})
    registerTravelSkill(fake.ctx)
    expect(fake.injected).toEqual([['skills']])
  })

  it('warns and registers nothing when SKILL.md is missing', () => {
    const double = registryDouble()
    const fake = fakeContext({ skills: double.registry })

    withTempSkillDir((dir) => {
      expect(() => {
        registerTravelSkill(fake.ctx, { dir })
      }).not.toThrow()
    })

    expect(double.registered).toEqual([])
    expect(fake.warnings.some((warning) => warning.includes('SKILL.md'))).toBe(true)
  })

  it('warns and registers nothing when the frontmatter is unusable', () => {
    const double = registryDouble()
    const fake = fakeContext({ skills: double.registry })

    withTempSkillDir((dir) => {
      writeFileSync(join(dir, 'SKILL.md'), '# 没有 frontmatter\n', 'utf8')
      expect(() => {
        registerTravelSkill(fake.ctx, { dir })
      }).not.toThrow()
    })

    expect(double.registered).toEqual([])
    expect(fake.warnings.some((warning) => warning.includes('frontmatter'))).toBe(true)
  })

  it('reads an explicit directory without touching the bundled one', () => {
    const double = registryDouble()
    const fake = fakeContext({ skills: double.registry })

    withTempSkillDir((dir) => {
      writeFileSync(
        join(dir, 'SKILL.md'),
        ['---', 'name: travel-planner', 'description: 临时描述', 'whenToUse: 临时场景', '---', '', '# 临时正文'].join('\n'),
        'utf8',
      )
      registerTravelSkill(fake.ctx, { dir })
    })

    const skill = required(double.registered[0], 'one registration')
    expect(skill.description).toBe('临时描述')
    expect(skill.whenToUse).toBe('临时场景')
    expect(skill.content).toBe('# 临时正文')
  })

  it('rolls the registration back when the fiber binding fails', () => {
    const double = registryDouble()
    const fake = fakeContext({ skills: double.registry, effectThrows: true })

    expect(() => {
      registerTravelSkill(fake.ctx)
    }).not.toThrow()

    expect(double.registered).toHaveLength(1)
    expect(double.disposeCount()).toBe(1)
    expect(fake.warnings.length).toBeGreaterThan(0)
  })
})

describe('plugin wiring', () => {
  it('calls registerTravelSkill from apply', () => {
    // 文本断言而非行为断言：直接跑 apply 会拉起整个 host 层（fs、subprocess、
    // travel-service），与本仓库并行改动耦合太大。这里只锁住接线本身。
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

    expect(source).toMatch(/from '\.\/host\/skill\.js'/)
    expect(source).toMatch(/\bregisterTravelSkill\(ctx\)/)
  })
})
