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
