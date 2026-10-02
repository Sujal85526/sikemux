import XCTest

@testable import SikemuxSimKit

final class KeyboardTests: XCTestCase {
    func testLettersDigitsAndShiftedSymbols() throws {
        let strokes = try Keyboard.strokes(for: "aZ0!?\n").get()
        XCTAssertEqual(strokes, [
            KeyStroke(keyCode: 4, shifted: false),
            KeyStroke(keyCode: 29, shifted: true),
            KeyStroke(keyCode: 39, shifted: false),
            KeyStroke(keyCode: 30, shifted: true),
            KeyStroke(keyCode: 56, shifted: true),
            KeyStroke(keyCode: 40, shifted: false),
        ])
    }

    func testEveryPrintableAsciiCharacterIsTypable() {
        let printable = String((32...126).map { Character(UnicodeScalar(UInt8($0))) })
        XCTAssertEqual(try Keyboard.strokes(for: printable).get().count, printable.count)
    }

    func testNamesEachCharacterItCannotTypeOnce() {
        XCTAssertEqual(
            Keyboard.strokes(for: "héllo é ✓"),
            .failure(UntypableCharacters(characters: ["é", "✓"])))
    }
}
