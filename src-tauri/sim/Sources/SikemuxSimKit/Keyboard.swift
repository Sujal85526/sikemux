/// A key on a US keyboard, as the USB HID usage code the simulator's keyboard reads.
public struct KeyStroke: Equatable, Sendable {
    public static let shift: UInt32 = 225

    public let keyCode: UInt32
    public let shifted: Bool
}

public enum Keyboard {
    private static let plain: [Character: UInt32] = {
        var map: [Character: UInt32] = [:]
        for (offset, letter) in "abcdefghijklmnopqrstuvwxyz".enumerated() { map[letter] = 4 + UInt32(offset) }
        for (offset, digit) in "1234567890".enumerated() { map[digit] = 30 + UInt32(offset) }
        let others: [Character: UInt32] = [
            "\n": 40, "\u{8}": 42, "\t": 43, " ": 44, "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49,
            ";": 51, "'": 52, "`": 53, ",": 54, ".": 55, "/": 56,
        ]
        return map.merging(others) { $1 }
    }()

    private static let shifted: [Character: UInt32] = {
        var map: [Character: UInt32] = [:]
        for (offset, letter) in "ABCDEFGHIJKLMNOPQRSTUVWXYZ".enumerated() { map[letter] = 4 + UInt32(offset) }
        for (offset, symbol) in "!@#$%^&*()".enumerated() { map[symbol] = 30 + UInt32(offset) }
        let others: [Character: UInt32] = [
            "_": 45, "+": 46, "{": 47, "}": 48, "|": 49, ":": 51, "\"": 52, "~": 53, "<": 54, ">": 55, "?": 56,
        ]
        return map.merging(others) { $1 }
    }()

    /// The keys that type `text`, or the characters a US keyboard cannot type.
    public static func strokes(for text: String) -> Result<[KeyStroke], UntypableCharacters> {
        var strokes: [KeyStroke] = []
        var missing: [Character] = []
        for character in text {
            if let code = plain[character] {
                strokes.append(KeyStroke(keyCode: code, shifted: false))
            } else if let code = shifted[character] {
                strokes.append(KeyStroke(keyCode: code, shifted: true))
            } else if !missing.contains(character) {
                missing.append(character)
            }
        }
        return missing.isEmpty ? .success(strokes) : .failure(UntypableCharacters(characters: missing))
    }
}

public struct UntypableCharacters: Error, Equatable, CustomStringConvertible {
    public let characters: [Character]

    public var description: String {
        "the simulator keyboard cannot type \(characters.map { "\"\($0)\"" }.joined(separator: ", "))"
    }
}
