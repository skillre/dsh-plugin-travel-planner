---
'@skillre/dsh-plugin-travel-planner': minor
---

The detail panel stops covering the timeline, and a stop's photo is fetched on
demand instead of waiting for a manual sweep.

- **Docked detail panel.** The place detail used to be an overlay pinned to the
  bottom-right of the pane: it covered the very rows it described, always had the
  same size, and could not be resized. It is now part of the pane's layout — a
  bottom panel while the pane is narrow, a right-hand column once the pane is
  wider than 560px — with a drag handle on its inner edge. The chosen size is
  remembered per browser (`skillre-travel:ui`), and CSS clamps it so a stored
  value can never eat the whole pane. Because the body no longer scrolls as one
  block, the timeline owns its own scroll container, which also makes the
  edge auto-scroll during a drag actually work.
- **Photos on demand.** Opening a stop that has no photo now asks the Host for
  that one place (`POST <prefix>/refresh-places` with `placeId`, or the
  `travel_place_refresh` tool with `placeId`), so a detail card fills in as soon
  as the CLI answers instead of showing an empty space. Failures report the CLI
  message and offer 「再查一次」 rather than silently retrying. The header meta
  row also carries 「缺 N 张照片 · 补全」 for the whole library, which is what the
  timeline thumbnails need.
- The view now states whether photos may be projected at all (`photos`), so
  `ui.placePhotos: 'off'` costs no provider calls and shows no photo surface.
- The 固定 explanation no longer prints a paragraph under the buttons: the
  meaning lives in the button's tooltip, and the buttons keep the row to
  themselves.
