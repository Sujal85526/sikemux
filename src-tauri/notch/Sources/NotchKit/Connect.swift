import SwiftUI

/// A device signed in to the person's Sikemux account, waiting to be let in.
struct PendingDevice: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let platform: String

    /// How long the core waits for an answer before turning the device away:
    /// `APPROVAL_TIMEOUT` in the core's join.rs.
    static let answerWindow: TimeInterval = 120
}

/// The part of the core's remote status the island shows.
struct RemoteStatus: Decodable {
    let pending: [PendingDevice]
}

enum DeviceAccess: String {
    case full, watch
}

/// A device asking to connect, answered from the island.
struct ConnectCard: View {
    let store: NotchStore
    let device: PendingDevice?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let device {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        IconView(icon: Icons.phone, size: 20)
                            .foregroundStyle(Theme.ink)
                            .frame(width: 36, height: 36)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.08)))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(device.name.isEmpty ? "A device" : device.name) wants to connect")
                                .font(Theme.ui(14, .semibold))
                                .foregroundStyle(Theme.ink)
                                .lineLimit(1)
                            HStack(spacing: 5) {
                                Text("From your Sikemux account").lineLimit(1)
                                Text("·").foregroundStyle(Theme.inkFaint)
                                TimeLeft(asked: store.deviceAsked[device.id])
                            }
                            .font(Theme.ui(12))
                            .foregroundStyle(Theme.inkDim)
                        }
                    }
                    HStack(spacing: 8) {
                        CapsuleButton(title: "Decline") { store.answer(device, access: nil) }
                        CapsuleButton(title: "Watch only") { store.answer(device, access: .watch) }
                        CapsuleButton(title: "Allow", primary: true) { store.answer(device, access: .full) }
                    }
                    if let error = store.error {
                        Text(error).font(Theme.ui(11.5)).foregroundStyle(Theme.danger)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Theme.raised))
            }
        }
        .padding(.top, 8)
    }
}

/// The time left to answer a device, as m:ss.
private struct TimeLeft: View {
    let asked: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(Self.format(asked, context.date)).monospacedDigit()
        }
    }

    static func format(_ asked: Date?, _ now: Date) -> String {
        let elapsed = asked.map { now.timeIntervalSince($0) } ?? 0
        let left = max(0, Int((PendingDevice.answerWindow - elapsed).rounded(.up)))
        return String(format: "%d:%02d", left / 60, left % 60)
    }
}
