import Foundation

/// What a host asked the phone to show, as it sealed it.
struct Card: Decodable {
  let v: Int
  let kind: String
  let category: String?
  let collapseId: String
  let thread: String
  let hostKey: String
  let hostName: String
  let agentId: String
  let title: String
  let body: String
  let detail: String?
  let url: String
  let requestId: String?
  let allowOptionId: String?
  let rejectOptionId: String?
  let at: Double
  let expiresAt: Double

  static let version = 1
  /// The category whose cards carry Reject and Allow.
  static let answerCategory = "permission"

  var answerable: Bool {
    kind == "permission" && requestId != nil && allowOptionId != nil && rejectOptionId != nil
  }

  var categoryIdentifier: String {
    answerable && category == Card.answerCategory ? Card.answerCategory : ""
  }

  /// Nil when the host sealed a version this app does not know, or something that is not a card from `host`.
  static func parse(_ plaintext: String, host: String) -> Card? {
    guard let card = try? JSONDecoder().decode(Card.self, from: Data(plaintext.utf8)) else { return nil }
    return card.v == version && card.hostKey == host ? card : nil
  }

  /// What the app reads back from a shown card: to answer it, open its chat, or take it away.
  var userInfo: [String: String] {
    var info = ["host": hostKey, "hostName": hostName, "agent": agentId, "kind": kind, "url": url]
    info["request"] = requestId
    info["allow"] = allowOptionId
    info["reject"] = rejectOptionId
    return info
  }
}
