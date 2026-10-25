import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticLog } from "../src/diagnosticLog";
import { chainGeometry, poseDelta, rectangleOffset, surfaceClearance } from "../src/diagnosticGeometry";
import { poseFromMatrix } from "../src/surfacePose";
import { transformMatrix } from "../src/viroGeometry";

test("log rollover preserves event order and pinned sinking marker", () => {
  const log = new DiagnosticLog(700);
  log.record("USER_MARKED_SINKING", { y: -0.12 }, true);
  for (let i = 0; i < 20; i++) log.record("frame", { i, padding: "x".repeat(90) });
  const [header, pinned, ...stream] = log.export().split("\n").map(line => JSON.parse(line));
  assert.ok(header.droppedRecords > 0);
  assert.equal(pinned.pinnedEvents[0].event, "USER_MARKED_SINKING");
  assert.equal(stream.at(-1).data.i, 19);
  assert.ok(stream.every((row, i) => i === 0 || row.seq > stream[i - 1].seq));
  assert.ok(stream.reduce((size, row) => size + JSON.stringify(row).length, 0) <= 700);
});

test("clipboard export keeps complete recent JSONL records and declares truncation", () => {
  const log = new DiagnosticLog();
  log.record("placement", { slope: 1.5 }, true);
  for (let i = 0; i < 100; i++) log.record("frame", { i, payload: "x".repeat(500) });
  const copied = log.export(10_000);
  const [header, pins, ...stream] = copied.split("\n").map(line => JSON.parse(line));
  assert.ok(copied.length <= 10_000);
  assert.equal(header.exportTruncated, true);
  assert.equal(pins.pinnedEvents[0].event, "placement");
  assert.equal(stream.at(-1).data.i, 99);
  assert.equal(JSON.parse(log.export().split("\n")[0]).exportTruncated, false);
});

test("bad telemetry and native Error payloads cannot interrupt AR logging", () => {
  const log = new DiagnosticLog();
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.doesNotThrow(() => log.record("circular_native_payload", cycle));
  log.record("error", { error: new Error("camera lost"), value: NaN });
  const stream = log.export().split("\n").map(line => JSON.parse(line));
  assert.equal(stream[2].serializationError, true);
  assert.equal(stream[3].data.error.message, "camera lost");
  assert.equal(stream[3].data.value, "NaN");
});

test("pinned telemetry is bounded independently from the rolling frame buffer", () => {
  const log = new DiagnosticLog(1000);
  for (let i = 0; i < 120; i++) log.record("marker", { i, payload: "x".repeat(10_000) }, true);
  const [header, pinned] = log.export().split("\n").map(line => JSON.parse(line));
  assert.ok(header.droppedPinnedRecords > 0);
  assert.ok(pinned.pinnedEvents.length < 100);
  assert.equal(pinned.pinnedEvents.at(-1).data.i, 119);
  assert.ok(JSON.stringify(pinned).length < 510_000);
});

test("chain diagnostics match centered, even and odd rectangle layouts", () => {
  const flat = poseFromMatrix(transformMatrix([2, 0, 4], [0, 0, 0]));
  assert.deepEqual([0, 1, 2, 3].map(i => rectangleOffset(i, 3)), [0, -3, 3, -6]);
  const odd = chainGeometry(flat, 3, 11);
  assert.equal(odd.spanM, 33);
  assert.deepEqual(odd.leftEnd, [-14.5, 0.001, 4]);
  assert.deepEqual(odd.rightEnd, [18.5, 0.001, 4]);
  assert.equal(odd.heightChangeAlongChainM, 0);
  const even = chainGeometry(flat, 3, 2);
  assert.deepEqual(even.leftEnd, [-2.5, 0.001, 4]);
  assert.deepEqual(even.rightEnd, [3.5, 0.001, 4]);
});

test("small tilt reports growing height error without reporting anchor translation", () => {
  const flat = poseFromMatrix(transformMatrix([0, 0, 0], [0, 0, 0]));
  const tilted = poseFromMatrix(transformMatrix([0, 0, 0], [0, 0, 1]));
  const geometry = chainGeometry(tilted, 3, 11);
  assert.ok(Math.abs(geometry.heightChangeAlongChainM - 33 * Math.sin(Math.PI / 180)) < 1e-9);
  assert.equal(poseDelta(flat, tilted).verticalM, 0);
  assert.ok(Math.abs(poseDelta(flat, tilted).normalAngleDeg - 1) < 1e-9);
});

test("clearance sign identifies model below a surface, including a tilted plane", () => {
  const sunk = poseFromMatrix(transformMatrix([0, -0.1, 0], [0, 0, 0]));
  assert.ok(Math.abs(surfaceClearance(sunk, [0, 0, 0]).normalClearanceM + 0.099) < 1e-9);
  const tilted = poseFromMatrix(transformMatrix([0, 0, 0], [0, 0, 30]));
  const actualBottom = chainGeometry(tilted, 3, 11).leftEnd;
  assert.ok(Math.abs(surfaceClearance(tilted, actualBottom).normalClearanceM) < 1e-9);
  const raisedHit = actualBottom.map((v, i) => v + tilted.matrix[4 + i] * 0.1) as [number, number, number];
  assert.ok(Math.abs(surfaceClearance(tilted, raisedHit).normalClearanceM + 0.1) < 1e-9);
});
