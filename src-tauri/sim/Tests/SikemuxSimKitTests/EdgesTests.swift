import XCTest

@testable import SikemuxSimKit

final class EdgesTests: XCTestCase {
    func testATouchNearASideStartsAtThatEdge() {
        XCTAssertEqual(ScreenEdge.of(Point(x: 200, y: 870), width: 402, height: 874), .bottom)
        XCTAssertEqual(ScreenEdge.of(Point(x: 200, y: 3), width: 402, height: 874), .top)
        XCTAssertEqual(ScreenEdge.of(Point(x: 6, y: 400), width: 402, height: 874), .left)
        XCTAssertEqual(ScreenEdge.of(Point(x: 398, y: 400), width: 402, height: 874), .right)
    }

    func testATouchInsideTheScreenIsOrdinary() {
        XCTAssertNil(ScreenEdge.of(Point(x: 200, y: 400), width: 402, height: 874))
        XCTAssertNil(ScreenEdge.of(Point(x: 11, y: 11), width: 402, height: 874))
    }
}
