// ScreenstreamServer — minimal loopback HTTP + WebSocket server.
//
// Two routes only: GET /healthz (JSON liveness with frame-flow truth) and
// WS /devices/<udid>/stream (binary frames out, JSON control in). Built on
// Network.framework; RFC6455 subset sufficient for our controlled clients:
// handshake (Sec-WebSocket-Key/Accept), binary/text frames, ping/pong, close.
// No fragmentation emission; inbound fragmentation accepted (accumulated).
import Foundation
import Network

final class ScreenstreamServer: @unchecked Sendable {
    private let port: UInt16
    private let listener: NWListener
    private let discovery = SimDiscovery()
    private let chromes = Chromes()
    private let stateLock = NSLock()
    private var streams: [String: DeviceStream] = [:]      // udid → stream
    private var sessions: [ObjectIdentifier: Session] = [:]
    private var startedAt = Date()
    private let encoderQueue = DispatchQueue(label: "crucible.server.encode", qos: .userInteractive)

    init(port: UInt16) {
        self.port = port
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        listener = try! NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    }

    func run() {
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            DispatchQueue.main.async { self.accept(conn) }
        }
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                // startup contract: one JSON line on stdout when listening
                guard let self else { return }
                DispatchQueue.main.async {
                    // fflush (not fsync-variants: stdout is a pipe, and
                    // synchronizeFile throws on non-seekable handles)
                    print("{\"ready\":true,\"port\":\(self.port)}")
                    fflush(stdout)
                }
            }
        }
        signal(SIGTERM) { _ in exit(0) }  // graceful-enough: clients reconnect + seed
        listener.start(queue: .main)
        dispatchMain()
    }

    // MARK: - connections

    private func accept(_ conn: NWConnection) {
        conn.start(queue: .main)
        receiveHTTP(conn)
    }

    private func receiveHTTP(_ conn: NWConnection) {
        receiveLine(conn, buffer: Data()) { [weak self] head, rest in
            guard let self else { return }
            let requestLine = head.split(separator: "\r\n").first.map(String.init) ?? ""
            let parts = requestLine.split(separator: " ")
            let method = parts.count > 0 ? String(parts[0]) : ""
            let path = parts.count > 1 ? String(parts[1]) : ""

            let cleanPath = String(path.split(separator: "?")[0])
            let query = path.contains("?") ? String(path.split(separator: "?", maxSplits: 1)[1]) : ""
            if method == "GET", path == "/healthz" {
                self.sendHealth(conn)
            } else if method == "GET", cleanPath.hasPrefix("/devices/"), cleanPath.hasSuffix("/stream"),
                      let wsKey = header(named: "Sec-WebSocket-Key", in: head) {
                self.upgradeWebSocket(conn, path: cleanPath, key: wsKey)
            } else if method == "GET", cleanPath.hasSuffix("/bezel.png") {
                let udid = String(cleanPath.dropFirst("/devices/".count).dropLast("/bezel.png".count))
                self.serveBezel(conn, udid: udid, query: query)
            } else if method == "GET", cleanPath.hasSuffix("/definition.json") {
                let udid = String(cleanPath.dropFirst("/devices/".count).dropLast("/definition.json".count))
                self.serveDefinition(conn, udid: udid)
            } else if method == "GET", cleanPath.contains("/bezel-button/") {
                // /devices/<udid>/bezel-button/<file>
                let parts = cleanPath.split(separator: "/")
                guard parts.count >= 4 else { return self.respond(conn, status: "404 Not Found", body: "{\"error\":\"not found\"}") }
                let udid = String(parts[1])
                let file = String(parts[3])
                self.serveBezelButton(conn, udid: udid, file: file)
            } else {
                self.respond(conn, status: "404 Not Found", body: "{\"error\":\"not found\"}")
            }
        }
    }

    private nonisolated(unsafe) var framesServed = 0

    private func sendHealth(_ conn: NWConnection) {
        stateLock.lock()
        let streamInfo = streams.map { udid, s -> [String: Any] in
            ["udid": udid, "clients": sessions.values.filter { $0.udid == udid }.count]
        }
        stateLock.unlock()
        let body: [String: Any] = [
            "ok": true,
            "uptimeMs": Int(Date().timeIntervalSince(startedAt) * 1000),
            "streams": streamInfo,
            "framesServed": framesServed,  // cumulative; supervisor recycles old+zero as wedged
        ]
        if let data = try? JSONSerialization.data(withJSONObject: body) {
            respond(conn, status: "200 OK", body: String(data: data, encoding: .utf8) ?? "{}")
        }
    }

    // MARK: - HTTP plumbing (loopback-subset)

    private func receiveLine(_ conn: NWConnection, buffer: Data, acc: @escaping (String, Data) -> Void) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, error in
            guard let self, error == nil, let data else {
                conn.cancel(); return
            }
            var buf = buffer; buf.append(data)
            if let range = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(data: buf[..<range.lowerBound], encoding: .utf8) ?? ""
                let rest = Data(buf[range.upperBound...])
                acc(head, rest)
            } else {
                self.receiveLine(conn, buffer: buf, acc: acc)
            }
        }
    }

    private func header(named name: String, in head: String) -> String? {
        for line in head.split(separator: "\r\n").dropFirst() {
            let kv = line.split(separator: ":", maxSplits: 1)
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == name.lowercased() {
                return kv[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    private func respond(_ conn: NWConnection, status: String, body: String) {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
        conn.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - WebSocket upgrade

    private func upgradeWebSocket(_ conn: NWConnection, path: String, key: String) {
        let accept = Self.wsAccept(key: key)
        let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
        conn.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] _ in
            guard let self else { return }
            let udid = String(path.dropFirst("/devices/".count).dropLast("/stream".count))
            self.startSession(conn, udid: udid)
        })
    }

    static func wsAccept(key: String) -> String {
        let magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let digest = InsecureSHA1.digest(data: Data(magic.utf8))
        return Data(digest).base64EncodedString()
    }

    // MARK: - sessions

    private func startSession(_ conn: NWConnection, udid: String) {
        let session = Session(conn: conn, udid: udid)

        stateLock.lock()
        var stream = streams[udid]
        if stream == nil {
            do {
                stream = try DeviceStream(udid: udid, discovery: discovery)
                streams[udid] = stream
            } catch {
                stateLock.unlock()
                session.sendText("{\"ok\":false,\"error\":\"\(Self.jsonEscape("\(error)"))\"}")
                session.close()
                return
            }
        }
        let s = stream!
        sessions[ObjectIdentifier(session)] = session
        let count = sessions.values.filter { $0.udid == udid }.count
        stateLock.unlock()
        s.setClientCount(count)

        // wire the shared encode into this session (delta-drop backpressure lives in Session)
        session.onSubscribe = { [weak self, weak s] in
            guard let self, let s else { return }
            // join contract: this viewer gets seed + fresh IDR before deltas
            s.viewerJoined()
            s.onFrame = { [weak self] frame in
                guard let self else { return }
                self.framesServed += 1
                stateLock.lock()
                let targets = sessions.values.filter { $0.udid == s.udid }
                stateLock.unlock()
                for t in targets { t.enqueue(frame) }
            }
        }
        session.onControl = { [weak self, weak s, weak session] msg in
            guard let self, let s, let session else { return }
            self.handleControl(msg, stream: s, session: session)
        }
        session.onEnded = { [weak self, weak s] in
            guard let self else { return }
            stateLock.lock()
            sessions.removeValue(forKey: ObjectIdentifier(session))
            let remaining = sessions.values.filter { $0.udid == udid }.count
            if remaining == 0, let gone = streams.removeValue(forKey: udid) {
                stateLock.unlock()
                gone.stop()
            } else {
                stateLock.unlock()
            }
            s?.setClientCount(remaining)
        }
        session.begin()
    }

    private func respondBinary(_ conn: NWConnection, status: String, contentType: String, body: Data) {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        var payload = Data(head.utf8)
        payload.append(body)
        conn.send(content: payload, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    /// /devices/<udid>/bezel.png[?buttons=false] — merged bezel by default;
    /// bare body (no buttons) for the overlay UI.
    private func serveBezel(_ conn: NWConnection, udid: String, query: String) {
        guard let assets = chromeAssets(udid: udid) else {
            respond(conn, status: "404 Not Found", body: "{\"error\":\"no chrome for \(Self.jsonEscape(udid))\"}")
            return
        }
        let withButtons = !query.split(separator: "&").contains { $0.hasPrefix("buttons=") && $0.dropFirst("buttons=".count) == "false" }
        respondBinary(conn, status: "200 OK", contentType: "image/png",
                      body: withButtons ? assets.bezelPNG : assets.barePNG)
    }

    private func serveDefinition(_ conn: NWConnection, udid: String) {
        guard let assets = chromeAssets(udid: udid) else {
            respond(conn, status: "404 Not Found", body: "{\"error\":\"no chrome for \(Self.jsonEscape(udid))\"}")
            return
        }
        respond(conn, status: "200 OK", body: assets.definitionJSON(udid: udid))
    }

    private func serveBezelButton(_ conn: NWConnection, udid: String, file: String) {
        guard let assets = chromeAssets(udid: udid),
              let png = assets.buttonPNGs[file.hasSuffix(".png") ? String(file.dropLast(4)) : file]
        else {
            respond(conn, status: "404 Not Found", body: "{\"error\":\"no such button\"}")
            return
        }
        respondBinary(conn, status: "200 OK", contentType: "image/png", body: png)
    }

    private func chromeAssets(udid: String) -> DeviceChromeAssets? {
        guard let name = discovery.deviceTypeName(udid: udid) else { return nil }
        return chromes.assets(deviceName: name)
    }

    private func handleControl(_ msg: [String: Any], stream: DeviceStream, session: Session) {
        switch msg["type"] as? String {
        case "set_fps": stream.apply(.init(fps: msg["fps"] as? Int ?? stream.config.fps,
                                           bitrateBps: stream.config.bitrateBps, scale: stream.config.scale))
        case "set_bitrate": stream.apply(.init(fps: stream.config.fps,
                                               bitrateBps: msg["bps"] as? Int ?? stream.config.bitrateBps,
                                               scale: stream.config.scale))
        case "set_scale": stream.apply(.init(fps: stream.config.fps, bitrateBps: stream.config.bitrateBps,
                                             scale: msg["scale"] as? Int ?? stream.config.scale))
        case "force_idr": stream.forceIDR()
        case "run_pause": stream.runPause()
        case "run_resume": stream.runResume()
        case "input":
            let kind = (msg["kind"] as? String) ?? "?"
            let seq = (msg["seq"] as? Int).map { ",\"seq\":\($0)" } ?? ""
            do {
                let gesture = try GestureJSON.parse(msg)
                let ok = Self.dispatch(gesture, on: stream)
                session.sendText("{\"type\":\"input_ack\",\"ok\":\(ok),\"kind\":\"\(kind)\"\(seq)}")
            } catch {
                let reason = Self.jsonEscape(String(describing: error))
                session.sendText("{\"type\":\"input_ack\",\"ok\":false,\"kind\":\"\(kind)\"\(seq),\"error\":\"\(reason)\"}")
            }
        default: break
        }
    }

    /// One gesture → one InputSurface call. Coordinates arrive in device
    /// POINTS (wire contract); the adapter normalises by logicalSize.
    /// Runs on the main queue (WS receive loop) — the thread the mouse
    /// path requires (asserted inside HIDInput).
    private static func dispatch(_ gesture: Gesture, on stream: DeviceStream) -> Bool {
        let input = stream.input
        let size = stream.logicalSize
        switch gesture {
        case .tap(let x, let y, let d):
            return input.tap(at: Point(x: x, y: y), size: size, duration: d)
        case .swipe(let sx, let sy, let ex, let ey, let d):
            return input.swipe(from: Point(x: sx, y: sy), to: Point(x: ex, y: ey), size: size, duration: d)
        case .touch1(let phase, let x, let y, let edge):
            return input.touch1(phase: phase, at: Point(x: x, y: y), size: size, edge: edge)
        case .touch2(let phase, let x1, let y1, let x2, let y2):
            return input.touch2(phase: phase, first: Point(x: x1, y: y1), second: Point(x: x2, y: y2), size: size)
        case .press(let button, let d):
            return input.button(button, duration: d)
        case .key(let code, let mods, let d):
            guard let key = KeyboardKey.from(wireCode: code) else { return false }
            return input.key(key, modifiers: mods, duration: d)
        case .type(let text):
            var ok = true
            for c in text {
                guard let (key, mods) = KeyboardKey.decompose(character: c) else { ok = false; continue }
                if !input.key(key, modifiers: mods, duration: 0.05) { ok = false }
            }
            return ok
        case .scroll(let dx, let dy):
            return input.scroll(deltaX: dx, deltaY: dy)
        }
    }

    static func jsonEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\n", with: " ")
    }
}

// SHA-1 for the WS handshake (RFC6455 mandates it; no security role here).
// CommonCrypto ships in the SDK — no external dependency for one hash.
import CommonCrypto
enum InsecureSHA1 {
    static func digest(data: Data) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: Int(CC_SHA1_DIGEST_LENGTH))
        data.withUnsafeBytes { ptr in
            _ = CC_SHA1(ptr.baseAddress, CC_LONG(data.count), &out)
        }
        return out
    }
}
