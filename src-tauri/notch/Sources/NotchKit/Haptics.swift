import AppKit

/// The trackpad's tick, felt only while a finger rests on a Force Touch trackpad.
enum Haptics {
    static var enabled = true

    static func tick() {
        guard enabled else { return }
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    }
}

/// A two-finger swipe along the island: down opens it, up closes it. Reports
/// how far the fingers have travelled, in points, the way they moved.
final class SwipeTracker {
    enum Direction { case down, up }

    /// How far the fingers travel before the swipe counts.
    static let threshold: CGFloat = 140

    private var travelled: CGFloat = 0
    private var direction: Direction?
    private var fired = false
    private var idle: DispatchWorkItem?

    var onPull: ((Direction, CGFloat) -> Void)?
    var onSwipe: ((Direction) -> Void)?
    var onEnd: (() -> Void)?

    func handle(_ event: NSEvent) {
        if event.phase == .ended || event.phase == .cancelled || event.momentumPhase == .ended {
            finish()
            return
        }
        guard event.momentumPhase == [] else { return }
        let dx = abs(event.scrollingDeltaX)
        let dy = abs(event.scrollingDeltaY)
        guard dy >= 1.5 * dx else { return }
        // A trackpad reports points; a mouse wheel reports lines, about eight points each.
        let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 8
        let fingersDown = (event.isDirectionInvertedFromDevice ? event.scrollingDeltaY : -event.scrollingDeltaY) * scale
        guard abs(fingersDown) > 0.2 else { return }
        let now: Direction = fingersDown > 0 ? .down : .up
        if now != direction {
            direction = now
            travelled = 0
            fired = false
        }
        travelled += abs(fingersDown)
        onPull?(now, travelled)
        if !fired, travelled >= Self.threshold {
            fired = true
            onSwipe?(now)
        }
        idle?.cancel()
        let timer = DispatchWorkItem { [weak self] in self?.finish() }
        idle = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: timer)
    }

    private func finish() {
        idle?.cancel()
        idle = nil
        travelled = 0
        direction = nil
        fired = false
        onEnd?()
    }
}
