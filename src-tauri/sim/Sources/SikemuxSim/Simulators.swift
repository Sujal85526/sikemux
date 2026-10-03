import CoreGraphics
import CoreSimulator
import FBControlCore
import FBSimulatorControl
import Foundation

/// The device work. One per helper process, so CoreSimulator is loaded once and HID connections are reused.
actor Simulators {
    private var control: SimulatorControlBootstrap?
    private var touch: [String: SimulatorHID] = [:]

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

    func screenshot(_ udid: String?) async throws -> Data {
        try await booted(udid).screenshot.takeForRepl(cropRect: nil, asPNG: true)
    }

    func tree(_ udid: String?) async throws -> Any {
        let response = try await booted(udid).uiAutomation(backend: .accessibility)
            .describe(.frontmost, options: AccessibilityRequestOptions(format: .nested, enableLogging: false))
        return try JSONSerialization.jsonObject(with: JSONEncoder().encode(response.elements.elements))
    }

    func frame(of label: String, on udid: String?) async throws -> CGRect {
        do {
            return try await booted(udid).uiAutomation(backend: .accessibility)
                .frame(.marker(value: label, key: .label, depth: .max))
        } catch {
            throw Failure(reason: "notFound", message: "\(error)")
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
            throw Failure(reason: "noXcode", message: "The iOS Simulator needs Xcode. Install it from the App Store and open it once.")
        }
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
