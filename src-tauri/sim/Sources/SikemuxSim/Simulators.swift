import CoreGraphics
import CoreSimulator
import FBControlCore
import FBSimulatorControl
import Foundation

/// The device work. One per helper process, so CoreSimulator is loaded once and HID connections are reused.
actor Simulators {
    private var control: SimulatorControlBootstrap?
    private var touch: [String: SimulatorHID] = [:]
    private var tails: [String: (tail: LogTail, task: Task<Void, Never>)] = [:]
    private var streams: [String: FrameStream] = [:]
    /// The orientation each device was last turned to here, for runtimes that cannot report it.
    private var turned: [String: String] = [:]
    /// Devices whose runtime cannot report its orientation, and so turns by the older event that
    /// leaves touches in the screen's own portrait points.
    private var portraitTouches: Set<String> = []

    func devices() throws -> [[String: Any]] {
        try set().allSimulators.map { simulator in
            [
                "udid": simulator.udid,
                "name": simulator.name,
                "state": simulator.state == .booted ? "booted" : simulator.state == .shutdown ? "shutdown" : "busy",
                "runtime": simulator.osVersion.name.rawValue,
                "model": simulator.deviceType.model.rawValue,
            ]
        }
    }

    /// The device's screen in points, which is what touches are given in, and its pixels per point.
    func screen(_ udid: String?) async throws -> [String: Any] {
        guard let info = try await booted(udid).screenInfo else {
            throw Failure(reason: "simulator", message: "The device did not report its screen size")
        }
        let scale = Double(info.scale)
        return ["width": Double(info.widthPixels) / scale, "height": Double(info.heightPixels) / scale, "scale": scale]
    }

    func orient(_ udid: String?, to name: String) async throws {
        let settable: [SimulatorDeviceOrientation] = [.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight]
        guard let orientation = SimulatorDeviceOrientation(rawValue: name), settable.contains(orientation) else {
            throw Failure(
                reason: "badRequest", message: "Unknown orientation \(name). Use portrait, portraitUpsideDown, landscapeLeft or landscapeRight.")
        }
        let simulator = try await booted(udid)
        try await simulator.orientation.set(orientation)
        turned[simulator.udid] = name
    }

    /// Older runtimes cannot report the orientation, so the last one set here stands in, else portrait.
    func orientation(_ udid: String?) async throws -> String {
        let simulator = try await booted(udid)
        if let current = try? await simulator.orientation.current() { return "\(current.rawValue)" }
        portraitTouches.insert(simulator.udid)
        return turned[simulator.udid] ?? "portrait"
    }

    /// Where to touch a point given in the turned screen's points. Runtimes that report their
    /// orientation take those as they are; on the others the screen keeps its portrait points, and a
    /// turned app is drawn sideways in them.
    func touchPoint(_ point: CGPoint, on udid: String?) async throws -> CGPoint {
        let simulator = try await booted(udid)
        guard portraitTouches.contains(simulator.udid), let info = simulator.screenInfo, info.scale > 0 else { return point }
        let scale = Double(info.scale)
        let portrait = CGSize(width: Double(info.widthPixels) / scale, height: Double(info.heightPixels) / scale)
        return Self.portraitPoint(point, turned: turned[simulator.udid], screen: portrait)
    }

    /// Where a point on a turned screen is drawn on its portrait screen, `screen` in points.
    static func portraitPoint(_ point: CGPoint, turned: String?, screen: CGSize) -> CGPoint {
        switch turned {
        case "landscapeLeft": CGPoint(x: screen.width - point.y, y: point.x)
        case "landscapeRight": CGPoint(x: point.y, y: screen.height - point.x)
        case "portraitUpsideDown": CGPoint(x: screen.width - point.x, y: screen.height - point.y)
        default: point
        }
    }

    func touchPoints(_ points: [TouchPoint], on udid: String?) async throws -> [TouchPoint] {
        var placed: [TouchPoint] = []
        for point in points {
            let first = try await touchPoint(CGPoint(x: point.x, y: point.y), on: udid)
            var second: CGPoint?
            if let x2 = point.x2, let y2 = point.y2 { second = try await touchPoint(CGPoint(x: x2, y: y2), on: udid) }
            placed.append(TouchPoint(x: first.x, y: first.y, x2: second.map { Double($0.x) }, y2: second.map { Double($0.y) }, t: point.t))
        }
        return placed
    }

    /// A swipe starting at a side of the screen is tagged with it, so iOS treats it as the system
    /// gesture a finger there would make: home, back, Notification Center or Control Center.
    func edge(at point: CGPoint, on udid: String?) async throws -> SimulatorHIDEdge {
        let simulator = try await booted(udid)
        guard let info = simulator.screenInfo, info.scale > 0 else { return .none }
        let scale = Double(info.scale)
        let sideways = try await orientation(udid).hasPrefix("landscape")
        let (short, long) = (Double(info.widthPixels) / scale, Double(info.heightPixels) / scale)
        let (width, height) = sideways ? (long, short) : (short, long)
        let reach = 10.0
        if point.y >= height - reach { return .bottom }
        if point.y <= reach { return .top }
        if point.x <= reach { return .left }
        if point.x >= width - reach { return .right }
        return .none
    }

    func runtimes() throws -> [[String: Any]] {
        _ = try set()
        return (control?.serviceContext.supportedRuntimes() ?? []).map { runtime in
            ["identifier": runtime.identifier, "name": runtime.name, "version": runtime.versionString, "available": runtime.available]
        }
    }

    func boot(_ udid: String?) async throws {
        let simulator = try find(udid)
        if simulator.state != .booted { try await simulator.lifecycle.boot(.default) }
        try await simulator.lifecycle.resolveUsable()
    }

    func shutdown(_ udid: String?) async throws {
        let simulator = try find(udid)
        touch[simulator.udid] = nil
        try await set().shutdown(simulator)
    }

    /// `pointSize` draws one pixel per point, a ninth of a Retina screenshot's pixels, for agents to read.
    func screenshot(_ udid: String?, jpeg: Bool = false, pointSize: Bool = false) async throws -> (data: Data, width: Int, height: Int) {
        let simulator = try await booted(udid)
        let scale = pointSize ? Double(simulator.screenInfo?.scale ?? 1) : 1
        let configuration = ScreenshotConfiguration(
            encoding: jpeg ? .jpeg(quality: 0.8) : .png, scale: scale > 1 ? .factor(1 / scale) : .native)
        let shot = try await simulator.screenshot.take(configuration: configuration)
        return (shot.imageData, Int(shot.size.width), Int(shot.size.height))
    }

    func tree(_ udid: String?) async throws -> Any {
        let response = try await booted(udid).uiAutomation(backend: .accessibility)
            .describe(.frontmost, options: AccessibilityRequestOptions(format: .nested, enableLogging: false))
        return try JSONSerialization.jsonObject(with: JSONEncoder().encode(response.elements.elements))
    }

    /// Looks again every quarter second until `wait` runs out, since a label is often still on its way in
    /// just after a tap, a key press or a screen change.
    func frame(of label: String, on udid: String?, wait: TimeInterval) async throws -> CGRect {
        let automation = try await booted(udid).uiAutomation(backend: .accessibility)
        let deadline = Date().addingTimeInterval(wait)
        while true {
            do {
                return try await automation.frame(.marker(value: label, key: .label, depth: .max))
            } catch UIAutomationError.elementNotFound, UIAutomationError.elementNotOnScreen {
                guard Date() < deadline else { throw Failure(reason: "notFound", message: "Nothing labelled \"\(label)\" is on screen") }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
        }
    }

    func send(_ event: SimulatorHIDEvent, to udid: String?) async throws {
        let simulator = try await booted(udid)
        let hid: SimulatorHID
        if let connected = touch[simulator.udid] {
            hid = connected
        } else {
            hid = try await simulator.hid.connect()
            touch[simulator.udid] = hid
        }
        try await hid.send(event: event, logger: simulator.logger)
    }

    /// Starts following a device's log the first time it is asked for, filtered to one process if one is named.
    /// Once the whole device is followed, a process's lines come from there, kept since it started.
    func logs(on udid: String?, process: String?, after cursor: Int, generation: Int?, limit: Int) async throws -> [String: Any] {
        let simulator = try await booted(udid)
        if let process, let device = tails["\(simulator.udid) "] {
            return device.tail.read(process: process, after: cursor, limit: limit, generation: generation)
        }
        let key = "\(simulator.udid) \(process ?? "")"
        if tails[key] == nil {
            let tail = LogTail()
            var arguments = ["--style", "compact"]
            if let process {
                arguments += ["--predicate", "process == \"\(process.replacingOccurrences(of: "\"", with: ""))\""]
            } else {
                // Apple's frameworks log thousands of activity and debug entries a second, many with no
                // subsystem to exclude them by; ordinary log messages at Info and above keep an app's own.
                arguments += ["--type", "log", "--level", "info", "--predicate", "NOT (subsystem BEGINSWITH \"com.apple.\")"]
            }
            let operation = try await simulator.log.tail(arguments: arguments, consumer: tail.consumer)
            tail.attach(operation)
            let task = Task { _ = try? await operation.waitUntilCompleted() }
            tails[key] = (tail, task)
        }
        return tails[key]!.tail.read(after: cursor, limit: limit, generation: generation)
    }

    func stopLogs(on udid: String?, process: String?) throws {
        let key = "\(try find(udid).udid) \(process ?? "")"
        tails.removeValue(forKey: key)?.task.cancel()
    }

    /// One stream per device and format, shared by every viewer. H.264 sends a key frame each second so a
    /// late viewer starts within one; MJPEG is for a viewer whose H.264 decoder will not start.
    func stream(on udid: String?, format: String, fps: Int, scale: Double?) async throws -> [String: Any] {
        let simulator = try await booted(udid)
        let videoFormat: VideoStreamFormat
        switch format {
        case "h264": videoFormat = .compressedVideo(withCodec: .h264, transport: .annexB)
        case "mjpeg": videoFormat = .mjpeg(encoder: .allowSoftware)
        default: throw Failure(reason: "badRequest", message: "Unknown stream format \(format). Use h264 or mjpeg.")
        }
        let key = "\(simulator.udid) \(format)"
        if streams[key] == nil {
            let stream = try FrameStream()
            try await stream.listen()
            let configuration = VideoStreamConfiguration(
                format: videoFormat, framesPerSecond: fps, rateControl: nil, scaleFactor: scale, keyFrameRate: 1)
            stream.operation = try await simulator.videoStream.create(configuration: configuration, to: stream)
            streams[key] = stream
        }
        let stream = streams[key]!
        var answer: [String: Any] = ["port": Int(stream.port), "token": stream.token, "format": format]
        if format == "h264" { answer["transport"] = "annex-b" }
        return answer
    }

    func stopStream(on udid: String?, format: String?) async throws {
        let device = try find(udid).udid
        for key in streams.keys where key.hasPrefix(device + " ") && (format == nil || key == "\(device) \(format!)") {
            let stream = streams.removeValue(forKey: key)
            try? await stream?.operation?.stopStreaming()
            stream?.stop()
        }
    }

    func install(_ path: String, on udid: String?) async throws -> String {
        try await booted(udid).application.install(atPath: path).bundle.identifier
    }

    func launch(_ bundleId: String, arguments: [String], environment: [String: String], on udid: String?) async throws -> Int {
        let configuration = ApplicationLaunchConfiguration(
            bundleID: bundleId, bundleName: nil, arguments: arguments, environment: environment,
            waitForDebugger: false, io: FBProcessIO<AnyObject, AnyObject, AnyObject>.outputToDevNull(), launchMode: .relaunchIfRunning)
        return Int(try await booted(udid).application.launch(configuration).processIdentifier)
    }

    func terminate(_ bundleId: String, on udid: String?) async throws {
        try await booted(udid).application.kill(bundleID: bundleId)
    }

    func open(_ url: URL, on udid: String?) async throws {
        try await booted(udid).lifecycle.open(url)
    }

    private func set() throws -> SimulatorSet {
        if let control { return control.set }
        guard FileManager.default.fileExists(atPath: "/Library/Developer/PrivateFrameworks/CoreSimulator.framework") else {
            throw Failure(reason: "noXcode", message: Xcode.missing)
        }
        try Xcode.choose()
        let started = try SimulatorControlBootstrap.withConfiguration(SimulatorControlConfiguration(deviceSetPath: nil, logger: nil))
        control = started
        return started.set
    }

    private func find(_ udid: String?) throws -> Simulator {
        let simulators = try set().allSimulators
        if simulators.isEmpty {
            throw Failure(reason: "noRuntime", message: "No iOS simulators. Add an iOS runtime in Xcode > Settings > Components.")
        }
        if let udid {
            guard let simulator = simulators.first(where: { $0.udid == udid }) else {
                throw Failure(reason: "notFound", message: "No simulator with id \(udid)")
            }
            return simulator
        }
        guard let simulator = simulators.first(where: { $0.state == .booted }) else {
            throw Failure(reason: "notBooted", message: "No simulator is running. Boot one first.")
        }
        return simulator
    }

    private func booted(_ udid: String?) async throws -> Simulator {
        let simulator = try find(udid)
        guard simulator.state == .booted else {
            throw Failure(reason: "notBooted", message: "\(simulator.name) is not running. Boot it first.")
        }
        return simulator
    }
}
