import SwiftUI

/// The rail's state marks: a twinkling grid while working, an amber dot that
/// rings twice when it starts needing you, a purple dot when done and unseen.
struct StateMark: View {
    let state: AgentState

    var body: some View {
        switch state {
        case .working: TwinkleGrid().foregroundStyle(Theme.live)
        case .blocked: PingDot(colour: Theme.warn)
        case .done: Dot(colour: Theme.accent)
        case .idle: EmptyView()
        }
    }
}

private struct Dot: View {
    let colour: Color

    var body: some View {
        Circle().fill(colour).frame(width: 7, height: 7).frame(width: 16, height: 16)
    }
}

private struct PingDot: View {
    let colour: Color
    @State private var rang = false

    var body: some View {
        ZStack {
            ForEach(0..<2, id: \.self) { ring in
                Circle()
                    .stroke(colour, lineWidth: 1.5)
                    .frame(width: 7, height: 7)
                    .scaleEffect(rang ? 2.4 : 0.6)
                    .opacity(rang ? 0 : 0.9)
                    .animation(.timingCurve(0.2, 0.6, 0.3, 1, duration: 0.52).delay(Double(ring) * 0.38), value: rang)
            }
            Circle().fill(colour).frame(width: 7, height: 7)
        }
        .frame(width: 16, height: 16)
        .onAppear { rang = true }
    }
}

private struct TwinkleGrid: View {
    private static let cells: [(period: Double, offset: Double)] = [
        (0.9, 0), (1.24, -0.52), (1.58, -1.04), (1.07, -0.39), (1.41, -0.91),
        (0.9, -0.26), (1.24, -0.78), (1.58, -0.13), (1.07, -0.65),
    ]

    var body: some View {
        TimelineView(.animation) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            Grid(horizontalSpacing: 1.5, verticalSpacing: 1.5) {
                ForEach(0..<3, id: \.self) { row in
                    GridRow {
                        ForEach(0..<3, id: \.self) { column in
                            let cell = Self.cells[row * 3 + column]
                            RoundedRectangle(cornerRadius: 0.5)
                                .frame(width: 2.5, height: 2.5)
                                .opacity(Self.opacity(time, cell))
                        }
                    }
                }
            }
        }
        .frame(width: 16, height: 16)
    }

    /// The app's keyframes: dim, brightest two fifths of the way through, dim again.
    private static func opacity(_ time: Double, _ cell: (period: Double, offset: Double)) -> Double {
        let phase = ((time + cell.offset) / cell.period).truncatingRemainder(dividingBy: 1)
        let wrapped = phase < 0 ? phase + 1 : phase
        let rise = wrapped < 0.4 ? wrapped / 0.4 : 1 - (wrapped - 0.4) / 0.6
        let eased = rise * rise * (3 - 2 * rise)
        return 0.2 + 0.8 * eased
    }
}

struct CapsuleButton: View {
    let title: String
    var primary = false
    var height: CGFloat = 32
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Theme.ui(12.5, .semibold))
                .foregroundStyle(primary ? Theme.onAccent : Theme.ink)
                .frame(maxWidth: .infinity)
                .frame(height: height)
                .background(Capsule().fill(fill))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    private var fill: Color {
        if primary { return hovering ? Color(hex: "#b08fff") : Theme.accent }
        return Color.white.opacity(hovering ? 0.16 : 0.1)
    }
}

/// A capsule that fills on hover, for icons and chips in the island.
struct HoverCapsule<Label: View>: View {
    var selected = false
    var selectedFill = Color.white.opacity(0.12)
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label().background(Capsule().fill(selected ? selectedFill : hovering ? Theme.hover : .clear)).contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// How long an agent has been in its state: a clock while it works or waits,
/// how long ago once it finished.
struct SinceText: View {
    let state: AgentState
    let since: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(Self.format(state, since, context.date))
                .font(Theme.ui(11.5))
                .monospacedDigit()
                .foregroundStyle(Theme.inkFaint)
        }
    }

    static func format(_ state: AgentState, _ since: Date?, _ now: Date) -> String {
        guard let since, state != .idle else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(since)))
        if state == .done {
            if seconds < 60 { return "just now" }
            if seconds < 3600 { return "\(seconds / 60)m ago" }
            return "\(seconds / 3600)h ago"
        }
        let hours = seconds / 3600
        let minutes = seconds % 3600 / 60
        let rest = seconds % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }
}
