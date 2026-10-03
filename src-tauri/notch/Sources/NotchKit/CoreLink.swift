import Foundation

enum CoreLinkError: Error {
    case closed
    case refused(String)

    var message: String {
        switch self {
        case .closed: return "Sikemux's core went away"
        case .refused(let message): return message
        }
    }
}

/// One connection to the core, speaking its frames: a 4-byte big-endian length,
/// a kind byte, then JSON for control frames. Callbacks arrive on the main queue.
final class CoreLink {
    typealias Reply = (Result<[String: Any], CoreLinkError>) -> Void

    var onReady: (() -> Void)?
    var onEvent: (([String: Any]) -> Void)?
    var onClose: ((String?) -> Void)?

    private let socketPath: String
    private let protocolVersion: Int
    private let queue = DispatchQueue(label: "com.nodelike.sikemux.notch.core")
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffer: [UInt8] = []
    private var nextRequest: UInt64 = 1
    private var replies: [UInt64: Reply] = [:]
    private var closed = false

    init(socket: String, protocolVersion: Int) {
        socketPath = socket
        self.protocolVersion = protocolVersion
    }

    /// False when nothing listens on the socket.
    func connect() -> Bool {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < capacity else {
            Darwin.close(descriptor)
            return false
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
            raw[pathBytes.count] = 0
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            Darwin.close(descriptor)
            return false
        }
        var on: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        fd = descriptor
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        source.resume()
        self.source = source
        queue.async {
            self.write(["type": "hello", "protocol": "sikemux-core", "version": self.protocolVersion])
        }
        return true
    }

    func request(_ request: [String: Any], reply: Reply? = nil) {
        queue.async {
            guard !self.closed else {
                DispatchQueue.main.async { reply?(.failure(.closed)) }
                return
            }
            let id = self.nextRequest
            self.nextRequest += 1
            if let reply { self.replies[id] = reply }
            self.write(["type": "request", "requestId": id, "request": request])
        }
    }

    func close() {
        queue.async { self.finish(nil) }
    }

    private func write(_ message: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: message) else { return }
        var frame = [UInt8]()
        let length = UInt32(json.count + 1).bigEndian
        withUnsafeBytes(of: length) { frame.append(contentsOf: $0) }
        frame.append(0)
        frame.append(contentsOf: json)
        var offset = 0
        while offset < frame.count {
            let written = frame[offset...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            if written <= 0 {
                finish("could not write to the core")
                return
            }
            offset += written
        }
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let count = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard count > 0 else {
            finish(nil)
            return
        }
        buffer.append(contentsOf: chunk[0..<count])
        while buffer.count >= 4 {
            let length = Int(buffer[0]) << 24 | Int(buffer[1]) << 16 | Int(buffer[2]) << 8 | Int(buffer[3])
            guard length > 0 else {
                finish("the core sent an empty frame")
                return
            }
            guard buffer.count >= 4 + length else { break }
            let kind = buffer[4]
            let payload = Data(buffer[5..<(4 + length)])
            buffer.removeFirst(4 + length)
            if kind == 0 { handle(payload) }
        }
    }

    private func handle(_ payload: Data) {
        guard let message = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any],
              let type = message["type"] as? String
        else { return }
        switch type {
        case "helloAck":
            DispatchQueue.main.async { self.onReady?() }
        case "helloRejected":
            finish(message["message"] as? String ?? "the core speaks another protocol version")
        case "response":
            guard let id = (message["requestId"] as? NSNumber)?.uint64Value,
                  let reply = replies.removeValue(forKey: id)
            else { return }
            let response = message["response"] as? [String: Any] ?? [:]
            DispatchQueue.main.async { reply(.success(response)) }
        case "error":
            let text = message["message"] as? String ?? "the core refused"
            guard let id = (message["requestId"] as? NSNumber)?.uint64Value,
                  let reply = replies.removeValue(forKey: id)
            else { return }
            DispatchQueue.main.async { reply(.failure(.refused(text))) }
        case "event":
            guard let event = message["event"] as? [String: Any] else { return }
            DispatchQueue.main.async { self.onEvent?(event) }
        default:
            break
        }
    }

    private func finish(_ reason: String?) {
        guard !closed else { return }
        closed = true
        source?.cancel()
        source = nil
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
        let pending = replies
        replies.removeAll()
        DispatchQueue.main.async {
            for reply in pending.values { reply(.failure(.closed)) }
            self.onClose?(reason)
        }
    }
}

/// Starts the core the way the app does: the same binary, socket and
/// arguments, in a session of its own so it outlives this process.
enum CoreStarter {
    static func start(_ options: Options) {
        guard let binary = options.coreBinary else { return }
        var arguments = [binary, "core", "--socket", options.socket] + options.coreArgs
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        let log = options.coreLog ?? "/dev/null"
        posix_spawn_file_actions_addopen(&actions, 1, log, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)
        let argv = arguments.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        _ = posix_spawn(&pid, binary, &actions, &attributes, argv, environ)
        arguments.removeAll()
    }
}
