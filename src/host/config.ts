import z from 'schemastery'

/**
 * Plugin configuration.
 *
 * Deployment-specific values (credential references, executable path, limits)
 * are configuration rather than constants so one installed package can serve
 * different machines without a rebuild.
 */
export interface Config {
  /** Workspace-relative directory holding the trip store. */
  readonly workspaceSubdirectory: string
  /** Default ISO-4217 currency code used when a trip does not set one. */
  readonly currency: string
  /** Default IANA time zone recorded on new trips. */
  readonly timezone: string
  /** HTTP path prefix serving the Client-facing JSON API. */
  readonly httpPath: string
  /** AMap CLI integration settings. */
  readonly amap: AmapConfig
  /** Alert grading settings. */
  readonly alerts: AlertConfig
  /** Presentation settings that decide what may leave the Host. */
  readonly ui: UiConfig
}

/** Presentation settings. */
export interface UiConfig {
  /**
   * Whether provider photo URLs reach the browser.
   *
   * `auto` includes them, so the sidebar can show real POI photos; `off` keeps
   * third-party addresses out of the client entirely.
   */
  readonly placePhotos: 'auto' | 'off'
}

/** AMap CLI settings. */
export interface AmapConfig {
  /** CLI executable resolved from `PATH` unless an absolute path is given. */
  readonly executable: string
  /** DSH credential reference holding the AMap Web (JS API) key. */
  readonly webKeyRef: string
  /** DSH credential reference holding the AMap security key, when the account needs one. */
  readonly securityKeyRef?: string
  /**
   * DSH credential reference holding an AMap **Web-service** key.
   *
   * A Web-service key answers POI queries over HTTPS, so provider facts such as
   * photos and phone numbers no longer need the CLI and its JSAPI container —
   * and therefore never open the AMap desktop window. Absent or unresolvable,
   * the plugin falls back to the CLI.
   */
  readonly restKeyRef?: string
  /**
   * Whether the Sidebar draws its own map with the Web (JS API) key.
   *
   * `auto` hands `webKeyRef`'s key to the browser so the panel renders AMap
   * directly; `off` keeps the key server-side and the panel falls back to its
   * coordinate schematic.
   */
  readonly browserMap: 'auto' | 'off'
  /** Start the AMap container when it is not running. */
  readonly autoStart: boolean
  /**
   * Stop the AMap container on plugin disposal. Applies only when this plugin
   * was the process that started it.
   */
  readonly autoStop: boolean
  /** Per-command timeout budget in milliseconds. */
  readonly commandTimeoutMs: number
  /** POI search cache lifetime in milliseconds. */
  readonly poiCacheTtlMs: number
  /** Route cache lifetime in milliseconds. */
  readonly routeCacheTtlMs: number
}

/**
 * Alert grading settings.
 *
 * `routeStaleMode` decides how much an expired route costs: `adaptive` only
 * warns when the day it serves is near, so a plan made weeks ahead does not
 * lose readiness to routes that would expire again before departure.
 */
export interface AlertConfig {
  /** How strictly route staleness is graded. */
  readonly routeStaleMode: 'adaptive' | 'strict'
}

/** Configuration schema. Every default here is intentionally deployment-neutral. */
export const Config = z.object({
  workspaceSubdirectory: z.string().default('.travel'),
  currency: z.string().default('CNY'),
  timezone: z.string().default('Asia/Shanghai'),
  httpPath: z.string().default('/api/skillre-travel'),
  ui: z
    .object({
      placePhotos: z.union([z.const('auto'), z.const('off')]).default('auto'),
    })
    .default({ placePhotos: 'auto' }),
  alerts: z
    .object({
      routeStaleMode: z.union([z.const('adaptive'), z.const('strict')]).default('adaptive'),
    })
    .default({ routeStaleMode: 'adaptive' }),
  amap: z
    .object({
      executable: z.string().default('amap-gui'),
      webKeyRef: z.string().required(),
      securityKeyRef: z.string(),
      restKeyRef: z.string().default('AMAP_REST_KEY'),
      browserMap: z.union([z.const('auto'), z.const('off')]).default('auto'),
      autoStart: z.boolean().default(true),
      autoStop: z.boolean().default(true),
      commandTimeoutMs: z.natural().default(45000),
      poiCacheTtlMs: z.natural().default(86_400_000),
      routeCacheTtlMs: z.natural().default(21_600_000),
    })
    .required(),
})

/** Bounds applied to a validated configuration so a bad deployment fails closed. */
export const CONFIG_LIMITS = {
  /** Minimum accepted command timeout. */
  minCommandTimeoutMs: 1_000,
  /** Maximum accepted command timeout. */
  maxCommandTimeoutMs: 600_000,
  /** Maximum accepted cache lifetime. */
  maxCacheTtlMs: 30 * 24 * 60 * 60 * 1_000,
} as const

/**
 * Clamp one configuration value into its accepted range.
 * @param value - configured value.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped integer.
 */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Apply bounds and defaults that the schema alone does not express.
 * @param config - schema-validated configuration.
 * @returns a normalized configuration safe to use at runtime.
 */
export function normalizeConfig(config: Config): Config {
  const subdirectory = config.workspaceSubdirectory.trim() === '' ? '.travel' : config.workspaceSubdirectory.trim()
  const httpPath = normalizeHttpPath(config.httpPath)
  const executable = config.amap.executable.trim() === '' ? 'amap-gui' : config.amap.executable.trim()
  const securityKeyRef = config.amap.securityKeyRef?.trim()
  const restKeyRef = config.amap.restKeyRef?.trim()
  return {
    workspaceSubdirectory: subdirectory,
    currency: config.currency.trim() === '' ? 'CNY' : config.currency.trim().toUpperCase(),
    timezone: config.timezone.trim() === '' ? 'Asia/Shanghai' : config.timezone.trim(),
    httpPath,
    alerts: { routeStaleMode: config.alerts.routeStaleMode },
    ui: { placePhotos: config.ui.placePhotos },
    amap: {
      executable,
      webKeyRef: config.amap.webKeyRef.trim(),
      ...securityKeyRef !== undefined && securityKeyRef !== '' ? { securityKeyRef } : {},
      ...restKeyRef !== undefined && restKeyRef !== '' ? { restKeyRef } : {},
      browserMap: config.amap.browserMap,
      autoStart: config.amap.autoStart,
      autoStop: config.amap.autoStop,
      commandTimeoutMs: clampInt(
        config.amap.commandTimeoutMs,
        CONFIG_LIMITS.minCommandTimeoutMs,
        CONFIG_LIMITS.maxCommandTimeoutMs,
      ),
      poiCacheTtlMs: clampInt(config.amap.poiCacheTtlMs, 0, CONFIG_LIMITS.maxCacheTtlMs),
      routeCacheTtlMs: clampInt(config.amap.routeCacheTtlMs, 0, CONFIG_LIMITS.maxCacheTtlMs),
    },
  }
}

/**
 * Normalize the HTTP path prefix into an absolute path without a trailing slash.
 *
 * The default sits under `/api` so an existing `/api`-scoped front-door rule
 * still covers it. It does not inherit the Web GUI's browser-trust fence:
 * `webServer.register` routes are matched before the fence, which lives inside
 * the shipped `/api` handler. Keep the server bound to loopback, or authenticate
 * in front of it.
 *
 * @param path - configured path.
 * @returns the normalized prefix.
 */
export function normalizeHttpPath(path: string): string {
  const trimmed = path.trim()
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const withoutTrailing = prefixed.endsWith('/') ? prefixed.replace(/\/+$/, '') : prefixed
  return withoutTrailing === '' ? '/api/skillre-travel' : withoutTrailing
}
