import Foundation

public struct Frame: Equatable, Sendable {
    public let x, y, width, height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        (self.x, self.y, self.width, self.height) = (x, y, width, height)
    }

    public var center: Point { Point(x: x + width / 2, y: y + height / 2) }

    func contains(_ point: Point) -> Bool {
        point.x >= x && point.y >= y && point.x <= x + width && point.y <= y + height
    }
}

/// Finds one element in an accessibility read by its label or accessibility identifier.
public enum ElementLookup {
    public struct Failure: Error, Equatable, CustomStringConvertible {
        public let description: String
    }

    /// An exact label or identifier wins over a partial one, and more than one equally good match is
    /// an error, so a tap never lands on an element the caller did not mean. An element whose centre
    /// lies outside `screen`, scrolled out of view, cannot be tapped.
    public static func frame(of name: String, in elements: [[String: Any]], screen: Frame? = nil) -> Result<Frame, Failure> {
        var offscreen = false
        let named = elements.compactMap { element -> (label: String, frame: Frame, exact: Bool)? in
            guard let frame = bounds(of: element), frame.width > 0, frame.height > 0 else { return nil }
            if let screen, !screen.contains(frame.center) {
                if matches(element, name) { offscreen = true }
                return nil
            }
            let label = element["AXLabel"] as? String ?? ""
            let identifier = element["AXUniqueId"] as? String ?? ""
            if label == name || identifier == name { return (label.isEmpty ? identifier : label, frame, true) }
            if label.localizedCaseInsensitiveContains(name) { return (label, frame, false) }
            return nil
        }
        let exact = named.filter(\.exact)
        let candidates = exact.isEmpty ? named : exact
        switch candidates.count {
        case 0 where offscreen:
            return .failure(Failure(description: "\"\(name)\" is off the screen; scroll it into view, then tap it"))
        case 0:
            return .failure(Failure(description: "no element on screen is labelled \"\(name)\"; it may be scrolled out of view, so scroll and read the screen again"))
        case 1:
            return .success(candidates[0].frame)
        default:
            let listed = candidates.prefix(5).map { "\"\($0.label)\" at (\(Int($0.frame.center.x)), \(Int($0.frame.center.y)))" }
            return .failure(Failure(description: "\(candidates.count) elements match \"\(name)\": \(listed.joined(separator: ", ")); tap one by its coordinates"))
        }
    }

    /// The screen as the frontmost app is laid out on it, which is wider than tall when the
    /// device is turned on its side.
    public static func screen(of elements: [[String: Any]]) -> Frame? {
        elements.first { $0["type"] as? String == "Application" }.flatMap { bounds(of: $0) }
    }

    private static func matches(_ element: [String: Any], _ name: String) -> Bool {
        let label = element["AXLabel"] as? String ?? ""
        return label == name || element["AXUniqueId"] as? String == name || label.localizedCaseInsensitiveContains(name)
    }

    private static func bounds(of element: [String: Any]) -> Frame? {
        guard let frame = element["frame"] as? [String: Any],
            let x = (frame["x"] as? NSNumber)?.doubleValue,
            let y = (frame["y"] as? NSNumber)?.doubleValue,
            let width = (frame["width"] as? NSNumber)?.doubleValue,
            let height = (frame["height"] as? NSNumber)?.doubleValue
        else { return nil }
        return Frame(x: x, y: y, width: width, height: height)
    }
}
