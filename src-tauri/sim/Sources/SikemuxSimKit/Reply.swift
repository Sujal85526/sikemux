import Foundation

/// Every line the helper writes is one JSON object. Replies carry the request's id; events do not.
public enum Reply {
    public static func success(id: Int, _ result: [String: Any] = [:]) -> Data {
        line(["id": id, "ok": true, "result": result])
    }

    public static func failure(id: Int?, _ message: String) -> Data {
        line(["id": id ?? NSNull(), "ok": false, "error": message])
    }

    public static func event(_ type: String, _ fields: [String: Any] = [:]) -> Data {
        line(fields.merging(["type": type]) { _, type in type })
    }

    private static func line(_ object: [String: Any]) -> Data {
        var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]))
            ?? Data(#"{"ok":false,"error":"reply could not be encoded"}"#.utf8)
        data.append(0x0A)
        return data
    }
}
