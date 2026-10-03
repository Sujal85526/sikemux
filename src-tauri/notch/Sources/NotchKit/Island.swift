import AppKit
import Observation
import SwiftUI

/// Where a screen's notch is, or where the island sits on a screen without one.
struct NotchGeometry: Equatable {
    /// Zero on a screen without a notch: the island is one pill there.
    let notchWidth: CGFloat
    let height: CGFloat
    /// The middle of the notch, in screen coordinates.
    let centerX: CGFloat

    var hasNotch: Bool { notchWidth > 0 }

    static func of(_ screen: NSScreen) -> NotchGeometry {
        let frame = screen.frame
        let menuBar = frame.maxY - screen.visibleFrame.maxY
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            let width = frame.width - left.width - right.width
            return NotchGeometry(notchWidth: width, height: screen.safeAreaInsets.top, centerX: frame.minX + left.width + width / 2)
        }
        return NotchGeometry(notchWidth: 0, height: menuBar > 0 ? menuBar : 24, centerX: frame.midX)
    }
}

enum Motion {
    static let open = Animation.spring(response: 0.42, dampingFraction: 0.8)
    static let close = Animation.spring(response: 0.45, dampingFraction: 1.0)
    static let hover = Animation.interactiveSpring(response: 0.38, dampingFraction: 0.8)
    static let content = Animation.smooth(duration: 0.35)
}

/// The island on one screen: whether it is open, and what is being typed in it.
@Observable
final class IslandModel {
    enum Mode: Equatable {
        case closed
        case peekAsk(String)
        case peekDone(String)
        case open
        case drop
    }

    enum Tab { case agents, compose }
    enum Menu { case model, effort, project }

    var mode: Mode = .closed
    var hovering = false
    var tab: Tab = .agents
    var menu: Menu?
    var draft = ""
    var provider = "claude"
    var model: String?
    var effort: String?
    var project: Project?
    var yolo = true
    var attachments: [String] = []
    var dropTarget: String?
    var composing = false
    /// Hidden while Sikemux Dev's helper holds the notch, or over a full-screen app.
    var hidden = false
    var geometry: NotchGeometry

    @ObservationIgnored var wantsKey: ((Bool) -> Void)?
    @ObservationIgnored private var peekTimer: DispatchWorkItem?
    @ObservationIgnored private var hoverTimer: DispatchWorkItem?

    init(geometry: NotchGeometry) {
        self.geometry = geometry
    }

    var isOpen: Bool { mode == .open || mode == .drop }

    func set(_ mode: Mode, animation: Animation? = nil) {
        let opening = mode == .open || mode == .drop || mode != .closed
        withAnimation(animation ?? (opening ? Motion.open : Motion.close)) {
            self.mode = mode
            if mode != .open { menu = nil }
        }
        wantsKey?(mode == .open && tab == .compose)
    }

    func peek(_ peek: NotchStore.Peek, for seconds: Double) {
        guard !isOpen, !hidden else { return }
        switch peek {
        case .ask(let id): set(.peekAsk(id))
        case .done(let id): set(.peekDone(id))
        }
        peekTimer?.cancel()
        let timer = DispatchWorkItem { [weak self] in
            guard let self, !self.hovering, !self.isOpen else { return }
            self.set(.closed)
        }
        peekTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: timer)
    }

    func pointer(entered: Bool, opensOnHover: Bool) {
        hoverTimer?.cancel()
        if entered {
            if !hovering {
                NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
            }
            withAnimation(Motion.hover) { hovering = true }
            guard opensOnHover, !isOpen else { return }
            schedule(after: 0.3) { $0.set(.open) }
        } else {
            schedule(after: 0.1) { island in
                withAnimation(Motion.hover) { island.hovering = false }
                guard island.mode == .open, !island.composing, island.menu == nil else { return }
                island.set(.closed)
            }
        }
    }

    private func schedule(after seconds: Double, _ work: @escaping (IslandModel) -> Void) {
        let timer = DispatchWorkItem { [weak self] in
            if let self { work(self) }
        }
        hoverTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: timer)
    }
}

/// The notch's outline: the top corners curve outward into the menu bar and
/// the bottom ones inward. Both radii animate with the size.
struct NotchShape: Shape {
    var top: CGFloat
    var bottom: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(top, bottom) }
        set {
            top = newValue.first
            bottom = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        let t = min(top, rect.width / 4, rect.height / 2)
        let b = min(bottom, rect.width / 4, max(0, rect.height - t))
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.minX + t, y: rect.minY + t), control: CGPoint(x: rect.minX + t, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + t, y: rect.maxY - b))
        path.addQuadCurve(to: CGPoint(x: rect.minX + t + b, y: rect.maxY), control: CGPoint(x: rect.minX + t, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - t - b, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - t, y: rect.maxY - b), control: CGPoint(x: rect.maxX - t, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - t, y: rect.minY + t))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: rect.maxX - t, y: rect.minY))
        path.closeSubpath()
        return path
    }
}

enum Radii {
    static let closed = (top: CGFloat(6), bottom: CGFloat(14))
    static let peek = (top: CGFloat(14), bottom: CGFloat(22))
    static let open = (top: CGFloat(19), bottom: CGFloat(24))
}
