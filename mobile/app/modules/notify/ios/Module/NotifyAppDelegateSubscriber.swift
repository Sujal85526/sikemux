import ExpoModulesCore

/// Takes a card away when its host sends a clear, which arrives as a background push that wakes the app.
public class NotifyAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    guard userInfo["t"] as? String == "clear", let tag = userInfo["c"] as? String else {
      completionHandler(.noData)
      return
    }
    DeliveredCards.remove(tag) { completionHandler(.newData) }
  }
}
