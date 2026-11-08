/**
 * Registration of the skill that ships inside this package.
 *
 * The `travel-planner` skill lives in `skills/travel-planner/` rather than in
 * the user's profile, so installing the plugin is what publishes it. Every step
 * here is best-effort by design: the registry is an optional service, and a
 * profile without it — or a package whose skill file went missing — must still
 * get all `travel_*` tools. Missing service, missing file and unusable
 * frontmatter therefore warn and return; nothing throws out of `apply`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Name the bundled skill is published under; also the `name` in its frontmatter. */
export const TRAVEL_SKILL_NAME = 'travel-planner'

/** File the skill catalog looks for inside a skill directory. */
const SKILL_FILE_NAME = 'SKILL.md'

/**
 * Kebab-case rule the registry applies to a runtime skill name.
 *
 * Restated here on purpose: checking it ourselves turns a registry exception
 * into an explanatory warning, so a typo in the shipped frontmatter reads as
 * "this skill was skipped" instead of "the plugin failed to mount".
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A YAML frontmatter fence line. */
const FENCE_PATTERN = /^---\s*$/

/**
 * Structural slice of the `skills` service this module depends on.
 *
 * Declared locally instead of importing `@deepseek-ai/dsh-skill`: handing the
 * registry one object literal is not worth a runtime dependency, and only a
 * profile that actually provides the service ever resolves this shape.
 */
export interface SkillRegistryLike {
  /**
   * Publish one readonly runtime skill into the calling context's layer.
   * @param skill - the skill definition to publish.
   * @returns the disposer that removes the entry again.
   */
  register(skill: SkillRegistrationLike): () => void
}

/** Payload accepted by {@link SkillRegistryLike.register}. */
export interface SkillRegistrationLike {
  /** Kebab-case skill name. */
  readonly name: string
  /** Single-line description the model uses to decide whether to load the skill. */
  readonly description: string
  /** Skill body in Markdown, without the frontmatter block. */
  readonly content: string
  /** Provenance label; `bundled` marks a skill that shipped inside a package. */
  readonly source: string
  /** Extra "when to use this" hint, omitted when the frontmatter carries none. */
  readonly whenToUse?: string
  /** Absolute path of the `SKILL.md` this registration was read from. */
  readonly path?: string
  /** Directory the model resolves the skill's relative resources against. */
  readonly resourceBase?: SkillResourceBaseLike
}

/** Where a skill's relative resources live; only the directory variant is used here. */
export interface SkillResourceBaseLike {
  /** Discriminator understood by the registry. */
  readonly kind: 'directory'
  /** Absolute directory holding the skill and its `references/`. */
  readonly path: string
}

/** Fields extracted from a bundled `SKILL.md`. */
export interface ParsedSkill {
  /** Skill name, already validated as kebab-case. */
  readonly name: string
  /** Non-empty description. */
  readonly description: string
  /** Optional non-empty hint, absent when the frontmatter omits it. */
  readonly whenToUse?: string
  /** Markdown body with the frontmatter block removed. */
  readonly content: string
}

/**
 * Outcome of parsing a bundled `SKILL.md`.
 *
 * A failure carries the reason so the caller can put it in the warning instead
 * of guessing why the skill was skipped.
 */
export type SkillParseResult =
  | { readonly ok: true; readonly skill: ParsedSkill }
  | { readonly ok: false; readonly reason: string }

/**
 * Absolute path of the skill directory shipped in this package.
 *
 * `src/host/` and `lib/host/` both sit two levels below the package root, so
 * the same relative URL resolves whether the plugin runs from source (tests) or
 * from the built package (an installed profile).
 * @returns absolute path of `skills/travel-planner`, without a trailing separator.
 */
export function bundledSkillDirectory(): string {
  return resolve(fileURLToPath(new URL(`../../skills/${TRAVEL_SKILL_NAME}/`, import.meta.url)))
}

/**
 * Parse the single-line `key: value` frontmatter of a bundled `SKILL.md`.
 *
 * Deliberately not a YAML parser: this file only ever carries string scalars
 * that we control, and a plugin should not pull a YAML dependency to read one
 * of its own resources. A value may be wrapped in one matching pair of quotes,
 * which are stripped; escape sequences are left exactly as written rather than
 * half-interpreted.
 * @param source - full `SKILL.md` text.
 * @returns the parsed skill, or the reason the file was rejected.
 */
export function parseSkillMarkdown(source: string): SkillParseResult {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const first = lines[0]
  if (first === undefined || !FENCE_PATTERN.test(first)) {
    return { ok: false, reason: '缺少 YAML frontmatter 起始分隔行（---）' }
  }

  const fields = new Map<string, string>()
  let fence = -1
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (FENCE_PATTERN.test(line)) {
      fence = index
      break
    }
    const entry = line.trim()
    if (entry === '' || entry.startsWith('#')) continue
    const colon = entry.indexOf(':')
    if (colon <= 0) {
      return { ok: false, reason: `frontmatter 第 ${index + 1} 行不是 key: value 形式：${entry}` }
    }
    fields.set(entry.slice(0, colon).trim(), unquote(entry.slice(colon + 1).trim()))
  }
  if (fence < 0) {
    return { ok: false, reason: 'frontmatter 缺少结束分隔行（---）' }
  }

  const name = fields.get('name') ?? ''
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `name 必须是 kebab-case，当前为：${name === '' ? '（缺失）' : name}` }
  }
  const description = fields.get('description') ?? ''
  if (description === '') {
    return { ok: false, reason: 'description 不能为空' }
  }

  // 正文从结束分隔行之后开始；首尾空白对模型没有意义，一并去掉。
  const content = lines.slice(fence + 1).join('\n').trim()
  if (content === '') {
    return { ok: false, reason: '正文为空' }
  }

  const whenToUse = fields.get('whenToUse') ?? ''
  return {
    ok: true,
    skill: {
      name,
      description,
      content,
      // 空的 whenToUse 视为没写，避免把空串当成有效提示交给模型。
      ...(whenToUse === '' ? {} : { whenToUse }),
    },
  }
}

/**
 * Register the bundled skill into the running profile's skill catalog.
 *
 * Called from `apply` right after the model tools are registered, and returns
 * immediately: the actual registration happens on the injected child fiber,
 * whenever the `skills` service exists. Nothing here is order-sensitive, and
 * nothing here can fail a mount — a profile that never provides a skill
 * registry simply never runs the callback.
 *
 * `skills` is deliberately **not** declared in the plugin's static `inject`:
 * that would hold the whole plugin (tools included) in PENDING until the
 * registry appears, and a profile without one would never mount at all.
 * @param ctx - host plugin context.
 * @param options - `dir` overrides the bundled skill directory (tests only).
 */
export function registerTravelSkill(ctx: Context, options: { readonly dir?: string } = {}): void {
  const logger = loggerOf(ctx)

  // 用动态注入，而不是把 `skills` 写进静态 `inject`：Loader 的 row 是并行应用的，
  // skills 注册表可能比本插件晚挂载。静态 inject 会把**整个插件**按在 PENDING 等它，
  // 而这里只把「注册 skill」这件事推迟到服务出现；profile 始终没有该服务时回调永不执行，
  // 插件照常工作，也不必警告——没有 skill 目录是受支持的组合，不是故障。
  ctx.inject(['skills'], (scoped) => {
    const skills = scoped.get('skills') as SkillRegistryLike | undefined | null
    if (skills === undefined || skills === null || typeof skills.register !== 'function') {
      // 注入保证服务存在；这一条防的是「有 skills 服务但不是注册表」的实现。
      logger.warn('travel-planner: skills 服务不可用于注册，内置 skill 未注册（travel_* 工具不受影响）')
      return
    }
    publishBundledSkill(scoped, skills, logger, options)
  })
}

/**
 * Read, parse and publish the bundled skill on the fiber that owns the injection.
 *
 * Runs inside the injection callback, so every failure path is a warning: a
 * bundled skill is an addition to the profile, never a reason to fail a mount.
 * @param ctx - context of the injection's own fiber.
 * @param skills - the resolved skill registry.
 * @param logger - best-effort logger.
 * @param options - `dir` overrides the bundled skill directory (tests only).
 */
function publishBundledSkill(
  ctx: Context,
  skills: SkillRegistryLike,
  logger: LoggerLike,
  options: { readonly dir?: string },
): void {
  const directory = options.dir ?? bundledSkillDirectory()
  const skillFile = join(directory, SKILL_FILE_NAME)

  let source: string
  try {
    source = readFileSync(skillFile, 'utf8')
  } catch (error) {
    logger.warn(`travel-planner: 读取内置 skill 失败（${skillFile}）：${messageOf(error)}`)
    return
  }

  const parsed = parseSkillMarkdown(source)
  if (!parsed.ok) {
    logger.warn(`travel-planner: 内置 skill 的 frontmatter 不可用（${skillFile}）：${parsed.reason}`)
    return
  }

  const skill = parsed.skill
  let dispose: () => void
  try {
    dispose = skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'bundled',
      path: skillFile,
      // 模型据此把 skill 里提到的相对路径解析到 references/ 等资源上。
      resourceBase: { kind: 'directory', path: directory },
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    })
  } catch (error) {
    logger.warn(`travel-planner: 注册内置 skill 失败：${messageOf(error)}`)
    return
  }

  try {
    // 绑在注入自己的 fiber 上：该 fiber 的撤销登记在父 fiber，所以插件卸载时会一并撤销；
    // 服务被替换时回调重跑，也会先撤掉上一次的注册。绑定失败则立刻回滚，不留无主目录项。
    ctx.effect(() => dispose, `travel-planner: bundled skill ${skill.name}`)
  } catch (error) {
    dispose()
    logger.warn(`travel-planner: 绑定内置 skill 生命周期失败：${messageOf(error)}`)
    return
  }

  logger.info(`travel-planner: 内置 skill 已注册（${skill.name} ← ${skillFile}）`)
}

/** Strip one matching pair of single or double quotes; escapes are not interpreted. */
function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

/** Best-effort error text; a diagnostic must never be the thing that throws. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Best-effort logger surface this module passes around. */
interface LoggerLike {
  /** Record one informational line. */
  info(message: string): void
  /** Record one warning line. */
  warn(message: string): void
}

/** Best-effort logger access; a context without a logger still mounts. */
function loggerOf(ctx: Context): LoggerLike {
  const logger = (ctx as unknown as {
    logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  }).logger
  return {
    info: (message: string) => {
      logger?.info?.(message)
    },
    warn: (message: string) => {
      logger?.warn?.(message)
    },
  }
}
