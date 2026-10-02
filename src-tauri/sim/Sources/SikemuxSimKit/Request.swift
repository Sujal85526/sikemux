import Foundation

public struct Point: Decodable, Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum Button: String, Decodable, CaseIterable, Sendable {
    case home, lock, side, siri, volumeUp, volumeDown, applePay
}

public enum TouchPhase: String, Sendable {
    case down, move, up
}

public enum ImageFormat: String, Sendable {
    case png, jpeg
}

public enum Command: Equatable, Sendable {
    case devices
    case boot(udid: String)
    case shutdown(udid: String)
    /// `pointSize` captures one pixel per point, a third of a 3x screen, which is plenty to read it.
    case screenshot(udid: String, path: String, format: ImageFormat, pointSize: Bool)
    case tap(udid: String, at: Point, duration: Double?)
    /// One step of a finger the person moves live: down, any number of moves, then up.
    case touch(udid: String, phase: TouchPhase, at: Point)
    case swipe(udid: String, from: Point, to: Point, duration: Double)
    case type(udid: String, text: String)
    case button(udid: String, button: Button)
    case state(udid: String)
    case tapElement(udid: String, label: String)
    case launch(udid: String, bundleId: String, arguments: [String], environment: [String: String])
    case terminate(udid: String, bundleId: String)
    case install(udid: String, path: String)
    case openUrl(udid: String, url: URL)
    /// A live MJPEG view of the screen at a local address, shared by everyone who opens it.
    case stream(udid: String)
    case stopStream(udid: String)

    public var udid: String? {
        switch self {
        case .devices: nil
        case let .boot(udid), let .shutdown(udid), let .state(udid), let .stream(udid), let .stopStream(udid): udid
        case let .screenshot(udid, _, _, _), let .type(udid, _), let .button(udid, _), let .tapElement(udid, _),
            let .terminate(udid, _), let .install(udid, _), let .openUrl(udid, _):
            udid
        case let .tap(udid, _, _), let .touch(udid, _, _), let .swipe(udid, _, _, _), let .launch(udid, _, _, _): udid
        }
    }
}

public struct RequestError: Error, Equatable, CustomStringConvertible {
    /// The request's id when it could be read, so the reply still reaches whoever is waiting on it.
    public let id: Int?
    public let description: String
}

public struct Request: Equatable, Sendable {
    public let id: Int
    public let command: Command

    /// One line from stdin: `{"id": 1, "type": "tap", "udid": "…", "x": 10, "y": 20}`.
    public static func parse(_ line: Data) throws(RequestError) -> Request {
        guard let object = try? JSONSerialization.jsonObject(with: line), let fields = object as? [String: Any] else {
            throw RequestError(id: nil, description: "request is not a JSON object")
        }
        guard let id = fields["id"] as? Int else {
            throw RequestError(id: nil, description: "request has no integer id")
        }
        do {
            return Request(id: id, command: try command(from: Fields(fields)))
        } catch let error as FieldError {
            throw RequestError(id: id, description: error.description)
        } catch {
            throw RequestError(id: id, description: "\(error)")
        }
    }

    private static func command(from fields: Fields) throws -> Command {
        let type: String = try fields.required("type")
        switch type {
        case "devices":
            return .devices
        case "boot":
            return .boot(udid: try fields.required("udid"))
        case "shutdown":
            return .shutdown(udid: try fields.required("udid"))
        case "screenshot":
            let format: String = try fields.optional("format") ?? "png"
            guard let imageFormat = ImageFormat(rawValue: format) else { throw FieldError("format must be png or jpeg") }
            return .screenshot(
                udid: try fields.required("udid"), path: try fields.required("path"),
                format: imageFormat, pointSize: try fields.optional("pointSize") ?? false)
        case "tap":
            return .tap(udid: try fields.required("udid"), at: try fields.point("x", "y"), duration: try fields.optional("duration"))
        case "touch":
            let phase: String = try fields.required("phase")
            guard let touchPhase = TouchPhase(rawValue: phase) else { throw FieldError("phase must be down, move or up") }
            return .touch(udid: try fields.required("udid"), phase: touchPhase, at: try fields.point("x", "y"))
        case "swipe":
            return .swipe(
                udid: try fields.required("udid"),
                from: try fields.point("fromX", "fromY"),
                to: try fields.point("toX", "toY"),
                duration: try fields.optional("duration") ?? 0.3)
        case "type":
            return .type(udid: try fields.required("udid"), text: try fields.required("text"))
        case "button":
            let name: String = try fields.required("button")
            guard let button = Button(rawValue: name) else {
                throw FieldError("unknown button \"\(name)\"; expected one of \(Button.allCases.map(\.rawValue).joined(separator: ", "))")
            }
            return .button(udid: try fields.required("udid"), button: button)
        case "state":
            return .state(udid: try fields.required("udid"))
        case "tapElement":
            return .tapElement(udid: try fields.required("udid"), label: try fields.required("label"))
        case "launch":
            return .launch(
                udid: try fields.required("udid"),
                bundleId: try fields.required("bundleId"),
                arguments: try fields.optional("arguments") ?? [],
                environment: try fields.optional("environment") ?? [:])
        case "terminate":
            return .terminate(udid: try fields.required("udid"), bundleId: try fields.required("bundleId"))
        case "install":
            return .install(udid: try fields.required("udid"), path: try fields.required("path"))
        case "openUrl":
            let text: String = try fields.required("url")
            guard let url = URL(string: text), url.scheme != nil else { throw FieldError("\"\(text)\" is not a URL") }
            return .openUrl(udid: try fields.required("udid"), url: url)
        case "stream":
            return .stream(udid: try fields.required("udid"))
        case "stopStream":
            return .stopStream(udid: try fields.required("udid"))
        default:
            throw FieldError("unknown request type \"\(type)\"")
        }
    }
}

private struct FieldError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

private struct Fields {
    let values: [String: Any]
    init(_ values: [String: Any]) { self.values = values }

    func optional<T>(_ key: String) throws -> T? {
        guard let value = values[key], !(value is NSNull) else { return nil }
        if let number = value as? NSNumber {
            let isBoolean = CFGetTypeID(number) == CFBooleanGetTypeID()
            if T.self == Double.self, !isBoolean { return number.doubleValue as? T }
            if T.self == Bool.self, isBoolean { return number.boolValue as? T }
            throw FieldError("\"\(key)\" has the wrong type")
        }
        guard let typed = value as? T else { throw FieldError("\"\(key)\" has the wrong type") }
        return typed
    }

    func required<T>(_ key: String) throws -> T {
        guard let value: T = try optional(key) else { throw FieldError("missing \"\(key)\"") }
        return value
    }

    func point(_ x: String, _ y: String) throws -> Point {
        let px: Double = try required(x)
        let py: Double = try required(y)
        guard px.isFinite, py.isFinite, px >= 0, py >= 0 else { throw FieldError("\"\(x)\" and \"\(y)\" must be points on the screen") }
        return Point(x: px, y: py)
    }
}
