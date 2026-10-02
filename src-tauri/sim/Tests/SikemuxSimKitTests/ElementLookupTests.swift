import XCTest

@testable import SikemuxSimKit

final class ElementLookupTests: XCTestCase {
    private func element(_ label: String, id: String = "", x: Double, y: Double = 0, width: Double = 10, height: Double = 10) -> [String: Any] {
        ["AXLabel": label, "AXUniqueId": id, "frame": ["x": x, "y": y, "width": width, "height": height]]
    }

    func testTapsTheCentreOfAnExactMatch() {
        let elements = [element("Settings", x: 300, y: 389, width: 68, height: 90), element("Safari", x: 0)]
        XCTAssertEqual(try ElementLookup.frame(of: "Settings", in: elements).get().center, Point(x: 334, y: 434))
    }

    func testAnExactLabelBeatsALongerOneThatContainsIt() {
        let elements = [element("General Settings", x: 0), element("General", x: 100)]
        XCTAssertEqual(try ElementLookup.frame(of: "General", in: elements).get().x, 100)
    }

    func testMatchesTheAccessibilityIdentifier() {
        let elements = [element("Sign in", id: "login.submit", x: 40)]
        XCTAssertEqual(try ElementLookup.frame(of: "login.submit", in: elements).get().x, 40)
    }

    func testFallsBackToAPartialCaseInsensitiveMatch() {
        XCTAssertEqual(try ElementLookup.frame(of: "general", in: [element("General Settings", x: 7)]).get().x, 7)
    }

    func testSaysWhichElementsMadeItAmbiguous() {
        let result = ElementLookup.frame(of: "Calendar", in: [element("Calendar", x: 0), element("Calendar", x: 100)])
        guard case let .failure(failure) = result else { return XCTFail("expected ambiguity") }
        XCTAssertTrue(failure.description.hasPrefix("2 elements match \"Calendar\""), failure.description)
    }

    func testIgnoresElementsWithNoSizeOnScreen() {
        let result = ElementLookup.frame(of: "Hidden", in: [element("Hidden", x: 0, width: 0, height: 0)])
        XCTAssertEqual(result, .failure(ElementLookup.Failure(description: "no element is labelled \"Hidden\"")))
    }
}
