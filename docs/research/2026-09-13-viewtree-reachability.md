# Viewtree Probe P0 — Reachability + Ground Truth (2026-09-13, executed live)

Env: iPhone 17 Pro sim (835EE2B0), iOS 27.0, Xcode 26.4, LP consumer-dev
v11 (pid 37941), Foodiary v4 (pid 95510). Recipe (the ONLY one that
worked after 3 failed syntax variants — lesson: pin the working expr, see
below).

## The working lldb recipe

```
xcrun lldb --batch \
  -o "attach --pid <PID>" \
  -o "expr -O -lobjc++ -- (NSString *)[[[(id)[[UIApplication sharedApplication] valueForKey:@\"connectedScenes\"] anyObject] valueForKey:@\"keyWindow\"] recursiveDescription]" \
  -o "detach"
```

Failed variants (all cost real time — do not retry):
- `[[UIApplication sharedApplication] keyWindow]` → compile error on iOS 27
  SDK headers (deprecated symbol; parser stops at `delegate` decl)
- `_printHierarchy` → `Expression execution was interrupted: internal
  ObjC exception breakpoint(-5)` — the selector itself trips lldb's
  internal exception breakpoint on these apps. NOT usable headless.
- `settings set target.expr-prefix` + casts → no effect on either failure.

`keyWindow` via the **KVC chain** (`connectedScenes → anyObject →
keyWindow` as `valueForKey:`) compiles and runs clean.

## Cost model (measured)

| Operation | Time |
|---|---|
| Cold: attach + 1 expr + detach (first ever) | 23.2s |
| Cold: attach + both dumps | 17.6–19.0s |
| **Warm: attach + recursiveDescription + detach** | **6.6s** |

Budget verdict: **mechanism A (lldb) is VIABLE for on-demand/forensics
use** (≤8s warm ≈ plan's budget) but NOT for anything polling-shaped.
Cold attach is symbol-load dominated; a long-lived lldb process would
likely amortize (untested — out of P0 scope).

App pause = duration of attach→detach (the app is SIGSTOP'd). 6.6s warm
per inspection is acceptable for a manual, user-invoked inspection —
same honesty class as the inspector's screenshot sampling; NEVER during
playback (route must busy-guard).

## Richness findings (the spike's real questions)

### LP home (UIKit-heavy hybrid)
- Full view tree captured: 338 framed views; class census dominated by
  CALayer(321 refs), UIView(47), UIImageView(43), UIButton(8),
  UITableViewCellContentView(17).
- **Tab bar: REAL `UITabBar` with `UITabBarButton`s** (frame-exact:
  bar at y:791, buttons 97×48) — the exact elements BOTH AX trees lose
  or expose inconsistently (alloy has them; engine full-tree drops
  them; view tree has them structurally with exact frames).
- **41 hidden / alpha-0 views**, including APP-CLASS cells:
  `LionParcelLogistics.HomeRevampMenuCellView` (reused, off-screen
  cells parked hidden at frame y:666) — the forensics class no AX tree
  can see ("why did my tap land wrong / what reused this cell").
- SwiftUI present but bounded: 24 SwiftUI.* layer refs — the hybrid app
  shows its SwiftUI islands as UIKit-embedded layers.

### Foodiary home (pure SwiftUI) — the ceiling, measured
- **7 UIKit views total**: UIWindow → UITransitionView →
  UIDropShadowView → UIHostingController's view (+ layers). Nothing
  else. The entire screen's content is opaque SwiftUI.
- Confirms the plan's honesty contract: for pure-SwiftUI screens the
  view tree adds ~nothing over "there is a hosting view here"; the AX
  tree remains the only meaningful tree. (P0.4 exit criterion met.)

## P0 verdict

✅ **Viable — proceed to P1 (parsers).** Attach is reliable, the recipe
is pinned, cost is within budget for manual inspection, richness on
UIKit/hybrid screens is high (exact classes, hidden views, real tab
bar), and the SwiftUI ceiling is now a measured fact, not an
assumption. `_printHierarchy` (VC structure) is DEAD headless — the VC
hierarchy must come from walking `rootViewController`/`childViewControllers`
via expressions if needed in P2 wiring (or skipped: view tree + AX tree
already overlap most of it).

Fixtures: `server/test/fixtures/viewtree/{lp-home,foodiary-home}/recdesc.txt`
(+ failed-attempt logs kept for the record).
