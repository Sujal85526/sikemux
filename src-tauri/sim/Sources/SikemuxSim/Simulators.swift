import FBControlCore
import FBSimulatorControl
import Foundation
import SikemuxSimKit

struct SimulatorError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// The simulators in Xcode's default device set, and the touch connection to each booted one.
@MainActor
final class Simulators {
    private static let bootDeadline: TimeInterval = 120
    private static let keystrokeGap: TimeInterval = 0.025

    private let control: SimulatorControlBootstrap
    private let logger: any ControlCoreLogger
    private var connections: [String: SimulatorHID] = [:]
    private var streams: [String: FrameStream] = [:]
    /// The edge a live touch started at, kept for its moves and release, by device.
    private var touchEdges: [String: SimulatorHIDEdge] = [:]
    /// The latest live touch step sent to each device; the next one waits for it, so a move never
    /// overtakes its touch-down.
    private var touchSteps: [String: Task<Void, Error>] = [:]

    init() throws {
        logger = FBControlCoreLoggerFactory.systemLoggerWriting(toStderr: false, withDebugLogging: false)
        do {
            control = try SimulatorControlBootstrap.withConfiguration(SimulatorControlConfiguration(deviceSetPath: nil, logger: logger))
        } catch {
            throw SimulatorError("CoreSimulator could not be loaded from the Xcode at \(Self.developerDirectory()): \(error)")
        }
    }

    static func developerDirectory() -> String {
        let pipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        process.arguments = ["-p"]
        process.standardOutput = pipe
        try? process.run()
        process.waitUntilExit()
        let path = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return path.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func handle(_ command: Command) async throws -> [String: Any] {
        if case .devices = command { return ["devices": control.set.allSimulators.map(describe)] }
        let simulator = try find(command.udid ?? "")
        switch command {
        case .devices:
            return [:]
        case .boot:
            try await boot(simulator)
            return describe(simulator)
        case .shutdown:
            connections[simulator.udid] = nil
            streams.removeValue(forKey: simulator.udid)?.stop()
            // idb does not mark its device set Sendable; every call to it here is made from the main actor.
            nonisolated(unsafe) let set = control.set
            if simulator.state != .shutdown { try await set.shutdown(simulator) }
            return [:]
        case let .screenshot(_, path, format, pointSize):
            let scale = pointSize ? Double(simulator.screenInfo?.scale ?? 1) : 1
            let configuration = ScreenshotConfiguration(
                encoding: format == .jpeg ? .jpeg(quality: 0.8) : .png,
                scale: scale > 1 ? .factor(1 / scale) : .native)
            let shot = try await requireBooted(simulator).screenshot.take(configuration: configuration)
            try shot.imageData.write(to: URL(fileURLWithPath: path))
            return ["path": path, "width": Int(shot.size.width), "height": Int(shot.size.height)]
        case let .tap(_, at, duration):
            let event: SimulatorHIDEvent = if let duration { .tapAt(x: at.x, y: at.y, duration: duration) } else { .tapAt(x: at.x, y: at.y) }
            try await send(event, to: simulator)
            return [:]
        case let .touch(_, phase, at):
            let edge: SimulatorHIDEdge
            if phase == .down {
                edge = edgeAt(at, of: simulator)
                touchEdges[simulator.udid] = edge
            } else {
                edge = touchEdges[simulator.udid] ?? .none
            }
            if phase == .up { touchEdges[simulator.udid] = nil }
            let step = SimulatorHIDEvent.touch(direction: phase == .up ? .up : .down, x: at.x, y: at.y, edge: edge)
            let previous = touchSteps[simulator.udid]
            let sent = Task { @MainActor in
                _ = await previous?.result
                try await self.send(step, to: simulator)
            }
            touchSteps[simulator.udid] = sent
            try await sent.value
            return [:]
        case let .swipe(_, from, to, duration):
            let swipe = SimulatorHIDEvent.swipe(
                from.x, yStart: from.y, xEnd: to.x, yEnd: to.y, delta: 0, duration: duration, edge: edgeAt(from, of: simulator))
            try await send(swipe, to: simulator)
            return [:]
        case let .type(_, text):
            let strokes = try Keyboard.strokes(for: text).get()
            // A text field drops keys that arrive all at once, so each waits a moment for the last.
            let keys = strokes.map { SimulatorHIDEvent.composite(Self.events(for: $0)) }
            let paced = keys.flatMap { [$0, SimulatorHIDEvent.delay(Self.keystrokeGap)] }
            try await send(.composite(paced), to: simulator)
            return [:]
        case let .button(_, button):
            try await send(.shortButtonPress(Self.hidButton(button)), to: simulator)
            return [:]
        case .state:
            return ["elements": try await elements(of: simulator)]
        case let .tapElement(_, label):
            let screen = Self.screenSize(simulator).map { Frame(x: 0, y: 0, width: $0.width, height: $0.height) }
            let frame = try ElementLookup.frame(of: label, in: try await elements(of: simulator), screen: screen).get()
            try await send(.tapAt(x: frame.center.x, y: frame.center.y), to: simulator)
            return ["x": frame.center.x, "y": frame.center.y]
        case let .launch(_, bundleId, arguments, environment):
            let configuration = ApplicationLaunchConfiguration(
                bundleID: bundleId, bundleName: nil, arguments: arguments, environment: environment,
                waitForDebugger: false, io: FBProcessIO<AnyObject, AnyObject, AnyObject>.outputToDevNull(),
                launchMode: .relaunchIfRunning)
            let launched = try await requireBooted(simulator).application.launch(configuration)
            return ["pid": Int(launched.processIdentifier)]
        case let .terminate(_, bundleId):
            try await requireBooted(simulator).application.kill(bundleID: bundleId)
            return [:]
        case let .install(_, path):
            let installed = try await requireBooted(simulator).application.install(atPath: path)
            return ["bundleId": installed.bundle.identifier]
        case let .openUrl(_, url):
            try await requireBooted(simulator).lifecycle.open(url)
            return [:]
        case .stream:
            if let running = streams[simulator.udid] { return ["url": running.address] }
            let stream = try await FrameStream.start(requireBooted(simulator), logger: logger)
            streams[simulator.udid] = stream
            return ["url": stream.address]
        case let .chrome(_, chromePath, maskPath):
            guard let deviceType = simulator.device.deviceType?.name, let size = Self.screenSize(simulator) else {
                throw SimulatorError("\(simulator.name) has no device type to draw")
            }
            let layout = try DeviceChrome.render(
                deviceType: deviceType, screen: CGSize(width: size.width, height: size.height),
                chrome: URL(fileURLWithPath: chromePath), mask: URL(fileURLWithPath: maskPath))
            return [
                "width": layout.size.width, "height": layout.size.height,
                "screen": ["x": layout.screen.minX, "y": layout.screen.minY, "width": layout.screen.width, "height": layout.screen.height],
            ]
        case .stopStream:
            streams.removeValue(forKey: simulator.udid)?.stop()
            return [:]
        }
    }

    private func find(_ udid: String) throws -> Simulator {
        guard let simulator = control.set.simulator(withUDID: udid) else { throw SimulatorError("no simulator \(udid)") }
        return simulator
    }

    private func requireBooted(_ simulator: Simulator) throws -> Simulator {
        guard simulator.state == .booted else { throw SimulatorError("\(simulator.name) is not booted") }
        return simulator
    }

    /// Booting returns before the home screen is up, so wait until the screen can be read as well.
    private func boot(_ simulator: Simulator) async throws {
        if simulator.state != .booted {
            try await simulator.lifecycle.boot(SimulatorBootConfiguration(options: [.verifyUsable], environment: [:]))
        }
        let deadline = Date().addingTimeInterval(Self.bootDeadline)
        while true {
            do {
                _ = try await elements(of: simulator)
                return
            } catch where Date() < deadline {
                try await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    private func elements(of simulator: Simulator) async throws -> [[String: Any]] {
        let read = try await requireBooted(simulator).uiAutomation(backend: .accessibility)
            .describe(.frontmost, options: AccessibilityRequestOptions())
        let json = try JSONSerialization.jsonObject(with: try read.formattedOutputJSON(format: .default))
        return (json as? [String: Any])?["elements"] as? [[String: Any]] ?? []
    }

    private func send(_ event: SimulatorHIDEvent, to simulator: Simulator) async throws {
        let hid: SimulatorHID
        if let open = connections[simulator.udid] {
            hid = open
        } else {
            hid = try await requireBooted(simulator).hid.connect()
            connections[simulator.udid] = hid
        }
        do {
            try await hid.send(event: event, logger: logger)
        } catch {
            connections[simulator.udid] = nil
            throw error
        }
    }

    private func describe(_ simulator: Simulator) -> [String: Any] {
        var device: [String: Any] = [
            "udid": simulator.udid, "name": simulator.name, "os": simulator.osVersion.name.rawValue,
            "state": "\(simulator.stateString)", "booted": simulator.state == .booted,
        ]
        if let size = Self.screenSize(simulator) {
            device["screen"] = ["width": size.width, "height": size.height, "scale": size.scale]
        }
        return device
    }

    /// A touch starting at a side of the screen is tagged with it, so iOS treats it as the system
    /// gesture a finger there would make: home, back, Notification Center or Control Center.
    private func edgeAt(_ point: Point, of simulator: Simulator) -> SimulatorHIDEdge {
        guard let size = Self.screenSize(simulator),
            let edge = ScreenEdge.of(point, width: size.width, height: size.height)
        else { return .none }
        switch edge {
        case .top: return .top
        case .left: return .left
        case .bottom: return .bottom
        case .right: return .right
        }
    }

    /// The screen in points, the unit every coordinate here is in.
    private static func screenSize(_ simulator: Simulator) -> (width: Double, height: Double, scale: Double)? {
        guard let screen = simulator.screenInfo, screen.scale > 0 else { return nil }
        let scale = Double(screen.scale)
        return (Double(screen.widthPixels) / scale, Double(screen.heightPixels) / scale, scale)
    }

    private static func events(for stroke: KeyStroke) -> [SimulatorHIDEvent] {
        let press: [SimulatorHIDEvent] = [.keyboard(direction: .down, keyCode: stroke.keyCode), .keyboard(direction: .up, keyCode: stroke.keyCode)]
        guard stroke.shifted else { return press }
        return [.keyboard(direction: .down, keyCode: KeyStroke.shift)] + press + [.keyboard(direction: .up, keyCode: KeyStroke.shift)]
    }

    private static func hidButton(_ button: Button) -> SimulatorHIDButton {
        switch button {
        case .home: .homeButton
        case .lock: .lock
        case .side: .sideButton
        case .siri: .siri
        case .volumeUp: .volumeUp
        case .volumeDown: .volumeDown
        case .applePay: .applePay
        }
    }
}
