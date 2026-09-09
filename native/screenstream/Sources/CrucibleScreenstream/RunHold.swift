// MARK: RunHold — merged into DeviceStream (runPause/runResume).
// This file intentionally carries only the hold's unit-test surface mirror
// so tests can drive the state machine without a live simulator.
import Foundation

/// Pure state machine mirroring DeviceStream's hold logic for tests:
/// held + resume ⇒ force IDR next composite; pause with pending composite
/// drops it silently (held screens don't encode).
struct RunHoldState: Equatable {
    var held = false
    var pendingForceKeyframe = true

    mutating func pause() { held = true }
    mutating func resume() { held = false; pendingForceKeyframe = true }
    mutating func compositeSeen() -> Bool {
        guard !held else { return false }
        defer { pendingForceKeyframe = false }
        return true
    }
}
