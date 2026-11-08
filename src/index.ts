import type { Context } from '@deepseek-ai/cordis'
import { AmapCliError } from './host/amap/cli.js'
import { createSubprocessExec, delayFrom, type SubprocessLike } from './host/amap/exec.js'
import { AmapGateway } from './host/amap/gateway.js'
import { Config as ConfigSchema, normalizeConfig, type Config as TravelPlannerConfig } from './host/config.js'
import { registerTravelSkill } from './host/skill.js'
import { registerTravelTools } from './host/tools.js'
import { TravelService } from './host/travel-service.js'
import type { TripFs, TripFsTarget } from './host/trip-store.js'
import type { TravelPlannerApi } from './host/web-api.js'

export * from './domain/index.js'
export type { TravelPlannerApi } from './host/web-api.js'
export type { TravelPlannerConfig }

/** Cordis plugin name. Keep it stable after the first public release. */
export const name = 'skillre-travel-planner'

/**
 * Service name of the capability this row publishes for the web carrier row.
 *
 * The store, the CLI gateway, and its serialized queue must exist once per
 * process, so the browser API consumes this facade instead of building a
 * second one.
 */
export const PLANNER_SERVICE = 'travelPlanner'

/**
 * Hard dependencies.
 *
 * Loader rows apply in parallel, so a service read with `ctx.get('fs')` at
 * apply time can legitimately be missing even though the profile composes it;
 * a declared injection makes Cordis wait for the service and apply afterwards.
 * `tools` receives the `travel_*` tools, `timer` backs every CLI deadline,
 * `fs` stores trip projects, and `subprocess` runs the AMap CLI.
 *
 * `credentials` and `sessions` stay optional: both are read inside a call, by
 * which time every service of the profile is registered, and a profile without
 * them degrades to "no credential" and "process working directory" instead of
 * never mounting.
 */
export const inject = ['tools', 'timer', 'fs', 'subprocess']

/** Configuration schema. */
export const Config = ConfigSchema

/**
 * Host half: own the trip store, the AMap CLI gateway, the `travel_*` model
 * tools, and the capability the browser API row consumes.
 * @param ctx - host plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: TravelPlannerConfig): void {
  const settings = normalizeConfig(config)

  const fs = ctx.get('fs')
  if (fs === undefined) {
    throw new Error('travel-planner: the declared `fs` injection resolved to nothing; the trip store cannot be created')
  }
  const tripFs = tripFsFrom(fs)

  let credentialState: { readonly configured: boolean; readonly missing: readonly string[] } = {
    configured: false,
    missing: [settings.amap.webKeyRef],
  }

  /**
   * Resolve the CLI environment for one invocation.
   *
   * Credentials are read per call, never cached across operations and never
   * logged; only the reference names can appear in diagnostics.
   */
  const resolveEnv = async (): Promise<Readonly<Record<string, string>>> => {
    const credentials = ctx.get('credentials')
    const values: Record<string, string> = {}
    const missing: string[] = []
    const webKey = await resolveCredential(credentials, settings.amap.webKeyRef)
    if (webKey === undefined) missing.push(settings.amap.webKeyRef)
    else values['AMAP_KEY'] = webKey
    if (settings.amap.securityKeyRef !== undefined) {
      const securityKey = await resolveCredential(credentials, settings.amap.securityKeyRef)
      if (securityKey === undefined) missing.push(settings.amap.securityKeyRef)
      else values['AMAP_SECURITY_KEY'] = securityKey
    }
    credentialState = { configured: webKey !== undefined, missing }
    if (webKey === undefined) {
      throw new AmapCliError(
        'AMAP_CREDENTIAL_MISSING',
        `缺少高德 Web Key：请在 DSH 凭据中配置 ${settings.amap.webKeyRef}，或在配置中改用已有的引用名。`,
      )
    }
    return values
  }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new Error('travel-planner: the declared `subprocess` injection resolved to nothing; the AMap CLI cannot run')
  }
  const gateway = new AmapGateway({
    exec: createSubprocessExec(subprocessFrom(subprocess), delayFrom(ctx)),
    env: resolveEnv,
    cwd: process.cwd(),
    amap: settings.amap,
    logger: loggerOf(ctx),
  })
  ctx.effect(
    () => () => {
      // Idempotent; stops the container only when this plugin started it.
      void gateway.dispose()
    },
    'travel-planner: amap-gui lifecycle',
  )

  const service = new TravelService({
    fs: tripFs,
    subdirectory: settings.workspaceSubdirectory,
    currency: settings.currency,
    fallbackCwd: process.cwd(),
    cwdFor: async (sessionId) => resolveCwd(ctx.get('sessions'), sessionId),
    clock: () => Date.now(),
    gateway: () => gateway,
    // A Web-service key answers POI fact queries directly, so a photo lookup
    // never has to open the CLI container (and its window).
    restKey: async () => await resolveCredential(ctx.get('credentials'), settings.amap.restKeyRef ?? 'AMAP_REST_KEY'),
    routeStaleMode: settings.alerts.routeStaleMode,
    includePhotos: settings.ui.placePhotos === 'auto',
    browserMapEnabled: settings.amap.browserMap === 'auto',
    // The Web (JS API) key is what AMap hands to any browser that draws a map,
    // so the panel may carry it; the security key never leaves the host.
    browserMapKey: async () => await resolveCredential(ctx.get('credentials'), settings.amap.webKeyRef),
  })

  registerTravelTools(ctx, {
    service,
    currency: settings.currency,
    timezone: settings.timezone,
  })

  // 插件自带的使用说明随包发布，装上即可用；注册是可选的，失败只 warning。
  registerTravelSkill(ctx)

  const api: TravelPlannerApi = {
    service,
    httpPath: settings.httpPath,
    configuration: () => credentialState,
  }
  ctx.effect(() => ctx.provide(PLANNER_SERVICE, api), 'travel-planner: planner capability')
}

/** Resolve one credential reference without ever exposing the value to a log. */
async function resolveCredential(credentials: unknown, ref: string): Promise<string | undefined> {
  if (credentials === undefined) return undefined
  const provider = credentials as { resolve?: (key: string) => Promise<{ value: string } | undefined> }
  if (typeof provider.resolve !== 'function') return undefined
  const resolved = await provider.resolve(ref)
  const value = resolved?.value
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read the working directory owning one session, without touching session content. */
async function resolveCwd(sessions: unknown, sessionId?: string): Promise<string> {
  if (sessions !== undefined && sessionId !== undefined) {
    const store = sessions as { get?: (id: string) => { header?: { cwd?: string } } | undefined }
    if (typeof store.get === 'function') {
      const cwd = store.get(sessionId)?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    }
  }
  return process.cwd()
}

/** Adapt the abstract filesystem service to the trip store's structural slice. */
function tripFsFrom(fs: unknown): TripFs {
  const service = fs as {
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<object>
    readText(target: object, signal?: AbortSignal): Promise<string>
    writeText(target: object, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
    listDir(target: object, signal?: AbortSignal): Promise<readonly { name: string }[]>
    stat(target: object, signal?: AbortSignal): Promise<unknown | undefined>
  }
  return {
    resolve: async (path: string, cwd?: string): Promise<TripFsTarget> => service.resolve(path, cwd === undefined ? {} : { cwd }),
    readText: (target: TripFsTarget) => service.readText(target),
    writeText: (target: TripFsTarget, content: string) => service.writeText(target, content),
    listDir: async (target: TripFsTarget) => (await service.listDir(target)).map((entry) => entry.name),
    exists: async (target: TripFsTarget) => (await service.stat(target)) !== undefined,
  }
}

/** Adapt the subprocess service to the executor's structural slice. */
function subprocessFrom(value: unknown): SubprocessLike {
  return value as SubprocessLike
}

/** Best-effort logger access. */
function loggerOf(ctx: Context): { info(message: string): void; warn(message: string): void } {
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
