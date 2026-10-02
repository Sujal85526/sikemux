import Foundation

public struct Frame: Equatable, Sendable {
    public let x, y, width, height: Double

    public var center: Point { Point(x: x + width / 2, y: y + height / 2) }
}

/// Finds one element in an accessibility read by its label or accessibility identifier.
public enum ElementLookup {
    public struct Failure: Error, Equatable, CustomStringConvertible {
        public let description: String
    }

    /// An exact label or identifier wins over a partial one, and more than one equally good match is
    /// an error, so a tap never lands on an element the caller did not mean.
    public static func frame(of name: String, in elements: [[String: Any]]) -> Result<Frame, Failure> {
        let named = elements.compactMap { element -> (label: String, frame: Frame, exact: Bool)? in
            guard let frame = frame(element), frame.width > 0, frame.height > 0 else { return nil }
            let label = element["AXLabel"] as? String ?? ""
            let identifier = element["AXUniqueId"] as? String ?? ""
            if label == name || identifier == name { return (label.isEmpty ? identifier : label, frame, true) }
            if label.localizedCaseInsensitiveContains(name) { return (label, frame, false) }
            return nil
        }
        let exact = named.filter(\.exact)
        let matches = exact.isEmpty ? named : exact
        switch matches.count {
        case 0:
            return .failure(Failure(description: "no element is labelled \"\(name)\""))
        case 1:
            return .success(matches[0].frame)
        default:
            let listed = matches.prefix(5).map { "\"\($0.label)\" at (\(Int($0.frame.center.x)), \(Int($0.frame.center.y)))" }
            return .failure(Failure(description: "\(matches.count) elements match \"\(name)\": \(listed.joined(separator: ", ")); tap one by its coordinates"))
        }
    }

    private static func frame(_ element: [String: Any]) -> Frame? {
        guard let frame = element["frame"] as? [String: Any],
            let x = (frame["x"] as? NSNumber)?.doubleValue,
            let y = (frame["y"] as? NSNumber)?.doubleValue,
            let width = (frame["width"] as? NSNumber)?.doubleValue,
            let height = (frame["height"] as? NSNumber)?.doubleValue
        else { return nil }
        return Frame(x: x, y: y, width: width, height: height)
    }
}
