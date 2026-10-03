import AppKit
import Observation

/// What every island shows: the agents in the core's device view, and the
/// actions that reach back to the core.
@Observable
final class NotchStore {
    private(set) var view = DeviceView.empty
    private(set) var agents: [AgentItem] = []
    private(set) var settings: NotchSettings
    /// When each agent entered the state it is in, for the times beside it.
    private(set) var since: [String: Date] = [:]
    var error: String?

    @ObservationIgnored let options: Options
    @ObservationIgnored private var link: CoreLink?
    @ObservationIgnored private var startedCore = false
    @ObservationIgnored private var seenAttentions: Set<String> = []
    @ObservationIgnored private var heard = false
    @ObservationIgnored var onPeek: ((Peek) -> Void)?

    enum Peek {
        case ask(String)
        case done(String)
    }

    init(options: Options) {
        self.options = options
        settings = NotchSettings.load(options.settings)
    }

    func reloadSettings() {
        let fresh = NotchSettings.load(options.settings)
        if fresh != settings { settings = fresh }
    }

    // MARK: Connection

    func connect() {
        let link = CoreLink(socket: options.socket, protocolVersion: options.protocolVersion)
        link.onReady = { [weak self, weak link] in
            link?.request(["op": "watchView"])
            self?.error = nil
        }
        link.onEvent = { [weak self] event in self?.receive(event) }
        link.onClose = { [weak self] _ in
            guard let self else { return }
            self.link = nil
            self.apply(.empty)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.connect() }
        }
        if link.connect() {
            self.link = link
            return
        }
        if !startedCore {
            startedCore = true
            CoreStarter.start(options)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.connect() }
    }

    private func receive(_ event: [String: Any]) {
        guard event["kind"] as? String == "deviceView", let raw = event["view"],
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let view = try? JSONDecoder().decode(DeviceView.self, from: data)
        else { return }
        apply(view)
    }

    func apply(_ view: DeviceView) {
        let before = Dictionary(uniqueKeysWithValues: agents.map { ($0.id, $0) })
        let fresh = view.agents
        let now = Date()
        var since: [String: Date] = [:]
        for agent in fresh {
            let unchanged = before[agent.id]?.state == agent.state
            since[agent.id] = unchanged ? self.since[agent.id] ?? now : now
        }
        for attention in view.attentions {
            since[attention.agentId] = Date(timeIntervalSince1970: attention.at / 1000)
        }
        let newAsks = view.attentions.filter { !seenAttentions.contains($0.id) }
        let finished = fresh.filter { $0.state == .done && before[$0.id].map { $0.state != .done } ?? false }
        seenAttentions = Set(view.attentions.map(\.id))
        self.view = view
        agents = fresh
        self.since = since
        defer { heard = true }
        guard heard else { return }
        if let ask = newAsks.last {
            if settings.sound { NSSound(named: "Tink")?.play() }
            if settings.peeks != .never { onPeek?(.ask(ask.agentId)) }
        } else if let done = finished.last, settings.peeks == .all {
            onPeek?(.done(done.id))
        }
    }

    // MARK: Actions

    func answer(_ ask: Ask, agentId: String, optionId: String?) {
        link?.request([
            "op": "acpPermissionReply",
            "agentId": agentId,
            "requestId": ask.attentionId,
            "optionId": optionId as Any,
        ]) { [weak self] result in
            if case .failure(let error) = result { self?.error = error.message }
        }
    }

    /// Shows the agent in Sikemux, opening the app first when its window is closed.
    func focus(_ agentId: String) {
        guard let link else { return }
        link.request(["op": "focusAgent", "agentId": agentId]) { [weak self] result in
            guard case .failure = result, let self else { return }
            self.openApp()
            self.retryFocus(agentId, attempts: 30)
        }
    }

    private func retryFocus(_ agentId: String, attempts: Int) {
        guard attempts > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.link?.request(["op": "focusAgent", "agentId": agentId]) { result in
                if case .failure = result { self?.retryFocus(agentId, attempts: attempts - 1) }
            }
        }
    }

    func openApp() {
        guard let app = options.app, app.hasSuffix(".app") else { return }
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: app), configuration: .init())
    }

    struct Launch {
        let provider: String
        let project: Project
        let yolo: Bool
        let model: String?
        let effort: String?
        let text: String
        let paths: [String]
    }

    func launcher(for provider: String) -> Launcher? {
        view.workspace.launchers.first { $0.provider == provider }
    }

    var providers: [String] {
        var seen: [String] = []
        for launcher in view.workspace.launchers where !seen.contains(launcher.provider) {
            seen.append(launcher.provider)
        }
        return seen
    }

    func start(_ launch: Launch, done: @escaping (Bool) -> Void) {
        guard let link, let launcher = launcher(for: launch.provider) else {
            error = "Open Sikemux once so the notch knows which agents it can start"
            done(false)
            return
        }
        var request: [String: Any] = [
            "op": "startChat",
            "launcher": launcher.id,
            "project": launch.project.id,
            "permissionMode": launch.yolo ? "bypass" : "workspace-write",
        ]
        if let model = launch.model { request["model"] = model }
        if let effort = launch.effort { request["effort"] = effort }
        link.request(request) { [weak self] result in
            switch result {
            case .success(let response):
                guard let agentId = response["agentId"] as? String else { return done(false) }
                if !launch.text.isEmpty || !launch.paths.isEmpty {
                    self?.prompt(agentId, text: launch.text, paths: launch.paths)
                }
                done(true)
            case .failure(let error):
                self?.error = error.message
                done(false)
            }
        }
    }

    /// Hands files to an agent: into the turn it is running, or as its next prompt.
    func send(_ paths: [String], to agent: AgentItem) {
        let text = paths.map { ($0 as NSString).lastPathComponent }.joined(separator: ", ")
        if agent.state == .working {
            link?.request(["op": "acpSteer", "agentId": agent.id, "text": text, "paths": paths, "context": [Any]()]) {
                [weak self] result in
                if case .success(let response) = result, response["outcome"] as? String == "promptRequired" {
                    self?.prompt(agent.id, text: text, paths: paths)
                }
            }
        } else {
            prompt(agent.id, text: text, paths: paths)
        }
    }

    private func prompt(_ agentId: String, text: String, paths: [String]) {
        link?.request(["op": "acpPrompt", "agentId": agentId, "text": text, "paths": paths, "context": [Any]()]) {
            [weak self] result in
            if case .failure(let error) = result { self?.error = error.message }
        }
    }

    /// The project shown first when starting an agent: the one most of the running agents are in.
    var defaultProject: Project? {
        let projects = view.workspace.projects
        let counts = Dictionary(grouping: agents, by: \.project).mapValues(\.count)
        return projects.max { (counts[$0.name] ?? 0) < (counts[$1.name] ?? 0) } ?? projects.first
    }

    var rollup: (state: AgentState, count: Int)? {
        for state in [AgentState.blocked, .working, .done] {
            let count = agents.filter { $0.state == state }.count
            if count > 0 { return (state, count) }
        }
        return nil
    }
}
