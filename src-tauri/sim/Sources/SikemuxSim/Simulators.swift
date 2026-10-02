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

    private let control: SimulatorControlBootstrap
    private let logger: any ControlCoreLogger
    private var connections: [String: SimulatorHID] = [:]

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
            // idb does not mark its device set Sendable; every call to it here is made from the main actor.
            nonisolated(unsafe) let set = control.set
            if simulator.state != .shutdown { try await set.shutdown(simulator) }
            return [:]
        case let .screenshot(_, path):
            let shot = try await requireBooted(simulator).screenshot.take(configuration: ScreenshotConfiguration())
            try shot.imageData.write(to: URL(fileURLWithPath: path))
            return ["path": path, "width": Int(shot.size.width), "height": Int(shot.size.height)]
        case let .tap(_, at, duration):
            let event: SimulatorHIDEvent = if let duration { .tapAt(x: at.x, y: at.y, duration: duration) } else { .tapAt(x: at.x, y: at.y) }
            try await send(event, to: simulator)
            return [:]
        case let .swipe(_, from, to, duration):
            try await send(.swipe(from.x, yStart: from.y, xEnd: to.x, yEnd: to.y, delta: 0, duration: duration), to: simulator)
            return [:]
        case let .type(_, text):
            let strokes = try Keyboard.strokes(for: text).get()
            try await send(.composite(strokes.flatMap(Self.events)), to: simulator)
            return [:]
        case let .button(_, button):
            try await send(.shortButtonPress(Self.hidButton(button)), to: simulator)
            return [:]
        case .state:
            return ["elements": try await elements(of: simulator)]
        case let .tapElement(_, label):
            let frame = try ElementLookup.frame(of: label, in: try await elements(of: simulator)).get()
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
        if let screen = simulator.screenInfo, screen.scale > 0 {
            let scale = Double(screen.scale)
            device["screen"] = ["width": Double(screen.widthPixels) / scale, "height": Double(screen.heightPixels) / scale, "scale": scale]
        }
        return device
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
