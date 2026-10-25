/** Bounded JSONL recording, independent of React and the console. */
export class DiagnosticLog {
  private lines: { text: string; size: number }[] = [];
  private head = 0;
  private size = 0;
  private dropped = 0;
  private sequence = 0;
  private readonly started = performance.now();
  private readonly id = new Date().toISOString();
  private readonly pinned: string[] = [];
  private pinnedSize = 0;
  private droppedPinned = 0;
  private readonly channels = new Map<string, number>();

  constructor(private readonly maxSize = 6_000_000) {}

  /** Returns false if this channel is not yet due. Does not schedule work. */
  due(channel: string, intervalMs: number) {
    const now = performance.now();
    const previous = this.channels.get(channel);
    if (previous !== undefined && now - previous < intervalMs) return false;
    this.channels.set(channel, now);
    return true;
  }

  record(event: string, data: unknown = {}, pin = false) {
    // Logging must never break the AR path, even when a native error contains
    // circular objects or non-finite sensor values.
    let text: string;
    const header = { seq: this.sequence++, utc: new Date().toISOString(), elapsedMs: performance.now() - this.started, event };
    try {
      text = JSON.stringify({ ...header, data }, (_key, value: unknown) => {
        if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
        if (typeof value === "number" && !Number.isFinite(value)) return String(value);
        return value;
      });
    } catch {
      text = JSON.stringify({ ...header, serializationError: true });
    }
    if (pin) {
      this.pinned.push(text);
      this.pinnedSize += text.length;
      while (this.pinned.length > 100 || this.pinnedSize > 500_000) {
        this.pinnedSize -= this.pinned.shift()!.length;
        this.droppedPinned++;
      }
    }
    const size = text.length;
    if (size > this.maxSize) { this.dropped++; return; }
    this.lines.push({ text, size });
    this.size += size;
    while (this.size > this.maxSize && this.head < this.lines.length) {
      this.size -= this.lines[this.head++].size;
      this.dropped++;
    }
    if (this.head > 1024) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }

  export(maxCharacters = Infinity) {
    const pinnedBudget = Number.isFinite(maxCharacters) ? Math.floor(maxCharacters / 4) : Infinity;
    const pinned: string[] = [];
    let pinnedSize = 0;
    for (let i = this.pinned.length - 1; i >= 0; i--) {
      if (pinnedSize + this.pinned[i].length > pinnedBudget) continue;
      pinned.unshift(this.pinned[i]);
      pinnedSize += this.pinned[i].length;
    }
    const streamBudget = maxCharacters - pinnedSize - 2048;
    const stream: string[] = [];
    let streamSize = 0;
    for (let i = this.lines.length - 1; i >= this.head; i--) {
      const line = this.lines[i].text;
      if (streamSize + line.length + 1 > streamBudget) break;
      stream.push(line);
      streamSize += line.length + 1;
    }
    return [JSON.stringify({
      format: "floor-frame-ar-diagnostics", version: 1, captureStartedUTC: this.id,
      exportedUTC: new Date().toISOString(), droppedRecords: this.dropped,
      retainedRecords: this.lines.length - this.head, maxBufferedCharacters: this.maxSize,
      droppedPinnedRecords: this.droppedPinned, exportedRecords: stream.length,
      exportTruncated: stream.length !== this.lines.length - this.head || pinned.length !== this.pinned.length,
      units: "metres, degrees; column-major transforms; Y up; elapsedMs uses a monotonic clock",
      note: "Surface probes are AR estimates, not independent ground truth. Pinned events may also occur in the chronological stream; deduplicate by seq.",
    }), `{"pinnedEvents":[${pinned.join(",")}]}`,
    ...stream.reverse()].join("\n");
  }
}
