import type { Context } from '@deepseek-ai/cordis'
import type { TravelService } from './travel-service.js'
import { registerTravelHttp, type WebServerLike } from './http.js'

/** Runtime facts the browser half reads about credentials and the AMap CLI. */
export interface PlannerConfiguration {
  readonly configured: boolean
  readonly missing: readonly string[]
}

/**
 * The host capability the main row publishes and this row consumes.
 *
 * One instance of the store and the CLI gateway must serve both the model
 * tools and the browser API, so the web row never builds its own: it injects
 * the provided facade instead.
 */
export interface TravelPlannerApi {
  /** The shared travel service. */
  readonly service: TravelService
  /** The configured HTTP prefix for the browser API. */
  readonly httpPath: string
  /** Credential readiness, resolved per request. */
  readonly configuration: () => PlannerConfiguration
}

/** Cordis plugin name of the web carrier row. */
export const name = 'skillre-travel-planner/web'

/**
 * Hard dependencies: the HTTP carrier, and the planner capability published by
 * the main row. Declaring `webServer` as a plugin-level injection is what makes
 * this row bind to the live server instance — a nested `ctx.inject` can bind an
 * earlier, already-replaced provider and silently lose its routes.
 */
export const inject = ['webServer', 'travelPlanner']

/**
 * Web row: serve the browser JSON API and publish the API path to the client.
 * @param ctx - host plugin context carrying the live web server.
 */
export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const api = ctx.get('travelPlanner') as TravelPlannerApi | undefined
  if (webServer === undefined || api === undefined) {
    throw new Error('travel-planner: the web row requires the `webServer` service and the `travelPlanner` capability')
  }

  ctx.effect(
    () =>
      registerTravelHttp(ctx, webServer, api.httpPath, {
        service: api.service,
        configuration: api.configuration,
      }),
    'travel-planner: browser api',
  )

  // `tapIndex` reads service state through `this`, so it must stay bound to
  // the server instance; calling a detached reference throws.
  const tapIndex = webServer.tapIndex?.bind(webServer)
  if (tapIndex !== undefined) {
    ctx.effect(
      () => tapIndex((html: string) => injectBootConfig(html, api.httpPath)),
      'travel-planner: boot config',
    )
  }
}

/**
 * Publish the API path to the browser half.
 *
 * The sidebar bundle must address the host's HTTP prefix, which is a
 * deployment value; this is the one boot fact the client cannot derive. `<` is
 * escaped so the injected script cannot terminate its own element.
 * @param html - index document.
 * @param apiPath - configured API prefix.
 * @returns the document with one boot configuration script in its head.
 */
export function injectBootConfig(html: string, apiPath: string): string {
  const payload = JSON.stringify({ apiPath }).replaceAll('<', '\\u003c')
  const script = `<script>window.__SKILLRE_TRAVEL__=${payload}</script>`
  const headClose = html.indexOf('</head>')
  return headClose === -1 ? `${script}${html}` : `${html.slice(0, headClose)}${script}${html.slice(headClose)}`
}
