import Foundation

/// Main-thread bounded JSONL capture. No camera images or network traffic.
final class DiagnosticLog {
    private var lines: [(String, Int)] = []
    private var head = 0
    private var size = 0
    private var dropped = 0
    private var sequence = 0
    private var pinned: [(String, Int)] = []
    private var pinnedSize = 0
    private var droppedPinned = 0
    private let started = ProcessInfo.processInfo.systemUptime
    private let captureUTC = ISO8601DateFormatter().string(from: Date())
    private let formatter = ISO8601DateFormatter()
    private var channels: [String: TimeInterval] = [:]
    private let maxSize: Int

    init(maxSize: Int = 6_000_000) { self.maxSize = maxSize }

    func due(_ channel: String, interval: TimeInterval) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        if let previous = channels[channel], now - previous < interval { return false }
        channels[channel] = now
        return true
    }

    private func clean(_ value: Any) -> Any {
        if let map = value as? [String: Any] { return map.mapValues(clean) }
        if let array = value as? [Any] { return array.map(clean) }
        if let number = value as? NSNumber, !number.doubleValue.isFinite { return number.stringValue }
        return value
    }

    private func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: clean(value), options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return nil }
        return text
    }

    func record(_ event: String, _ data: [String: Any] = [:], pin: Bool = false) {
        let header: [String: Any] = ["seq": sequence, "utc": formatter.string(from: Date()),
            "elapsedMs": (ProcessInfo.processInfo.systemUptime - started) * 1000, "event": event]
        sequence += 1
        var record = header
        record["data"] = data
        let text = json(record) ?? json(header.merging(["serializationError": true]) { _, new in new })!
        let length = text.utf8.count
        if pin {
            pinned.append((text, length)); pinnedSize += length
            while pinned.count > 100 || pinnedSize > 500_000 {
                pinnedSize -= pinned.removeFirst().1; droppedPinned += 1
            }
        }
        guard length <= maxSize else { dropped += 1; return }
        lines.append((text, length)); size += length
        while size > maxSize && head < lines.count {
            size -= lines[head].1
            lines[head] = ("", 0) // Release evicted payloads before periodic array compaction.
            head += 1; dropped += 1
        }
        if head > 1024 { lines.removeFirst(head); head = 0 }
    }

    func export(maxBytes: Int? = nil) -> (text: String, truncated: Bool) {
        let limit = maxBytes ?? Int.max
        var selectedPinned: [String] = []
        var pinnedBytes = 0
        for item in pinned.reversed() where item.1 + pinnedBytes <= limit / 4 {
            selectedPinned.append(item.0); pinnedBytes += item.1 + 1
        }
        let budget = limit - pinnedBytes - 2048
        var stream: [String] = []
        var streamBytes = 0
        for index in (head..<lines.count).reversed() {
            let item = lines[index]
            if streamBytes + item.1 + 1 > budget { break }
            stream.append(item.0); streamBytes += item.1 + 1
        }
        let truncated = stream.count != lines.count - head || selectedPinned.count != pinned.count
        let header: [String: Any] = ["format": "floor-frame-ar-diagnostics", "version": 1,
            "renderer": "RealityKit / ARKit", "captureStartedUTC": captureUTC,
            "exportedUTC": formatter.string(from: Date()), "droppedRecords": dropped,
            "retainedRecords": lines.count - head, "maxBufferedBytes": maxSize,
            "droppedPinnedRecords": droppedPinned, "exportedRecords": stream.count,
            "exportTruncated": truncated,
            "units": "metres, degrees; column-major transforms; Y up; monotonic elapsedMs",
            "note": "Surface probes are AR estimates, not independent ground truth or occlusion depth-buffer pixels. Pinned events can repeat stream records; deduplicate by seq. No camera images collected."]
        return (([json(header)!, "{\"pinnedEvents\":[\(selectedPinned.reversed().joined(separator: ","))]}"] + stream.reversed()).joined(separator: "\n"), truncated)
    }
}
