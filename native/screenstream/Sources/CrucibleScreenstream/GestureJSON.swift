// GestureJSON — pure parser for input control messages on the WS.
// Wire coordinates are DEVICE POINTS (same units as baguette's wire);
// the adapter normalises by screen size internally.
import Foundation

enum Gesture: Equatable {
    case tap(x: Double, y: Double, duration: Double)
    case swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: Double)
    case touch1(phase: TouchPhase, x: Double, y: Double, edge: DeviceEdge?)
    case touch2(phase: TouchPhase, x1: Double, y1: Double, x2: Double, y2: Double)
    case press(button: DeviceButton, duration: Double)
    case key(code: String, modifiers: Set<KeyModifier>, duration: Double)
    case type(text: String)
    case scroll(deltaX: Double, deltaY: Double)
}

enum GestureJSONError: Error, Equatable, CustomStringConvertible {
    case missingField(String)
    case unknownKind(String)
    case badPhase(String)
    case unknownButton(String)
    case rejectedButton(String)      // known but refused (siri)
    case badKey(String)
    case unsupportedText(String)

    var description: String {
        switch self {
        case .missingField(let f): return "missing field: \(f)"
        case .unknownKind(let k): return "unknown input kind: \(k)"
        case .badPhase(let p): return "bad phase: \(p)"
        case .unknownButton(let b): return "unknown button: \(b)"
        case .rejectedButton(let b): return "button rejected (crashes backboardd): \(b)"
        case .badKey(let c): return "unsupported key code: \(c)"
        case .unsupportedText(let t): return "text not typeable on US layout: \(t.prefix(20))"
        }
    }
}

enum GestureJSON {
    static func parse(_ dict: [String: Any]) throws -> Gesture {
        guard let kind = dict["kind"] as? String else {
            throw GestureJSONError.missingField("kind")
        }
        func dbl(_ k: String) throws -> Double {
            guard let v = dict[k] as? Double else { throw GestureJSONError.missingField(k) }
            return v
        }
        switch kind {
        case "tap":
            return .tap(x: try dbl("x"), y: try dbl("y"),
                        duration: (dict["duration"] as? Double) ?? 0.05)
        case "swipe":
            return .swipe(startX: try dbl("startX"), startY: try dbl("startY"),
                          endX: try dbl("endX"), endY: try dbl("endY"),
                          duration: (dict["duration"] as? Double) ?? 0.25)
        case "touch1":
            guard let phaseRaw = dict["phase"] as? String,
                  let phase = TouchPhase(rawValue: phaseRaw) else {
                throw GestureJSONError.badPhase(dict["phase"] as? String ?? "?")
            }
            let edge = (dict["edge"] as? String).flatMap(DeviceEdge.init(rawValue:))
            return .touch1(phase: phase, x: try dbl("x"), y: try dbl("y"), edge: edge)
        case "touch2":
            guard let phaseRaw = dict["phase"] as? String,
                  let phase = TouchPhase(rawValue: phaseRaw) else {
                throw GestureJSONError.badPhase(dict["phase"] as? String ?? "?")
            }
            return .touch2(phase: phase,
                           x1: try dbl("x1"), y1: try dbl("y1"),
                           x2: try dbl("x2"), y2: try dbl("y2"))
        case "press":
            guard let raw = dict["button"] as? String else {
                throw GestureJSONError.missingField("button")
            }
            if raw == "siri" { throw GestureJSONError.rejectedButton(raw) }
            guard let button = DeviceButton(rawValue: raw) else {
                throw GestureJSONError.unknownButton(raw)
            }
            return .press(button: button, duration: (dict["duration"] as? Double) ?? 0)
        case "key":
            guard let code = dict["code"] as? String else {
                throw GestureJSONError.missingField("code")
            }
            guard KeyboardKey.from(wireCode: code) != nil else {
                throw GestureJSONError.badKey(code)
            }
            let mods = Set((dict["modifiers"] as? [String] ?? []).compactMap(KeyModifier.init(rawValue:)))
            return .key(code: code, modifiers: mods,
                        duration: (dict["duration"] as? Double) ?? 0.1)
        case "type":
            guard let text = dict["text"] as? String else {
                throw GestureJSONError.missingField("text")
            }
            // Reject up front (baguette's TypeText contract): every char
            // must decompose on the US layout.
            for c in text {
                if KeyboardKey.decompose(character: c) == nil {
                    throw GestureJSONError.unsupportedText(String(c))
                }
            }
            return .type(text: text)
        case "scroll":
            let dx = (dict["deltaX"] as? Double) ?? 0
            let dy = (dict["deltaY"] as? Double) ?? 0
            return .scroll(deltaX: dx, deltaY: dy)
        default:
            throw GestureJSONError.unknownKind(kind)
        }
    }
}
