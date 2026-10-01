# LP-1042 — Checkout "Pay Now" crashes on iPad

- Type: Bug
- App: com.lionparcel.consumer
- Screens: checkout-summary, payment-web
- Priority: P1

## Requirement

Tapping **Pay Now** on the checkout summary crashes the app on iPad (iOS 17+); iPhone is unaffected. Payments team suspects the payment web view is presented before the summary finishes settling.

## Context

- The checkout summary is `checkout-summary` with named state `settled`.
- The crash does not reproduce when the summary is already `settled` before the tap.
- The payment web view (`payment-web`) has a `loading` state.

## Acceptance

- Given a cart with items, when I open checkout, then the summary reaches `settled`.
- Given the summary is `settled`, when I tap Pay Now, then `payment-web` shows `loading` without the app crashing.
- Works the same on iPad and iPhone.
