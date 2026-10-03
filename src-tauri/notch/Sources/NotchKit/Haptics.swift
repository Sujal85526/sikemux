import AppKit
import IOKit

/// The trackpad's tick, felt only while a finger rests on a Force Touch trackpad.
///
/// `NSHapticFeedbackManager` only plays for the app in front, and the island
/// never is, so it drives the trackpad's actuator directly through
/// MultitouchSupport, as background haptic apps do. Without that framework it
/// falls back to the public API.
enum Haptics {
    static var enabled = true

    static func tick() {
        guard enabled else { return }
        if !Actuators.shared.tick() {
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        }
    }
}

private final class Actuators {
    static let shared = Actuators()

    private typealias Create = @convention(c) (UInt64) -> Unmanaged<CFTypeRef>?
    private typealias Open = @convention(c) (CFTypeRef) -> Int32
    private typealias Actuate = @convention(c) (CFTypeRef, Int32, UInt32, Float, Float) -> Int32

    /// The lightest of the actuator's clicks.
    private static let weak: Int32 = 3

    private var fire: Actuate?
    private var actuators: [CFTypeRef] = []

    private init() {
        guard let framework = dlopen("/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport", RTLD_LAZY),
              let create = dlsym(framework, "MTActuatorCreateFromDeviceID"),
              let open = dlsym(framework, "MTActuatorOpen"),
              let actuate = dlsym(framework, "MTActuatorActuate")
        else { return }
        let makeActuator = unsafeBitCast(create, to: Create.self)
        let openActuator = unsafeBitCast(open, to: Open.self)
        for id in Self.trackpads() {
            guard let actuator = makeActuator(id)?.takeRetainedValue(), openActuator(actuator) == 0 else { continue }
            actuators.append(actuator)
        }
        fire = unsafeBitCast(actuate, to: Actuate.self)
    }

    /// False when no trackpad could be driven, so the caller falls back.
    func tick() -> Bool {
        guard let fire, !actuators.isEmpty else { return false }
        var played = false
        for actuator in actuators where fire(actuator, Self.weak, 0, 0, 2) == 0 {
            played = true
        }
        return played
    }

    /// The ids of the multitouch devices that can click back: the built-in trackpad and any Magic Trackpad.
    private static func trackpads() -> [UInt64] {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleMultitouchDevice"), &iterator) == KERN_SUCCESS
        else { return [] }
        defer { IOObjectRelease(iterator) }
        var ids: [UInt64] = []
        while case let service = IOIteratorNext(iterator), service != 0 {
            defer { IOObjectRelease(service) }
            func property(_ key: String) -> Any? {
                IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
            }
            guard (property("ActuationSupported") as? Bool) == true,
                  let id = (property("Multitouch ID") as? NSNumber)?.uint64Value
            else { continue }
            ids.append(id)
        }
        return ids
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
