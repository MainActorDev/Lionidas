**Crucible** — a developer-friendly chaos and load testing toolkit that simulates real-world failure conditions (latency spikes, dropped connections, partial outages) against local and staging services before they reach production.

- Define failure scenarios as simple YAML recipes with composable faults: packet loss, CPU throttling, malformed responses, and random service kills.
- Ship a single binary with zero dependencies; run against localhost, Docker Compose, or Kubernetes clusters with the same commands.
- Generate human-readable reports ranking reliability risks by blast radius, with diffs between test runs to catch regressions.
- Include a "smelt mode" that continuously replays recorded production traffic patterns to surface rare race conditions.
- Provide an exit-code contract so Crucible runs slot directly into CI pipelines as a quality gate.
