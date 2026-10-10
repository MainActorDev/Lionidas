# 032 A3-1 — claude-faithful

## Variant: the reference anatomy, directly (empty state → thread)

### Design stance
The screenshot's skeleton, nothing it doesn't need: brand+search+New+recents+account sidebar; centered greeting + composer in the empty state; composer docks to the bottom once a thread starts. Stripped per operator: plan pill, mic/voice, onboarding Try-rows.

### Lionidas mappings
- Claude's `+` attach → reference chips (jira/PR/doc), removable
- Claude's model picker → **executor picker** (glm / claude-sonnet / mock — cycles, the P2 config decision made visible)
- No send button until text exists (opacity-gated, like the reference)
- Thread keeps the A3 voice: serif questions, node-flow status, ember orb avatar, drafts card

### Working interactions
type+enter sends → empty state swaps to thread; ＋ adds refs; chips removable; executor cycles; search filters recents; New resets; answer/skip advances author stage ✓; composer replies echo as user turns.

### Trade-offs
Strong: closest to the reference; empty state invites first use. Weak: artifacts only inline (no browsing).
