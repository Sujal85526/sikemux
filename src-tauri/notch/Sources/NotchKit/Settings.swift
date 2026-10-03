import Foundation

/// The Notch section of Sikemux's settings, which the app writes to a file
/// beside its core and the helper rereads whenever it changes.
struct NotchSettings: Decodable, Equatable {
    enum Displays: String, Decodable { case all, builtIn, pointer }
    enum OpenWith: String, Decodable { case hover, click }
    enum FullScreen: String, Decodable { case needsYou, always, never }
    enum Peeks: String, Decodable { case all, needsYou, never }

    var displays: Displays = .all
    var openWith: OpenWith = .hover
    var fullScreen: FullScreen = .needsYou
    var peeks: Peeks = .all
    var answerInNotch = true
    var sound = true
    var haptics = true
    /// Only a stable or nightly build reads this: whether it steps aside while Sikemux Dev runs.
    var yieldToDev = true

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = NotchSettings()
        displays = (try? container.decode(Displays.self, forKey: .displays)) ?? defaults.displays
        openWith = (try? container.decode(OpenWith.self, forKey: .openWith)) ?? defaults.openWith
        fullScreen = (try? container.decode(FullScreen.self, forKey: .fullScreen)) ?? defaults.fullScreen
        peeks = (try? container.decode(Peeks.self, forKey: .peeks)) ?? defaults.peeks
        answerInNotch = (try? container.decode(Bool.self, forKey: .answerInNotch)) ?? defaults.answerInNotch
        sound = (try? container.decode(Bool.self, forKey: .sound)) ?? defaults.sound
        haptics = (try? container.decode(Bool.self, forKey: .haptics)) ?? defaults.haptics
        yieldToDev = (try? container.decode(Bool.self, forKey: .yieldToDev)) ?? defaults.yieldToDev
    }

    private enum CodingKeys: String, CodingKey {
        case displays, openWith, fullScreen, peeks, answerInNotch, sound, haptics, yieldToDev
    }

    static func load(_ path: String) -> NotchSettings {
        guard let data = FileManager.default.contents(atPath: path),
              let settings = try? JSONDecoder().decode(NotchSettings.self, from: data)
        else { return NotchSettings() }
        return settings
    }
}

/// Calls back on the main queue whenever the settings file is written or replaced.
final class SettingsWatcher {
    private let path: String
    private var source: DispatchSourceFileSystemObject?
    private let changed: () -> Void

    init(path: String, changed: @escaping () -> Void) {
        self.path = path
        self.changed = changed
        watch()
    }

    private func watch() {
        let directory = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let descriptor = open(directory, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write], queue: .main)
        source.setEventHandler { [weak self] in self?.changed() }
        source.setCancelHandler { Darwin.close(descriptor) }
        source.resume()
        self.source = source
    }
}
