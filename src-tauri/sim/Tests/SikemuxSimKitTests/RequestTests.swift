import Foundation
import XCTest

@testable import SikemuxSimKit

final class RequestTests: XCTestCase {
    private func parse(_ json: String) throws(RequestError) -> Request {
        try Request.parse(Data(json.utf8))
    }

    private func failure(_ json: String) -> RequestError? {
        do {
            _ = try parse(json)
            return nil
        } catch {
            return error
        }
    }

    func testParsesEachCommand() throws {
        XCTAssertEqual(try parse(#"{"id":1,"type":"devices"}"#).command, .devices)
        XCTAssertEqual(try parse(#"{"id":2,"type":"boot","udid":"A"}"#).command, .boot(udid: "A"))
        XCTAssertEqual(try parse(#"{"id":2,"type":"stream","udid":"A"}"#).command, .stream(udid: "A"))
        XCTAssertEqual(
            try parse(#"{"id":2,"type":"touch","udid":"A","phase":"move","x":5,"y":6}"#).command,
            .touch(udid: "A", phase: .move, at: Point(x: 5, y: 6)))
        XCTAssertEqual(failure(#"{"id":3,"type":"touch","udid":"A","phase":"hover","x":5,"y":6}"#)?.description, "phase must be down, move or up")
        XCTAssertEqual(try parse(#"{"id":2,"type":"stopStream","udid":"A"}"#).command, .stopStream(udid: "A"))
        XCTAssertEqual(
            try parse(#"{"id":2,"type":"chrome","udid":"A","chromePath":"/tmp/c.png","maskPath":"/tmp/m.png"}"#).command,
            .chrome(udid: "A", chromePath: "/tmp/c.png", maskPath: "/tmp/m.png"))
        XCTAssertEqual(
            try parse(#"{"id":2,"type":"screenshot","udid":"A","path":"/tmp/a.png"}"#).command,
            .screenshot(udid: "A", path: "/tmp/a.png", format: .png, pointSize: false))
        XCTAssertEqual(
            try parse(#"{"id":2,"type":"screenshot","udid":"A","path":"/tmp/a.jpg","format":"jpeg","pointSize":true}"#).command,
            .screenshot(udid: "A", path: "/tmp/a.jpg", format: .jpeg, pointSize: true))
        XCTAssertEqual(
            try parse(#"{"id":3,"type":"tap","udid":"A","x":10,"y":20.5}"#).command,
            .tap(udid: "A", at: Point(x: 10, y: 20.5), duration: nil))
        XCTAssertEqual(
            try parse(#"{"id":4,"type":"tap","udid":"A","x":1,"y":2,"duration":0.8}"#).command,
            .tap(udid: "A", at: Point(x: 1, y: 2), duration: 0.8))
        XCTAssertEqual(
            try parse(#"{"id":5,"type":"swipe","udid":"A","fromX":1,"fromY":2,"toX":3,"toY":4}"#).command,
            .swipe(udid: "A", from: Point(x: 1, y: 2), to: Point(x: 3, y: 4), duration: 0.3))
        XCTAssertEqual(try parse(#"{"id":6,"type":"button","udid":"A","button":"home"}"#).command, .button(udid: "A", button: .home))
        XCTAssertEqual(try parse(#"{"id":7,"type":"tapElement","udid":"A","label":"Settings"}"#).command, .tapElement(udid: "A", label: "Settings"))
        XCTAssertEqual(
            try parse(#"{"id":8,"type":"launch","udid":"A","bundleId":"com.example","arguments":["-x"],"environment":{"K":"V"}}"#).command,
            .launch(udid: "A", bundleId: "com.example", arguments: ["-x"], environment: ["K": "V"]))
        XCTAssertEqual(
            try parse(#"{"id":9,"type":"openUrl","udid":"A","url":"https://example.com/a"}"#).command,
            .openUrl(udid: "A", url: URL(string: "https://example.com/a")!))
    }

    func testKeepsTheIdWhenTheCommandIsWrong() {
        XCTAssertEqual(failure(#"{"id":4,"type":"tap","udid":"A","x":1}"#), RequestError(id: 4, description: #"missing "y""#))
        XCTAssertEqual(failure(#"{"id":5,"type":"warp"}"#), RequestError(id: 5, description: #"unknown request type "warp""#))
        XCTAssertEqual(failure(#"{"id":6,"type":"tap","udid":"A","x":"1","y":2}"#), RequestError(id: 6, description: #""x" has the wrong type"#))
        XCTAssertEqual(failure(#"{"id":7,"type":"tap","udid":"A","x":-1,"y":2}"#)?.id, 7)
        XCTAssertEqual(failure(#"{"id":8,"type":"openUrl","udid":"A","url":"not a url"}"#)?.id, 8)
        XCTAssertEqual(
            failure(#"{"id":9,"type":"screenshot","udid":"A","path":"/tmp/a","format":"gif"}"#)?.description,
            "format must be png or jpeg")
        XCTAssertTrue(failure(#"{"id":9,"type":"button","udid":"A","button":"turbo"}"#)?.description.contains("home") ?? false)
    }

    func testRejectsLinesWithoutAnId() {
        XCTAssertEqual(failure("nonsense"), RequestError(id: nil, description: "request is not a JSON object"))
        XCTAssertEqual(failure(#"{"type":"devices"}"#), RequestError(id: nil, description: "request has no integer id"))
    }

    func testABooleanIsNotACoordinate() {
        XCTAssertEqual(failure(#"{"id":1,"type":"tap","udid":"A","x":true,"y":2}"#)?.description, #""x" has the wrong type"#)
    }

    func testRepliesAreSingleLines() throws {
        let success = Reply.success(id: 3, ["path": "/tmp/a b.png"])
        XCTAssertEqual(String(decoding: success, as: UTF8.self), #"{"id":3,"ok":true,"result":{"path":"/tmp/a b.png"}}"# + "\n")
        let failure = Reply.failure(id: nil, "bad\nline")
        XCTAssertEqual(failure.filter { $0 == 0x0A }.count, 1)
        XCTAssertEqual(String(decoding: Reply.event("ready", ["version": "1"]), as: UTF8.self), #"{"type":"ready","version":"1"}"# + "\n")
    }
}
