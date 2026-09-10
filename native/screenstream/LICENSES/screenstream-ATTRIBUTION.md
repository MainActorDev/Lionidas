# Attribution

crucible-screenstream follows architectural recipes from
[Baguette](https://github.com/…) (Apache-2.0), used as a reference
implementation while this engine was developed:

- CoreSimulator service-context and device-set discovery (IMP-cast,
  `defaultDeviceSetWithError:`), booted-device enumeration.
- SimulatorKit framebuffer callbacks → IOSurface capture.
- VideoToolbox low-latency H.264 tuning profile.
- H.264 keyframe classification via the `NotSync` sample attachment.
- WebSocket framing patterns for the AVCC tag protocol.
- Input pipeline: `IndigoHIDInput` (Infrastructure/Input) — the 9-arg +
  7-arg `IndigoHIDMessageForMouseNSEvent` ABI pair, `SimDeviceLegacyHIDClient`
  alloc/init + fail-closed service warm-up, `IndigoHIDMessageForButton` /
  `ForHIDArbitrary` / `ForScrollEvent` recipes, per-button routing table,
  and the empirical edge-gesture timings (app-switcher dwell, swipe-to-home
  step rates). `IOHIDDigitizerDispatch` — the digitizer parent+finger
  IOHIDEvent construction, `IndigoHIDMessageForTrackpadEventFromHIDEventRef`
  wrapper, and the 0x6c/0x10c/0x3a/0x3b patch offsets. Keyboard/DeviceButton
  HID usage tables. All ported 1:1 and scoped to the phone plane.
- DeviceKit chrome pipeline: profile.plist/chrome.json parsing (`DeviceProfile`,
  `DeviceChrome`), 9-slice bezel composition (`NineSliceLayout`,
  `PDFRasterizer.compose9Slice`), and the hardware-button anchor table
  (`Chromes.buttonTopLeft` — the asymmetric per-anchor offset semantics and
  the `2N − R` at-rest mirror) are ports of Baguette's Chrome domain, whose
  geometry was itself verified against SimulatorKit layout constraints.

The Swift sources in `Sources/CrucibleScreenstream/` were written for
Crucible; where a function mirrors Baguette's approach, comments in the
source note the lineage. Baguette is Apache-2.0 licensed; its terms permit
this reuse with attribution, which this file provides.
