/// A side of the screen. iOS reads a touch that starts at one as a system gesture: up from the bottom
/// goes home, down from the top opens Notification Center, and in from the left goes back.
public enum ScreenEdge: Equatable, Sendable {
    case top, left, bottom, right

    /// How close to a side, in points, a touch counts as starting there. A finger on a trackpad
    /// cannot land on the outermost point, so this is wider than the system's own margin.
    public static let reach = 10.0

    /// The side `point` starts at on a screen `width` by `height` points, if any.
    public static func of(_ point: Point, width: Double, height: Double) -> ScreenEdge? {
        if point.y >= height - reach { return .bottom }
        if point.y <= reach { return .top }
        if point.x <= reach { return .left }
        if point.x >= width - reach { return .right }
        return nil
    }
}
