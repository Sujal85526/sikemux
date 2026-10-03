import FBControlCore
import Foundation
import Network

/// A device's screen, served on 127.0.0.1 either as WebSocket messages, for the page to read
/// itself, or as length-prefixed frames on a plain socket, for the app to pass on. A WebSocket
/// viewer offers the stream's token as its subprotocol; a plain one sends it as its first line.
final class FrameStream: NSObject, DataConsumer, @unchecked Sendable {
    let token: String
    private let listener: NWListener
    private let queue = DispatchQueue(label: "sikemux-sim.frames")
    private var viewers: [NWConnection] = []
    private let framed: Bool
    var operation: (any VideoStreamOperation)?

    var port: UInt16 { listener.port?.rawValue ?? 0 }

    init(framed: Bool, token: String = "sikemux-sim.\(UUID().uuidString.lowercased())") throws {
        self.token = token
        self.framed = framed
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        if !framed {
            let socket = NWProtocolWebSocket.Options()
            socket.setClientRequestHandler(queue) { subprotocols, _ in
                subprotocols.contains(token) ? .init(status: .accept, subprotocol: token) : .init(status: .reject, subprotocol: nil)
            }
            parameters.defaultProtocolStack.applicationProtocols.insert(socket, at: 0)
        }
        listener = try NWListener(using: parameters)
        super.init()
        listener.newConnectionHandler = { [weak self] connection in self?.admit(connection) }
    }

    /// Starts listening and returns once the port is known.
    func listen() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var resumed = false
            listener.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    continuation.resume()
                case let .failed(error):
                    resumed = true
                    continuation.resume(throwing: Failure(reason: "stream", message: "Could not open the screen stream: \(error)"))
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() {
        listener.cancel()
        queue.async { self.viewers.forEach { $0.cancel() } }
    }

    private func admit(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready:
                if self.framed { self.checkToken(of: connection) } else { self.viewers.append(connection) }
            case .failed, .cancelled:
                self.viewers.removeAll { $0 === connection }
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func checkToken(of connection: NWConnection) {
        let expected = Data((token + "\n").utf8)
        connection.receive(minimumIncompleteLength: expected.count, maximumLength: expected.count) { [weak self] data, _, _, _ in
            guard let self else { return }
            if data == expected { self.viewers.append(connection) } else { connection.cancel() }
        }
    }

    func consumeData(_ data: Data) {
        queue.async {
            if self.framed {
                var length = UInt32(data.count).bigEndian
                let frame = Data(bytes: &length, count: 4) + data
                for viewer in self.viewers { viewer.send(content: frame, completion: .idempotent) }
                return
            }
            let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
            let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
            for viewer in self.viewers {
                viewer.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
            }
        }
    }

    func consumeEndOfFile() {
        stop()
    }
}
