// Session — one WebSocket client of one device stream.
//
// Outbound: tagged binary frames with DELTA-DROP backpressure — a backed-up
// socket sheds queued deltas but ALWAYS forwards the pending keyframe, so a
// starved client recovers sharp. Inbound: JSON text control messages.
// Frame writing is the RFC6455 subset: binary 0x82, text 0x81, no outbound
// fragmentation, <=125-length and 16-bit lengths (frames stay < 64KB after
// the encoder's AVCC chunks; larger payloads split, which is legal).
import Foundation
import Network

final class Session: @unchecked Sendable {
    let conn: NWConnection
    let udid: String

    var onControl: (([String: Any]) -> Void)?
    var onEnded: (() -> Void)?
    var onSubscribe: (() -> Void)?

    private let lock = NSLock()
    private var pendingKeyframe: Data?
    private var pendingDeltas: [Data] = []
    private var sending = false
    private var closed = false
    private var fragBuffer = Data()

    init(conn: NWConnection, udid: String) {
        self.conn = conn
        self.udid = udid
    }

    func begin() {
        onSubscribe?()
        receiveLoop()
    }

    // MARK: outbound (delta-drop backpressure)

    /// Keyframe gate: deltas decoded before the first IDR smear the canvas
    /// (the pixelation bug). This session holds NOTHING until a keyframe
    /// arrives — the encoder emits one on subscribe (viewerJoined), so the
    /// gate opens within one composite.
    private var seenKeyframe = false

    func enqueue(_ frame: Data) {
        // mutate queue state under the lock, then release BEFORE draining —
        // drain() takes the same lock; calling it here would self-deadlock.
        lock.lock()
        guard !closed, frame.count > 0 else { lock.unlock(); return }
        let tag = frame[frame.startIndex]
        if tag == FrameTag.keyframe.rawValue {
            pendingKeyframe = frame
            pendingDeltas.removeAll()          // deltas before a new IDR are dead weight
            seenKeyframe = true
        } else if tag == FrameTag.description.rawValue {
            // parameter sets ride immediately before their keyframe; keep order
            // by stashing at the head of the delta queue
            pendingDeltas.insert(frame, at: 0)
        } else if tag == FrameTag.seed.rawValue {
            // JPEG seed paints instantly and does not depend on the GOP
            pendingDeltas.insert(frame, at: 0)
        } else {
            guard seenKeyframe else { lock.unlock(); return }   // pre-IDR delta: drop, never decode
            pendingDeltas.append(frame)
            if pendingDeltas.count > 8 { pendingDeltas.removeFirst(pendingDeltas.count - 8) }
        }
        lock.unlock()
        drain()
    }

    private func drain() {
        // Lock discipline: NEVER call conn.send while holding `lock` —
        // Network.framework runs .contentProcessed INLINE (synchronously on
        // the calling thread) for cancelled/failed connections, and NSLock
        // is non-reentrant: send-under-lock self-deadlocks the queue that
        // owns the fan-out. Snapshot state, release, then send.
        var next: Data?
        lock.lock()
        guard !sending, !closed else { lock.unlock(); return }
        if let kf = pendingKeyframe {
            pendingKeyframe = nil
            next = kf
        } else if !pendingDeltas.isEmpty {
            next = pendingDeltas.removeFirst()
        }
        if next == nil { lock.unlock(); return }
        sending = true
        lock.unlock()

        conn.send(content: Self.wsBinaryFrame(next!), completion: .contentProcessed { [weak self] _ in
            guard let self else { return }
            self.lock.lock(); self.sending = false; self.lock.unlock()
            self.drain()
        })
    }

    func sendText(_ json: String, then closeAfter: Bool = false) {
        let frame = Self.wsTextFrame(Data(json.utf8))
        if closeAfter {
            // flush-then-close: the reason frame must reach the peer before
            // the FIN — close() from the completion, never inline before it
            conn.send(content: frame, completion: .contentProcessed { [weak self] _ in
                self?.close()
            })
        } else {
            conn.send(content: frame, completion: .contentProcessed { _ in })
        }
    }

    func close() {
        lock.lock()
        let already = closed
        closed = true
        lock.unlock()
        guard !already else { return }   // idempotent; no cancel/onEnded storm
        conn.cancel()
        onEnded?()
    }

    // MARK: inbound

    private func receiveLoop() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, _, error in
            guard let self else { return }
            if error != nil || data == nil { self.close(); return }
            fragBuffer.append(data!)
            Self.parseInbound(&fragBuffer) { op, payload in
                switch op {
                case .binary:
                    break  // we never receive binary; ignore
                case .text:
                    if let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                        self.onControl?(obj)
                    }
                case .close:
                    self.close()
                case .ping:
                    self.conn.send(content: Self.opFrame(0x0A, payload: payload),
                                   completion: .contentProcessed { _ in })
                case .pong:
                    break
                }
            }
            self.receiveLoop()
        }
    }

    // MARK: RFC6455 subset (pure, unit-tested)

    enum WsOp { case binary, text, close, ping, pong }

    static func parseInbound(_ buffer: inout Data, emit: (WsOp, Data) -> Void) {
        while buffer.count >= 2 {
            let b0 = buffer[buffer.startIndex]
            let b1 = buffer[buffer.index(after: buffer.startIndex)]
            let opcode = b0 & 0x0F
            let masked = (b1 & 0x80) != 0
            var len = Int(b1 & 0x7F)
            var offset = 2
            if len == 126 {
                guard buffer.count >= 4 else { return }
                len = Int(buffer[buffer.index(buffer.startIndex, offsetBy: 2)]) << 8
                    | Int(buffer[buffer.index(buffer.startIndex, offsetBy: 3)])
                offset = 4
            } else if len == 127 {
                guard buffer.count >= 10 else { return }
                len = 0
                for i in 4 ..< 10 { len = len << 8 | Int(buffer[buffer.index(buffer.startIndex, offsetBy: i)]) }
                offset = 10
            }
            let maskLen = masked ? 4 : 0
            guard buffer.count >= offset + maskLen + len else { return }
            var payload = buffer.subdata(in: buffer.index(buffer.startIndex, offsetBy: offset + maskLen)
                                         ..< buffer.index(buffer.startIndex, offsetBy: offset + maskLen + len))
            if masked {
                let maskStart = buffer.index(buffer.startIndex, offsetBy: offset)
                var mask = [UInt8]()
                for i in 0 ..< 4 { mask.append(buffer[buffer.index(maskStart, offsetBy: i)]) }
                for i in 0 ..< payload.count {
                    payload[payload.index(payload.startIndex, offsetBy: i)] ^= mask[i % 4]
                }
            }
            buffer.removeSubrange(buffer.startIndex ..< buffer.index(buffer.startIndex, offsetBy: offset + maskLen + len))
            switch opcode {
            case 0x1: emit(.text, payload)
            case 0x2, 0x0: emit(.binary, payload)
            case 0x8: emit(.close, payload)
            case 0x9: emit(.ping, payload)
            case 0xA: emit(.pong, payload)
            default: break
            }
        }
    }

    static func wsBinaryFrame(_ payload: Data) -> Data {
        opFrame(0x02, payload: payload)
    }
    static func wsTextFrame(_ payload: Data) -> Data {
        opFrame(0x01, payload: payload)
    }

    static func opFrame(_ op: UInt8, payload: Data) -> Data {
        var out = Data([0x80 | op])
        let n = payload.count
        if n < 126 {
            out.append(UInt8(n))
        } else if n <= 0xFFFF {
            out.append(126)
            out.append(UInt8((n >> 8) & 0xFF)); out.append(UInt8(n & 0xFF))
        } else {
            out.append(127)
            for shift in stride(from: 56, through: 0, by: -8) {
                out.append(UInt8((n >> shift) & 0xFF))
            }
        }
        out.append(payload)
        return out
    }
}
