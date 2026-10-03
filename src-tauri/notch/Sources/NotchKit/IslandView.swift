import SwiftUI

/// The island on one screen, top-centred in its panel. Only the black shape
/// is drawn, so the rest of the panel lets clicks through to what is under it.
///
/// It is one shape whose width, height and corners spring together: the band
/// beside the camera swaps what it shows in place, and the body below it
/// arrives scaled from the top. Agent marks fly from the wings to their rows.
struct IslandView: View {
    let store: NotchStore
    @Bindable var island: IslandModel
    @Namespace private var marks

    var body: some View {
        VStack(spacing: 0) {
            if shows {
                shape.transition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .compositingGroup()
        .scaleEffect(island.pullScale, anchor: .top)
        .animation(.smooth, value: island.pull)
        .preferredColorScheme(.dark)
    }

    private var geometry: NotchGeometry { island.geometry }

    private var shows: Bool {
        guard !island.hidden else { return false }
        return geometry.hasNotch || !store.agents.isEmpty || island.mode != .closed
    }

    private var expanded: Bool {
        switch island.mode {
        case .closed, .peekDone: return false
        case .peekAsk, .open, .drop: return true
        }
    }

    private var radii: (top: CGFloat, bottom: CGFloat) {
        switch island.mode {
        case .closed, .peekDone: return Radii.closed
        case .peekAsk: return Radii.peek
        case .open, .drop: return Radii.open
        }
    }

    private var width: CGFloat {
        switch island.mode {
        case .closed: return ClosedWings.width(store.agents.count, geometry)
        case .peekDone: return geometry.notchWidth + 2 * FinishedWings.wing
        case .peekAsk: return 460
        case .open, .drop: return 680
        }
    }

    private var inset: CGFloat {
        switch island.mode {
        case .closed, .peekDone: return 0
        case .peekAsk: return Radii.peek.top + 8
        case .open, .drop: return Radii.open.top + 12
        }
    }

    private var lifted: Bool { island.mode != .closed || island.hovering }

    private var shape: some View {
        let outline = NotchShape(top: radii.top, bottom: radii.bottom)
        return VStack(alignment: .leading, spacing: 0) {
            band
            if expanded {
                expandedBody.transition(.opening)
            }
        }
        .padding(.horizontal, inset)
        .padding(.bottom, expanded ? 14 : 0)
        .frame(width: width, alignment: .top)
        .background(Color.black)
        .clipShape(outline)
        .contentShape(outline)
        .shadow(color: lifted ? .black.opacity(0.7) : .clear, radius: 6)
        .onHover { island.pointer(entered: $0, opensOnHover: store.settings.openWith == .hover) }
        .onTapGesture {
            if !island.isOpen { island.set(.open) }
        }
        .onExitCommand { island.set(.closed) }
    }

    /// What sits beside the camera: the wings when closed, a header when open.
    @ViewBuilder
    private var band: some View {
        ZStack {
            switch island.mode {
            case .closed:
                ClosedWings(store: store, geometry: geometry, marks: marks)
                    .transition(.inPlace)
            case .peekDone(let id):
                FinishedWings(agent: store.agents.first { $0.id == id }, geometry: geometry, marks: marks)
                    .transition(.inPlace)
            case .peekAsk(let id):
                AskHeader(agent: store.agents.first { $0.id == id }, geometry: geometry, marks: marks)
                    .transition(.inPlace)
            case .open:
                OpenHeader(store: store, island: island)
                    .transition(.inPlace)
            case .drop:
                HeaderBand(geometry: geometry) {
                    Text("Drop to start or send").font(Theme.ui(13, .semibold)).foregroundStyle(Theme.ink).padding(.leading, 12)
                } trailing: {
                    EmptyView()
                }
                .transition(.inPlace)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: geometry.height)
    }

    @ViewBuilder
    private var expandedBody: some View {
        switch island.mode {
        case .peekAsk(let id):
            AskBody(store: store, island: island, agent: store.agents.first { $0.id == id })
        case .drop:
            DropTargets(store: store, island: island)
        default:
            OpenBody(store: store, island: island, marks: marks)
        }
    }
}

extension AnyTransition {
    /// The body arriving in an opening island: from 80%, anchored at the top, as it fades in.
    static var opening: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.8, anchor: .top).combined(with: .opacity).animation(Motion.content),
            removal: .opacity.animation(.smooth(duration: 0.16))
        )
    }

    /// What the band shows changing where it stands: out of and into a 20-point blur.
    static var inPlace: AnyTransition {
        .opacity.combined(with: .modifier(active: BlurModifier(radius: 20), identity: BlurModifier(radius: 0)))
    }
}

private struct BlurModifier: ViewModifier {
    let radius: CGFloat
    func body(content: Content) -> some View { content.blur(radius: radius) }
}

/// Closed: the notch, with the marks of the running agents on its left and
/// the state that matters most on its right.
struct ClosedWings: View {
    let store: NotchStore
    let geometry: NotchGeometry
    let marks: Namespace.ID

    private var running: [AgentItem] { store.agents }

    static func wing(_ count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        let tiles = min(count, 3) + (count > 3 ? 1 : 0)
        let left = 14 + 24 + CGFloat(max(0, tiles - 1)) * 17 + 8
        let right: CGFloat = 14 + 16 + 6 + 10 + 8
        return max(48, left, right)
    }

    static func width(_ count: Int, _ geometry: NotchGeometry) -> CGFloat {
        geometry.notchWidth + 2 * wing(count)
    }

    var body: some View {
        let wing = Self.wing(running.count)
        HStack(spacing: 0) {
            if wing > 0 {
                HStack(spacing: -7) {
                    ForEach(running.prefix(3)) { agent in
                        MarkTile(provider: agent.provider)
                            .matchedGeometryEffect(id: agent.id, in: marks)
                    }
                    if running.count > 3 {
                        Text("+\(running.count - 3)")
                            .font(Theme.ui(10, .semibold))
                            .foregroundStyle(Theme.ink)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(Color(hex: "#1f1d26")))
                            .overlay(Circle().stroke(Color.black, lineWidth: 2))
                    }
                }
                .padding(.leading, 14)
                .frame(width: wing, alignment: .leading)
            }
            Color.clear.frame(width: geometry.notchWidth)
            if wing > 0 {
                HStack(spacing: 6) {
                    if let top = store.rollup {
                        if top.count > 1 {
                            Text("\(top.count)").font(Theme.ui(12, .semibold)).monospacedDigit().foregroundStyle(Theme.ink)
                        }
                        StateMark(state: top.state).id(top.state)
                    }
                }
                .padding(.trailing, 14)
                .frame(width: wing, alignment: .trailing)
            }
        }
        .frame(height: geometry.height)
    }
}

/// A finished agent, for a moment, on either side of the notch.
struct FinishedWings: View {
    static let wing: CGFloat = 150

    let agent: AgentItem?
    let geometry: NotchGeometry
    let marks: Namespace.ID

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 8) {
                if let agent {
                    MarkTile(provider: agent.provider).matchedGeometryEffect(id: agent.id, in: marks)
                }
                Text("Finished").font(Theme.ui(12.5, .semibold)).foregroundStyle(Theme.ink)
            }
            .padding(.leading, 14)
            .frame(width: Self.wing, alignment: .leading)
            Color.clear.frame(width: geometry.notchWidth)
            HStack(spacing: 6) {
                Text(agent?.title ?? "")
                    .font(Theme.ui(12.5, .medium))
                    .foregroundStyle(Theme.inkDim)
                    .lineLimit(1)
                StateMark(state: .done)
            }
            .padding(.trailing, 14)
            .frame(width: Self.wing, alignment: .trailing)
        }
        .frame(height: geometry.height)
    }
}

/// The two sides of the menu-bar band, split around the camera.
struct HeaderBand<Leading: View, Trailing: View>: View {
    let geometry: NotchGeometry
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 8) { leading() }.frame(maxWidth: .infinity, alignment: .leading)
            if geometry.hasNotch { Color.clear.frame(width: geometry.notchWidth + 8) }
            HStack(spacing: 6) { trailing() }.frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(height: geometry.height)
    }
}

/// A permission request's band: the agent on the left of the camera, that it needs you on the right.
struct AskHeader: View {
    let agent: AgentItem?
    let geometry: NotchGeometry
    let marks: Namespace.ID

    var body: some View {
        HeaderBand(geometry: geometry) {
            if let agent {
                MarkTile(provider: agent.provider, size: 26, ringed: false).matchedGeometryEffect(id: agent.id, in: marks)
            }
            Text(agent.map { agentName($0.provider) } ?? "").font(Theme.ui(13, .semibold)).foregroundStyle(Theme.ink)
        } trailing: {
            Text("Needs you").font(Theme.ui(12, .semibold)).foregroundStyle(Theme.warn)
            StateMark(state: .blocked)
        }
    }
}

/// A permission request, answered without opening the island.
struct AskBody: View {
    let store: NotchStore
    let island: IslandModel
    let agent: AgentItem?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let agent {
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.title).font(Theme.ui(13, .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    ProjectLabel(project: agent.project, suffix: agent.ask == nil ? "needs you" : "wants to run a command")
                }
                .padding(.top, 8)
                if let ask = agent.ask {
                    CommandText(command: ask.command).padding(.top, 10)
                }
                AnswerButtons(store: store, island: island, agent: agent, height: 32).padding(.top, 10)
            }
        }
        .padding(.bottom, 2)
    }
}

struct ProjectLabel: View {
    let project: String
    var suffix: String?

    var body: some View {
        HStack(spacing: 4) {
            IconView(icon: Icons.folder, size: 11).foregroundStyle(Theme.inkFaint)
            Text(project).lineLimit(1)
            if let suffix {
                Text("·").foregroundStyle(Theme.inkFaint)
                Text(suffix).lineLimit(1)
            }
        }
        .font(Theme.ui(11.5))
        .foregroundStyle(Theme.inkDim)
    }
}

struct CommandText: View {
    let command: String
    var darker = false

    var body: some View {
        HStack(spacing: 8) {
            Text("$").foregroundStyle(Theme.inkFaint)
            Text(command).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
        }
        .font(Theme.mono(12))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(darker ? Color.black.opacity(0.45) : Theme.raised))
    }
}

/// Deny, Always allow and Allow for a chat agent; Open in Sikemux for anything the notch cannot answer.
struct AnswerButtons: View {
    let store: NotchStore
    let island: IslandModel
    let agent: AgentItem
    var height: CGFloat

    var body: some View {
        if let ask = agent.ask, agent.isChat, store.settings.answerInNotch {
            HStack(spacing: 8) {
                CapsuleButton(title: "Deny", height: height) { answer(ask, ask.reject) }
                if ask.allowAlways != nil {
                    CapsuleButton(title: "Always allow", height: height) { answer(ask, ask.allowAlways) }
                }
                CapsuleButton(title: "Allow", primary: true, height: height) { answer(ask, ask.allowOnce) }
            }
        } else {
            CapsuleButton(title: "Open in Sikemux", primary: true, height: height) { store.focus(agent.id) }
        }
    }

    private func answer(_ ask: Ask, _ option: String?) {
        store.answer(ask, agentId: agent.id, optionId: option)
        if case .peekAsk = island.mode { island.set(.closed) }
    }
}
