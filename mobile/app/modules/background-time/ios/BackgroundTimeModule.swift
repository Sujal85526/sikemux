import ExpoModulesCore
import UIKit

public class BackgroundTimeModule: Module {
  private var held: [Int: UIBackgroundTaskIdentifier] = [:]
  private var next = 0

  public func definition() -> ModuleDefinition {
    Name("SikemuxBackgroundTime")

    // iOS ends the time itself when it runs out; the work then carries on only if the app is brought back.
    AsyncFunction("begin") { (name: String) -> Int in
      self.next += 1
      let id = self.next
      self.held[id] = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
        self?.end(id)
      }
      return id
    }.runOnQueue(.main)

    AsyncFunction("end") { (id: Int) in
      self.end(id)
    }.runOnQueue(.main)
  }

  private func end(_ id: Int) {
    guard let task = held.removeValue(forKey: id), task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
  }
}
