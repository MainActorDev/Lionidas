## Variant C — pulse orbit

### Design stance
A signal radiating from the device: one ember core breathing at center, three concentric rings expanding and fading, and a masked conic sweep — radar language that matches the cockpit's engine/bus aesthetic.

### Key choices
- Layout: centered composition — 10px ember core (glow shadow), 3 staggered rings (0.9s offsets), conic-gradient sweep masked to a ring
- Motion: core 1.8s beat; rings 2.7s ripple to scale 5.2; sweep 2.7s rotation — all ember, all one hue family
- Color: ember on void only — reads as "engine activity", not decoration
- Status: "acquiring frame 1" caption — technically honest for a first MJPEG frame

### Trade-offs
- Strong at: most distinctive; ties loading to the device itself (signal from hardware); great for `connecting` before first frame
- Weak at: radial motion can feel busier in peripheral vision; less calm than B

### Best for
The engine/telemetry identity of Lionidas; loading states tied to device acquisition.

### Integration note
Pure CSS (transform/opacity — no layout thrash); `animation-delay` staggering means one keyframe set for all rings. Status text swappable with the real stream state word.
