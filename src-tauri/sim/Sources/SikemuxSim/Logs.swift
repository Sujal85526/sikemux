import FBControlCore
import Foundation

/// The latest lines of one device's log, numbered from 1 so a reader can ask for what came after the last line it saw.
/// Each process's lines are also kept apart, so a chatty process cannot push another's out before it is read.
final class LogTail: @unchecked Sendable {
    static let capacity = 2000

    private let lock = NSLock()
    private var all = Lines()
    private var byProcess: [String: Lines] = [:]
    private(set) var operation: (any LogOperation)?

    lazy var consumer: any DataConsumer = FBBlockDataConsumer.asynchronousLineConsumer { [weak self] line in
        self?.append(line)
    }

    func attach(_ operation: any LogOperation) {
        self.operation = operation
    }

    func append(_ line: String) {
        if line.hasPrefix("Filtering the log data") || line.hasPrefix("Timestamp ") { return }
        lock.lock()
        defer { lock.unlock() }
        all.append(line)
        if let process = Self.process(of: line) { byProcess[process, default: Lines()].append(line) }
    }

    /// The lines after `cursor`, at most `limit` of them, and how many older ones were already gone. Named a
    /// process, the lines and the cursor are that process's own.
    func read(process: String? = nil, after cursor: Int, limit: Int) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard let process else { return all.read(after: cursor, limit: limit) }
        return (byProcess[process] ?? Lines()).read(after: cursor, limit: limit)
    }

    /// A compact log line names its process before the bracket holding its ids:
    /// `2026-10-06 14:00:00.123 Df Maps[1234:5678] message`.
    static func process(of line: String) -> String? {
        line.split(separator: " ").lazy.compactMap { word -> String? in
            guard let bracket = word.firstIndex(of: "["), bracket > word.startIndex else { return nil }
            return String(word[..<bracket])
        }.first
    }
}

private struct Lines {
    private var lines: [String] = []
    private var last = 0

    mutating func append(_ line: String) {
        lines.append(line)
        last += 1
        if lines.count > LogTail.capacity { lines.removeFirst(lines.count - LogTail.capacity) }
    }

    func read(after cursor: Int, limit: Int) -> [String: Any] {
        let first = last - lines.count + 1
        let start = max(cursor + 1, first)
        let end = min(last, start + limit - 1)
        let slice = start <= end ? Array(lines[(start - first)...(end - first)]) : []
        return ["lines": slice, "cursor": start <= end ? end : max(cursor, start - 1), "dropped": max(0, first - cursor - 1), "more": end < last]
    }
}
