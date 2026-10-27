import Foundation

func records(_ text: String) -> [[String: Any]] {
    text.split(separator: "\n").map { line in
        try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
    }
}
let log = DiagnosticLog(maxSize: 5_000)
log.record("USER_MARKED_SINKING", ["value": Float.nan, "nested": [Double.infinity]], pin: true)
for index in 0..<200 { log.record("snapshot", ["index": index, "payload": String(repeating: "é", count: 80)]) }
let full = log.export()
let parsed = records(full.text)
assert(parsed[0]["exportTruncated"] as? Bool == false)
assert((parsed[0]["droppedRecords"] as! Int) > 0)
let pins = parsed[1]["pinnedEvents"] as! [[String: Any]]
assert(pins.count == 1)
assert(pins[0]["event"] as? String == "USER_MARKED_SINKING")
let data = pins[0]["data"] as! [String: Any]
assert(data["value"] is String, "Nonfinite sensor values must remain valid JSON")
assert(parsed.last!["data"] is [String: Any])
let short = log.export(maxBytes: 3_000)
assert(short.truncated)
assert(short.text.utf8.count <= 3_000)
let shortRecords = records(short.text)
assert(shortRecords[0]["exportTruncated"] as? Bool == true)
let stream = shortRecords.dropFirst(2)
let sequences = stream.map { $0["seq"] as! Int }
assert(sequences == sequences.sorted())
assert((stream.last!["data"] as! [String: Any])["index"] as? Int == 199)
let bounded = DiagnosticLog()
for index in 0..<120 { bounded.record("marker", ["index": index], pin: true) }
let boundedRecords = records(bounded.export().text)
assert((boundedRecords[1]["pinnedEvents"] as! [[String: Any]]).count == 100)
assert(boundedRecords[0]["droppedPinnedRecords"] as? Int == 20)
assert(bounded.due("snapshot", interval: 60))
assert(!bounded.due("snapshot", interval: 60))
assert(bounded.due("other", interval: 60))
print("Diagnostic log checks passed: eviction, pinned markers, UTF-8 export limits, JSON validity, ordering, throttling")
