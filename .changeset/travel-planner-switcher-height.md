---
'@skillre/dsh-plugin-travel-planner': patch
---

The trip switcher shows the whole workspace instead of one clipped row.

- **What was wrong.** `.trv-head` is `position: relative` and only as tall as the
  header, so the switcher's `max-height: 62%` resolved against ~56px: with two
  trips in one workspace the dropdown clipped at the first row and the rest had
  to be found by scrolling a 35px-tall box. The dropdowns now anchor to the
  pane (`.trv-head` no longer establishes the containing block), so the panel is
  a slice of the pane: it hugs its content, caps at `min(74%, 520px)`, and only
  then scrolls. Measured with a 12-trip workspace: a 538px panel, nine rows fully
  visible, list scrolling, footer button still in place; with two trips both rows
  and the footer fit with no scrolling.
- The header and footer of the panel stay put while the list scrolls, so
  「设为工作区默认行程」 never scrolls out of reach.
- A click anywhere else now dismisses an open switcher or overflow menu (a
  transparent scrim under the panel), which a taller panel made necessary.
