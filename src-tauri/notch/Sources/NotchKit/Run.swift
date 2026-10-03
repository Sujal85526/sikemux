import AppKit

// The island over the MacBook notch: the agents Sikemux's core runs, what
// they need from the person, and a composer to start another. Sikemux starts
// this helper; it reads the same view of the core that paired phones get.

public func runNotch(_ arguments: [String]) -> Never {
    signal(SIGCHLD, SIG_IGN)
    guard let options = Options.parse(arguments) else {
        FileHandle.standardError.write(Data("""
        usage: sikemux-notch --socket PATH --protocol-version N --settings PATH --state-dir DIR
               [--core-binary PATH] [--core-log PATH] [--core-arg ARG]... [--app PATH] [--fonts DIR] [--dev]

        """.utf8))
        exit(2)
    }
    guard Handover.claim(stateDir: options.stateDir, dev: options.dev) else { exit(0) }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate(options: options)
    app.delegate = delegate
    app.run()
    exit(0)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store: NotchStore
    private var panels: Panels?

    init(options: Options) {
        Theme.registerFonts(in: options.fonts)
        store = NotchStore(options: options)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        panels = Panels(store: store)
        store.connect()
    }
}
