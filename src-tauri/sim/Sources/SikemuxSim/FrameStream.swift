import FBControlCore
import FBSimulatorControl
import Foundation
import Network

/// A live view of one simulator's screen, served as an MJPEG stream that an `<img>` element shows
/// directly. A frame is encoded only when the simulator draws one, so a still screen costs nothing.
final class FrameStream: @unchecked Sendable {
    private static let maxFramesPerSecond = 30.0
    private static let quality = 0.75
    /// Twice the screen's size in points, which stays sharp on a Retina display at a fraction of the
    /// device's own pixels.
    private static let pixelsPerPoint = 2.0

    private let token = UUID().uuidString.lowercased()
    private var port: UInt16 = 0
    private let listener: NWListener
    /// The attachment holds its framebuffer weakly, and the frames stop when it goes.
    private let framebuffer: Framebuffer
    private let attachment: FramebufferAttachment
    private let generator: SurfaceImageGenerator
    private let screenScale: Double
    private let queue = DispatchQueue(label: "sikemux-sim.frames")
    private var viewers: [ObjectIdentifier: Viewer] = [:]
    private var latest: Data?
    private var pending = false
    private var lastSent = Date.distantPast

    /// Touched only on `queue`, like the rest of this stream's state.
    private final class Viewer: @unchecked Sendable {
        let connection: NWConnection
        var sending = false
        init(_ connection: NWConnection) { self.connection = connection }

        /// Whether the listener has reported that it started; read and set on `queue`.
        final class Flag: @unchecked Sendable { var isSet = false }
    }

    static func start(_ simulator: Simulator, logger: any ControlCoreLogger) async throws -> FrameStream {
        let framebuffer = try await simulator.framebuffer.connect()
        let attachment = try framebuffer.attach()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let stream = FrameStream(
            listener: listener, framebuffer: framebuffer, attachment: attachment,
            generator: SurfaceImageGenerator(purpose: "desk", logger: logger),
            screenScale: Double(simulator.screenInfo?.scale ?? 1))
        stream.port = try await stream.listen()
        Task { await stream.follow() }
        return stream
    }

    private init(
        listener: NWListener, framebuffer: Framebuffer, attachment: FramebufferAttachment,
        generator: SurfaceImageGenerator, screenScale: Double
    ) {
        self.listener = listener
        self.framebuffer = framebuffer
        self.attachment = attachment
        self.generator = generator
        self.screenScale = screenScale
    }

    var address: String { "http://127.0.0.1:\(port)/\(token)" }

    private func listen() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { continuation in
            let started = Viewer.Flag()
            listener.stateUpdateHandler = { [listener] state in
                guard !started.isSet else { return }
                switch state {
                case .ready:
                    started.isSet = true
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error):
                    started.isSet = true
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
        }
    }

    func stop() {
        attachment.cancel()
        listener.cancel()
        queue.async {
            for viewer in self.viewers.values { viewer.connection.cancel() }
            self.viewers.removeAll()
        }
    }

    /// Renders on each drawn frame, at most `maxFramesPerSecond` times a second; frames drawn
    /// in between are folded into the next render rather than queued.
    private func follow() async {
        generator.updateSurface(attachment.initialSurface)
        render()
        for await event in attachment.events {
            switch event {
            case let .surfaceChanged(surface):
                generator.updateSurface(surface)
                render()
            case .frameRendered:
                render()
            }
        }
    }

    private func render() {
        queue.async {
            guard !self.pending else { return }
            let wait = max(0, 1 / Self.maxFramesPerSecond - Date().timeIntervalSince(self.lastSent))
            self.pending = true
            self.queue.asyncAfter(deadline: .now() + wait) {
                self.pending = false
                self.lastSent = Date()
                guard let frame = self.encode() else { return }
                self.latest = frame
                for viewer in self.viewers.values { self.send(frame, to: viewer) }
            }
        }
    }

    private func encode() -> Data? {
        let scale = Self.pixelsPerPoint / max(screenScale, 1)
        let configuration = ScreenshotConfiguration(encoding: .jpeg(quality: Self.quality), scale: scale < 1 ? .factor(scale) : .native)
        guard let rendered = try? generator.image(configuration: configuration, screenScale: screenScale) else { return nil }
        return try? ScreenshotRenderer.encode(rendered.image, encoding: .jpeg(quality: Self.quality))
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, _, _ in
            guard let self else { return }
            let request = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            guard request.hasPrefix("GET /\(self.token) ") else {
                connection.send(content: Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
                    completion: .contentProcessed { _ in connection.cancel() })
                return
            }
            let viewer = Viewer(connection)
            self.viewers[ObjectIdentifier(viewer)] = viewer
            connection.stateUpdateHandler = { [weak self] state in
                if case .cancelled = state { self?.viewers[ObjectIdentifier(viewer)] = nil }
                if case .failed = state { self?.viewers[ObjectIdentifier(viewer)] = nil }
            }
            let header = "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n"
                + "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(header.utf8), completion: .contentProcessed { _ in })
            if let latest = self.latest { self.send(latest, to: viewer) }
        }
    }

    /// A viewer still taking the previous frame skips this one, so a slow one never builds a backlog.
    private func send(_ frame: Data, to viewer: Viewer) {
        guard !viewer.sending else { return }
        viewer.sending = true
        var part = Data("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(frame.count)\r\n\r\n".utf8)
        part.append(frame)
        part.append(Data("\r\n".utf8))
        viewer.connection.send(content: part, completion: .contentProcessed { [weak viewer] error in
            viewer?.sending = false
            if error != nil { viewer?.connection.cancel() }
        })
    }
}
