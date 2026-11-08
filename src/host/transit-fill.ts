/**
 * Which days a fill pass should plan, and what their titles claim.
 *
 * A driving trip has days whose only record of the road is the title —
 * 「西安 → 成都｜翻秦岭 723km」 — and the panel already reads them there. This module
 * answers the two questions the Host needs before it plans anything: is this day
 * missing its transit, and which two ends does its title name? Both are pure, so
 * the batch pass can be tested without a provider.
 */

import type { TripDay } from '../domain/trip.js'
import { claimsHop } from '../domain/validation.js'

/** The two ends and the distance a day title states. */
export interface TitleTransfer {
  readonly from?: string
  readonly to?: string
  /** Distance the title states, in metres. */
  readonly distanceMeters?: number
}

/**
 * Thresholds under which a leg is a placeholder rather than a recorded journey.
 *
 * The same rule the panel applies in its own `usableLeg`: a move over a
 * kilometre, **or** one that takes ten minutes, is the day's real road.
 * `travel_day_rebuild_legs` writes the placeholders when two stops resolve to
 * the same point, and those must not hide the title's journey.
 *
 * Both halves matter separately. A 700 m leg can still be a fifteen-minute
 * crawl out of a city, and a 300 m leg can be a ten-minute ferry — calling
 * either one "not recorded" would make the panel offer a fill for a day it
 * already draws.
 */
const MIN_TRANSIT_METERS = 1_000
const MIN_TRANSIT_SECONDS = 600

/** Whether one leg records a real move rather than a two-stop placeholder. */
function recordsMove(leg: { readonly distanceMeters: number; readonly durationSeconds: number }): boolean {
  return leg.distanceMeters >= MIN_TRANSIT_METERS || leg.durationSeconds >= MIN_TRANSIT_SECONDS
}

/**
 * Read the two ends a title names.
 *
 * The patterns deliberately match the panel's own `parseTransferTitle`: the
 * button counts the days the panel offers, and this pass is what answers them,
 * so the two must agree on what a title says. Only the shape of the title is
 * read here — whether it claims a hop at all is `claimsHop`'s business.
 *
 * @param title - day title, e.g. 「西安 → 成都｜翻秦岭 723km」.
 * @returns the two names and the distance, each absent when the title omits it.
 */
export function parseTransferTitle(title: string): TitleTransfer {
  const arrow = /^\s*([^→]+?)\s*(?:→|->|—>)\s*([^｜|·，,（(]+)/.exec(title)
  const km = /(\d[\d,]*(?:\.\d+)?)\s*(?:km|公里)/i.exec(title)
  const from = arrow?.[1]?.trim()
  const to = arrow?.[2]?.trim()
  const amount = km?.[1]
  const metres = amount === undefined ? undefined : Math.round(Number(amount.replace(/,/g, '')) * 1_000)
  return {
    ...from === undefined || from === '' ? {} : { from },
    ...to === undefined || to === '' ? {} : { to },
    ...metres === undefined || !Number.isFinite(metres) ? {} : { distanceMeters: metres },
  }
}

/**
 * Whether a fill pass should try to plan this day.
 *
 * A day qualifies when its title claims a hop and nothing else records one: no
 * transit, and no leg the panel would count as a real move ({@link recordsMove}).
 * That is exactly the day the panel shows as 「跨城交通未记录」 and offers to fill,
 * so the button and the pass agree on which days are missing something.
 *
 * @param day - day under inspection.
 * @returns true when the day is missing a transit its title claims.
 */
export function isTransitFillDay(day: TripDay): boolean {
  if (!claimsHop(day.title)) return false
  if ((day.transits ?? []).length > 0) return false
  return !day.legs.some(recordsMove)
}
