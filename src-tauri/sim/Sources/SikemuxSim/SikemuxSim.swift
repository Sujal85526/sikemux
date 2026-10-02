import Foundation
import SikemuxSimKit

@main
struct SikemuxSim {
    static let version = "sikemux-sim 1"

    @MainActor
    static func main() async {
        let arguments = CommandLine.arguments
        if arguments.contains("--version") {
            print(version)
            return
        }
        let simulators: Simulators
        do {
            simulators = try Simulators()
        } catch {
            write(Reply.event("unavailable", ["message": "\(error)"]))
            exit(1)
        }
        if let index = arguments.firstIndex(of: "--probe") {
            let device = arguments.dropFirst(index + 1).first { !$0.hasPrefix("--") }
            exit(await Probe.run(simulators, device: device) ? 0 : 1)
        }
        write(Reply.event("ready", ["version": version]))
        // Requests run side by side, and the ones still running when stdin closes are answered before exit.
        await withDiscardingTaskGroup { group in
            for await line in standardInputLines() {
                guard let request = parse(line) else { continue }
                group.addTask { await answer(request, with: simulators) }
            }
        }
    }

    private static func parse(_ line: Data) -> Request? {
        guard !line.isEmpty else { return nil }
        do {
            return try Request.parse(line)
        } catch {
            write(Reply.failure(id: error.id, error.description))
            return nil
        }
    }

    @MainActor
    private static func answer(_ request: Request, with simulators: Simulators) async {
        do {
            write(Reply.success(id: request.id, try await simulators.handle(request.command)))
        } catch {
            write(Reply.failure(id: request.id, "\(error)"))
        }
    }

    private static let output = NSLock()

    static func write(_ line: Data) {
        output.lock()
        defer { output.unlock() }
        FileHandle.standardOutput.write(line)
    }

    /// stdin closing means Sikemux has gone, so the loop ends and the helper exits with it.
    private static func standardInputLines() -> AsyncStream<Data> {
        AsyncStream { continuation in
            Thread.detachNewThread {
                while let line = readLine(strippingNewline: true) { continuation.yield(Data(line.utf8)) }
                continuation.finish()
            }
        }
    }
}
