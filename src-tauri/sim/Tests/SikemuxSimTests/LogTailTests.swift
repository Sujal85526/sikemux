import XCTest

@testable import SikemuxSim

final class LogTailTests: XCTestCase {
    private func line(_ process: String, _ message: String) -> String {
        "2026-10-06 08:26:18.980 I  \(process)[59951:25b52] (CoreHaptics) \(message)"
    }

    func testNamesTheProcessBeforeItsBracket() {
        XCTAssertEqual(LogTail.process(of: line("SimFixture", "tapped")), "SimFixture")
        XCTAssertEqual(
            LogTail.process(of: "2026-10-06 08:26:18.980 Df SimFixture[1:2] [com.nodelike.fixture:fixture] tapped"), "SimFixture")
        XCTAssertNil(LogTail.process(of: "Filtering the log data using \"process == x\""))
    }

    func testKeepsAProcessesLinesWhileOthersFillTheDevicesLog() {
        let tail = LogTail()
        tail.append(line("SimFixture", "tapped add one, count 1"))
        for index in 0..<(LogTail.capacity + 10) { tail.append(line("SpringBoard", "noise \(index)")) }

        let device = tail.read(after: 0, limit: 5)
        XCTAssertEqual(device["dropped"] as? Int, 11)
        XCTAssertFalse((device["lines"] as? [String] ?? []).contains { $0.contains("tapped") })

        let app = tail.read(process: "SimFixture", after: 0, limit: 5)
        XCTAssertEqual(app["lines"] as? [String], [line("SimFixture", "tapped add one, count 1")])
        XCTAssertEqual(app["cursor"] as? Int, 1)
        XCTAssertEqual(app["more"] as? Bool, false)
    }

    func testReadsOnFromAProcesssOwnCursor() {
        let tail = LogTail()
        for index in 1...3 {
            tail.append(line("SimFixture", "step \(index)"))
            tail.append(line("SpringBoard", "noise \(index)"))
        }
        let first = tail.read(process: "SimFixture", after: 0, limit: 2)
        XCTAssertEqual(first["cursor"] as? Int, 2)
        XCTAssertEqual(first["more"] as? Bool, true)
        let rest = tail.read(process: "SimFixture", after: 2, limit: 2)
        XCTAssertEqual(rest["lines"] as? [String], [line("SimFixture", "step 3")])
        XCTAssertEqual(tail.read(process: "Notes", after: 0, limit: 2)["lines"] as? [String], [])
    }
}
