import ExpoModulesCore
import UserNotifications

final class BadKeyException: Exception {
  override var reason: String { "a notification key is 64 lowercase hex characters" }
}

public class NotifyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SikemuxNotify")

    OnCreate {
      UNUserNotificationCenter.current().setNotificationCategories([Self.answers])
    }

    Function("setPhone") { (phone: String) in
      Keys().phone = phone
    }

    Function("key") { (host: String) -> [String: Any]? in
      Keys().get(host: host).map { ["keyId": Double($0.keyId), "key": $0.key.map { String(format: "%02x", $0) }.joined()] }
    }

    Function("setKey") { (host: String, keyId: Double, key: String) in
      guard let id = UInt32(exactly: keyId), let bytes = Self.unhex(key) else { throw BadKeyException() }
      Keys().put(host: host, keyId: id, key: bytes)
    }

    Function("removeKey") { (host: String) in
      Keys().remove(host: host)
    }

    Function("removeAll") {
      Keys().clear()
      UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    AsyncFunction("shown") { () async -> [[String: String]] in
      await DeliveredCards.shown()
    }

    Function("dismiss") { (tag: String) in
      DeliveredCards.remove(tag)
    }

    Function("settle") { (tag: String, outcome: String) in
      if outcome != "failed" { DeliveredCards.remove(tag) }
    }

    Function("apnsEnvironment") { () -> String in
      Self.apnsEnvironment()
    }
  }

  /// Reject and Allow open the app, which answers over its own connection to the host; iOS gives an
  /// app woken in the background too little time to reach one. Allow asks for the phone's lock first.
  private static let answers = UNNotificationCategory(
    identifier: Card.answerCategory,
    actions: [
      UNNotificationAction(identifier: "reject", title: "Reject", options: [.foreground, .destructive]),
      UNNotificationAction(identifier: "allow", title: "Allow", options: [.foreground, .authenticationRequired]),
    ],
    intentIdentifiers: []
  )

  private static func unhex(_ text: String) -> Data? {
    let digits = Array(text.utf8)
    guard digits.count == 64, digits.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
    return Data(stride(from: 0, to: 64, by: 2).compactMap { UInt8(String(decoding: digits[$0..<$0 + 2], as: UTF8.self), radix: 16) })
  }

  /// Which of Apple's push servers issued this build's token. The simulator and builds signed for
  /// development get theirs from the sandbox; App Store and TestFlight builds carry no profile.
  private static func apnsEnvironment() -> String {
    #if targetEnvironment(simulator)
    return "sandbox"
    #else
    guard
      let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
      let signed = try? String(contentsOf: url, encoding: .isoLatin1)
    else { return "production" }
    guard
      let start = signed.range(of: "<?xml"),
      let end = signed.range(of: "</plist>"),
      let profile = try? PropertyListSerialization.propertyList(
        from: Data(signed[start.lowerBound..<end.upperBound].utf8), format: nil
      ) as? [String: Any],
      let entitlements = profile["Entitlements"] as? [String: Any]
    else { return "sandbox" }
    return entitlements["aps-environment"] as? String == "production" ? "production" : "sandbox"
    #endif
  }
}
