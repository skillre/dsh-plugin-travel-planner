import type { Context } from '@deepseek-ai/cordis'

/**
 * Structural mirror of the DSH client contracts this bundle consumes.
 *
 * Queried from the live runtime on 2026-09-14 (DSH `0.1.5-rc.2`):
 * `Slots.listSubTree` for `sidebar.right.pane.tab` and
 * `sidebar.right.pane.tab.title`, and the `@deepseek-ai/dsh-client-ui-sidebar-right`
 * declarations for `ctx.sidebarRightTabs` / `SidebarRightTabDefinition`.
 *
 * They are mirrored rather than imported so this package does not pull the
 * whole client package graph into its own build. Re-query the live contracts
 * before widening this surface, and treat a mismatch as a compatibility
 * finding rather than a reason to loosen the mirror.
 */

/** One teardown callback returned by every registration. */
export type Disposer = () => void

/** Component type React receives from the slot registry. */
export type SlotComponent = (props: never) => unknown

/** Registration options accepted by the slot registry. */
export interface SlotRegisterOptions {
  /** Target slot name, e.g. `sidebar.right.pane.tab`. */
  readonly name: string
  /** Cell key; for a keyed slot the definition's own id. */
  readonly key?: string
  /** Locale namespace bound to the component, when the registrant has copy. */
  readonly locale?: string
  /** Registrant-owned store, when the component needs one. */
  readonly store?: unknown
  /** Registrant-owned hook face delivered to the component. */
  readonly inject?: () => unknown
}

/** The slot registry face a client plugin uses. */
export interface SlotsLike {
  /** Wait for a slot declaration, then run the registration callback. */
  inject(slot: string, callback: () => Disposer | Disposer[]): Disposer
  /** Register one contribution; returns its disposer. */
  register(options: SlotRegisterOptions, component: SlotComponent): Disposer
}

/** One guide entry offered by a tab type. */
export interface SidebarRightGuideEntryLike {
  /** Ascending position among every registered type's entries. */
  readonly order: number
  /** Capsule title in the current language. */
  readonly title: () => string
  /** Optional one-line description. */
  readonly description?: () => string
}

/** Stage-one tab type definition. */
export interface SidebarRightTabDefinitionLike {
  /** Unique implementation identity in the tab system. */
  readonly id: string
  /** Type discriminator: what `openTab` names. */
  readonly kind: string
  /** Ranking band for resource claims; `extension` is the highest. */
  readonly priority?: 'extension' | 'builtin' | 'fallback'
  /** Chip title captured at open time. */
  readonly title: (address: string) => string
  /** Optional guide-page entry boxes. */
  readonly guide?: readonly SidebarRightGuideEntryLike[]
}

/** The right-Sidebar tab-type registry. */
export interface SidebarRightTabRegistryLike {
  /** Register one tab type for the caller's lifetime. */
  register(definition: SidebarRightTabDefinitionLike): Disposer
}

/** The client root context once the sidebar client packages are composed. */
export interface ClientContext extends Context {
  readonly slots: SlotsLike
  readonly sidebarRightTabs: SidebarRightTabRegistryLike
}
