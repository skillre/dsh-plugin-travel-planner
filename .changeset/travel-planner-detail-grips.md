---
'@skillre/dsh-plugin-travel-planner': patch
---

The detail window resizes from any direction, and the clock stops losing its last
digit to the timeline's node.

- **Three handles instead of one.** The window is anchored to the bottom right, so
  its left edge and its top edge are the two free sides; each now has its own
  grip, and a corner grip drives both axes at once. Width and height are
  remembered separately, and neither is pinned until it has been dragged, so the
  window still hugs its content until you say otherwise. A bottom sheet already
  spans the pane, so there the corner can only give width back — measured with
  real pointer input: corner +82×+72, top edge +50 height with the width
  untouched, left edge +60 width with the height untouched.
- **The node no longer eats the clock.** The 9px node carries a 3px halo and sat
  2.5px into the clock's own box, so `12:00` and `00:30` lost the right side of
  their last digit — the dot looked like it was covering the time. The clock now
  stops 7.5px short of the node instead of overlapping it, verified in the same
  browser harness.
