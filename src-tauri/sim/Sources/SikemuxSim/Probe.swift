import Foundation
import SikemuxSimKit

/// Drives a real simulator through every kind of request, so the helper can be checked without the app.
@MainActor
enum Probe {
    static func run(_ simulators: Simulators, device: String?) async -> Bool {
        do {
            let udid = try await pick(simulators, device: device)
            try await step("boot") { try await simulators.handle(.boot(udid: udid)) }
            try await step("home button") { try await simulators.handle(.button(udid: udid, button: .home)) }
            try await waitFor("the home screen") { try await onHomeScreen(simulators, udid) }
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("sikemux-sim-probe.png").path
            let shot = try await step("screenshot") { try await simulators.handle(.screenshot(udid: udid, path: path)) }
            report("  \(shot["width"] ?? 0)x\(shot["height"] ?? 0) px at \(path)")
            try await step("read the screen") { try await simulators.handle(.state(udid: udid)) }
            try await step("tap \"Settings\" by label") { try await simulators.handle(.tapElement(udid: udid, label: "Settings")) }
            try await waitFor("Settings to open") {
                labels(try await simulators.handle(.state(udid: udid))).contains("General")
            }
            try await step("tap at a point") { try await simulators.handle(.tap(udid: udid, at: Point(x: 10, y: 10), duration: nil)) }
            try await step("swipe") {
                try await simulators.handle(.swipe(udid: udid, from: Point(x: 200, y: 600), to: Point(x: 200, y: 300), duration: 0.3))
            }
            try await step("home button") { try await simulators.handle(.button(udid: udid, button: .home)) }
            try await waitFor("the home screen") { try await onHomeScreen(simulators, udid) }
            report("PASS")
            return true
        } catch {
            report("FAIL: \(error)")
            return false
        }
    }

    private static func pick(_ simulators: Simulators, device: String?) async throws -> String {
        let devices = try await simulators.handle(.devices)["devices"] as? [[String: Any]] ?? []
        report("\(devices.count) simulators")
        let chosen = devices.first { device != nil && ($0["udid"] as? String == device || $0["name"] as? String == device) }
            ?? devices.first { $0["booted"] as? Bool == true && ($0["name"] as? String)?.hasPrefix("iPhone") == true }
            ?? devices.first { ($0["name"] as? String)?.hasPrefix("iPhone") == true }
        guard let chosen, let udid = chosen["udid"] as? String else { throw SimulatorError("no iPhone simulator to probe") }
        report("using \(chosen["name"] ?? "") \(chosen["os"] ?? "") (\(udid))")
        return udid
    }

    @discardableResult
    private static func step(_ name: String, _ body: () async throws -> [String: Any]) async throws -> [String: Any] {
        let started = Date()
        let result = try await body()
        report(String(format: "%-26@ %6.0f ms", name as NSString, Date().timeIntervalSince(started) * 1000))
        return result
    }

    private static func waitFor(_ name: String, _ check: () async throws -> Bool) async throws {
        let started = Date()
        while try await !check() {
            guard Date().timeIntervalSince(started) < 10 else { throw SimulatorError("timed out waiting for \(name)") }
            try await Task.sleep(for: .milliseconds(250))
        }
        report(String(format: "%-26@ %6.0f ms", "wait for \(name)" as NSString, Date().timeIntervalSince(started) * 1000))
    }

    /// Settings' launch icon, alone: while an app is still animating away its own elements are read too.
    private static func onHomeScreen(_ simulators: Simulators, _ udid: String) async throws -> Bool {
        let onScreen = labels(try await simulators.handle(.state(udid: udid)))
        return onScreen.filter { $0 == "Settings" }.count == 1 && !onScreen.contains("General")
    }

    private static func labels(_ state: [String: Any]) -> [String] {
        (state["elements"] as? [[String: Any]] ?? []).compactMap { $0["AXLabel"] as? String }
    }

    private static func expect(_ condition: Bool, _ message: @autoclosure () -> String) throws {
        if !condition { throw SimulatorError(message()) }
    }

    private static func report(_ line: String) {
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}
