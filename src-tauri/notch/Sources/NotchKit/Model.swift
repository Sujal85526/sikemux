import Foundation

struct DeviceView: Decodable, Equatable {
    let workspace: Workspace
    let chats: [ChatInfo]
    let attentions: [Attention]
    let inbox: Inbox

    static let empty = DeviceView(workspace: Workspace(projects: [], launchers: []), chats: [], attentions: [], inbox: Inbox(items: [], working: 0))
}

struct Workspace: Decodable, Equatable {
    let projects: [Project]
    let launchers: [Launcher]
}

struct Project: Decodable, Equatable, Hashable {
    let id: String
    let name: String
    let path: String
}

struct Launcher: Decodable, Equatable {
    let id: String
    let provider: String
    let label: String
    let permissionMode: String
    let model: ConfigSelect?
    let effort: ConfigSelect?
}

/// What a chat still has going, which the inbox does not say.
struct ChatInfo: Decodable, Equatable {
    let agentId: String
    let subagents: Int
    let tasks: Int
}

struct Attention: Decodable, Equatable {
    let id: String
    let agentId: String
    let choices: PermissionChoices
}

/// A permission request as the core reads it for the island's three buttons.
struct PermissionChoices: Decodable, Equatable {
    let allowOnce: String?
    let allowAlways: String?
    let reject: String?
    let command: String?
    let title: String?
}

/// What waits on the person and what is under way, in the order the core ranks it.
struct Inbox: Decodable, Equatable {
    let items: [InboxItem]
    /// Agents at work now, listed or not.
    let working: Int

    init(items: [InboxItem], working: Int) {
        self.items = items
        self.working = working
    }

    /// An item this build cannot read, such as one in a tier added later, is left out rather than losing the whole view.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([Readable].self, forKey: .items).compactMap(\.item)
        working = try container.decode(Int.self, forKey: .working)
    }

    private enum CodingKeys: String, CodingKey { case items, working }

    private struct Readable: Decodable {
        let item: InboxItem?
        init(from decoder: Decoder) throws { item = try? InboxItem(from: decoder) }
    }
}

struct InboxItem: Decodable, Equatable, Identifiable {
    enum Tier: String, Decodable {
        case needs, review, finished, progress
    }

    enum Kind: String, Decodable {
        case permission, question, input, held, assumption, pullRequest, changes, failed, finished, working
        /// One added after this build; its tier still places it.
        case other

        init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }
    }

    struct Card: Decodable, Equatable {
        let title: String
    }

    let id: String
    let tier: Tier
    let kind: Kind
    let agentId: String?
    /// What the core calls the agent, such as Otter.
    let name: String?
    let cli: String?
    let project: String?
    let title: String?
    /// What is needed or what happened, in the words the app and phones use.
    let what: String
    let detail: String?
    let at: Double
    /// The agent's terminal; none for a chat.
    let session: UInt64?
    let card: Card?
    let requestId: String?
    let questionId: String?
    let url: String?
}

/// The marks beside a row and in the closed island's right wing.
enum Mark: Hashable {
    case needs, working, done, failed
}

/// One group on the closed island's right wing.
enum Rollup: Hashable {
    case mark(Mark)
    case stillRunning
}

/// A permission an agent waits on, with the person's choices.
struct Ask: Equatable {
    let attentionId: String
    /// The command it wants to run, or what the tool call is called when it is not a command.
    let command: String
    let isCommand: Bool
    let allowOnce: String?
    let allowAlways: String?
    let reject: String?

    init(_ attention: Attention) {
        let choices = attention.choices
        attentionId = attention.id
        command = choices.command ?? choices.title ?? "a tool"
        isCommand = choices.command != nil
        allowOnce = choices.allowOnce
        allowAlways = choices.allowAlways
        reject = choices.reject
    }
}

/// A question an agent put to the person or its lead, as the core lists it.
struct AgentQuestion: Decodable, Equatable {
    let id: String
    let text: String
    let choices: [QuestionChoice]
    /// The lead it went to first, once it reached the person.
    let via: String?
    /// That lead passed it on itself rather than leaving it unanswered.
    let passed: Bool

    /// Why it reached the person rather than its lead.
    var why: String? {
        via.map { passed ? "\($0) didn't know" : "\($0) didn't answer" }
    }
}

struct QuestionChoice: Decodable, Equatable {
    let label: String
}

/// One row of the island: an inbox item with what the notch adds to it.
struct Entry: Identifiable, Equatable {
    let item: InboxItem
    let project: String
    /// Subagents, and shells or monitors, its agent still has going.
    let subagents: Int
    let tasks: Int
    let ask: Ask?
    var question: AgentQuestion? = nil

    var id: String { item.id }
    var provider: String { item.cli ?? "" }
    var title: String { item.title ?? item.card?.title ?? item.what }
    var isChat: Bool { item.agentId != nil && item.session == nil && item.cli != nil }
    var since: Date? { item.at > 0 ? Date(timeIntervalSince1970: item.at / 1000) : nil }

    var mark: Mark {
        switch item.tier {
        case .needs: .needs
        case .progress: .working
        case .review, .finished: item.kind == .failed ? .failed : .done
        }
    }

    /// What the item says, and for a question why it reached the person rather than its lead.
    var what: String {
        [item.what, question?.why].compactMap { $0 }.joined(separator: " · ")
    }
}

func agentName(_ provider: String) -> String {
    agentNames[provider] ?? provider.capitalized
}

extension DeviceView {
    private func projectName(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "" }
        if let project = workspace.projects.first(where: { $0.id == value || $0.path == value }) {
            return project.name
        }
        return URL(fileURLWithPath: value).lastPathComponent
    }

    /// The inbox's items, with the question each asks from `questions`.
    func entries(_ questions: [AgentQuestion]) -> [Entry] {
        inbox.items.map { item in
            let chat = chats.first { $0.agentId == item.agentId }
            return Entry(
                item: item,
                project: projectName(item.project),
                subagents: chat?.subagents ?? 0,
                tasks: chat?.tasks ?? 0,
                ask: attentions.first { $0.id == item.requestId }.map(Ask.init),
                question: questions.first { $0.id == item.questionId }
            )
        }
    }
}

/// One choice a session offers, such as a model.
struct ConfigChoice: Decodable, Equatable, Hashable {
    let value: String
    let label: String
}

struct ConfigSelect: Decodable, Equatable {
    let id: String
    let current: String
    let choices: [ConfigChoice]
}

/// The model and effort pickers a launcher's last session offered, as the core reads them.
struct LauncherConfig: Equatable {
    let model: ConfigSelect?
    let effort: ConfigSelect?

    init(_ launcher: Launcher?) {
        model = launcher?.model
        effort = launcher?.effort
    }
}
