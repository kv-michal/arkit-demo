import Foundation
import simd

/// IMPLEMENTATION_PLAN section 5: robust floor-plane calibration. Port of
/// floor-frame-viro/src/floorCalibration.ts; both are checked against
/// Tests/fixtures. Thresholds are tuning proposals, not sensor specifications.
enum FloorCalibration {
    static let cellSize = 0.2
    static let maxPerCell = 16
    static let maxObservations = 2000
    static let minRange = 0.3
    static let maxRange = 5.0
    static let minBelowCamera = 0.05
    static let ransacIterations = 128
    static let ransacSeed: UInt32 = 12345
    static let inlierThreshold = 0.03
    static let bootstrapReps = 24
    static let bootstrapSeed: UInt32 = 777
    static let stabilityWindowS = 1.0
    /// Minimum evidence before a measured (not precision-qualified) commit.
    enum Commit { static let cells = 12, batches = 3; static let alongM = 0.8, acrossM = 0.4, inlierFraction = 0.6, minSpreadM = 0.1 }
    /// Research consistency gates only; passing them is not a precision claim.
    enum Research { static let cells = 30, batches = 3; static let alongM = 2.0, acrossM = 1.0, inlierFraction = 0.8, residualM = 0.01, stabilityDeg = 0.05, intervalDeg = 0.1 }

    struct Observation {
        /// Point in the calibration reference (anchor) frame.
        var point: Vec3
        var camera: Vec3
        var source: String
        var batch: Int
        var epoch: Int
        var receivedTimestamp: Double
        var captureTimestamp: Double?
        var confidence: Double?
    }

    enum Status: String { case insufficient, measured, research_consistent }

    struct Result {
        var status = Status.insufficient
        var reasons: [String] = []
        var source: String?
        var sourceCells: [String: Int] = [:]
        var normal: Vec3?
        var planeOffset: Double?
        var origin: Vec3?
        var matrix: Mat4?
        var alongRowInclination: Double?
        var crossSlope: Double?
        var slope: Double?
        var observations = 0
        var occupiedCells = 0
        var batches = 0
        var alongExtentM = 0.0
        var acrossExtentM = 0.0
        var inlierFraction = 0.0
        var robustResidualM: Double?
        var rmsResidualM: Double?
        var p95ResidualM: Double?
        var eigenvalues: [Double]?
        var uncertaintyDeg: Double?
        var heldOutDifferenceDeg: Double?
        var stabilityDeg: Double?
        var limitations = [
            "precision unverified: no independent floor or rendered-height measurement",
            "local fit cannot establish that the route beyond the sampled region shares this plane",
        ]

        var dictionary: [String: Any] {
            var d: [String: Any] = [
                "status": status.rawValue, "reasons": reasons, "sourceCells": sourceCells,
                "observations": observations, "occupiedCells": occupiedCells, "batches": batches,
                "alongExtentM": alongExtentM, "acrossExtentM": acrossExtentM, "inlierFraction": inlierFraction,
                "limitations": limitations,
            ]
            d["source"] = source ?? NSNull()
            d["normal"] = normal.map(MatrixMath.vector) ?? NSNull()
            d["planeOffset"] = planeOffset ?? NSNull()
            d["origin"] = origin.map(MatrixMath.vector) ?? NSNull()
            d["matrix"] = matrix.map(MatrixMath.array) ?? NSNull()
            d["alongRowInclination"] = alongRowInclination ?? NSNull()
            d["crossSlope"] = crossSlope ?? NSNull()
            d["slope"] = slope ?? NSNull()
            d["robustResidualM"] = robustResidualM ?? NSNull()
            d["rmsResidualM"] = rmsResidualM ?? NSNull()
            d["p95ResidualM"] = p95ResidualM ?? NSNull()
            d["eigenvalues"] = eigenvalues ?? NSNull()
            d["uncertaintyDeg"] = uncertaintyDeg ?? NSNull()
            d["heldOutDifferenceDeg"] = heldOutDifferenceDeg ?? NSNull()
            d["stabilityDeg"] = stabilityDeg ?? NSNull()
            return d
        }
    }

    /// Deterministic PRNG shared with TypeScript (mulberry32).
    struct Mulberry32 {
        var a: UInt32
        init(seed: UInt32) { a = seed }
        mutating func next() -> Double {
            a = a &+ 0x6D2B79F5
            var t = (a ^ (a >> 15)) &* (1 | a)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double(t ^ (t >> 14)) / 4294967296
        }
    }

    /// Cyclic Jacobi eigen-decomposition of a symmetric 3x3 matrix, ascending.
    static func symmetricEigen(_ input: [[Double]]) -> (values: [Double], vectors: [Vec3]) {
        var A = input
        var V: [[Double]] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        for _ in 0..<50 {
            if A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2] < 1e-30 { break }
            for (p, q) in [(0, 1), (0, 2), (1, 2)] {
                if abs(A[p][q]) < 1e-300 { continue }
                let theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
                let t = (theta >= 0 ? 1.0 : -1.0) / (abs(theta) + (theta * theta + 1).squareRoot())
                let c = 1 / (t * t + 1).squareRoot()
                let s = t * c
                for k in 0..<3 {
                    let akp = A[k][p], akq = A[k][q]
                    A[k][p] = c * akp - s * akq
                    A[k][q] = s * akp + c * akq
                }
                for k in 0..<3 {
                    let apk = A[p][k], aqk = A[q][k]
                    A[p][k] = c * apk - s * aqk
                    A[q][k] = s * apk + c * aqk
                }
                for k in 0..<3 {
                    let vkp = V[k][p], vkq = V[k][q]
                    V[k][p] = c * vkp - s * vkq
                    V[k][q] = s * vkp + c * vkq
                }
            }
        }
        let diagonal: [Double] = [A[0][0], A[1][1], A[2][2]]
        let order = [0, 1, 2].sorted { (i: Int, j: Int) -> Bool in
            diagonal[i] != diagonal[j] ? diagonal[i] < diagonal[j] : i < j
        }
        return (order.map { diagonal[$0] }, order.map { Vec3(V[0][$0], V[1][$0], V[2][$0]) })
    }

    struct PlaneFit { let centroid: Vec3; let normal: Vec3; let eigenvalues: [Double] }

    /// Weighted total-least-squares plane; normal is the smallest-eigenvalue direction, upward.
    static func weightedPlane(_ points: [Vec3], _ weights: [Double], gravityUp: Vec3 = MatrixMath.gravityUp) -> PlaneFit? {
        var total = 0.0
        var centroid = Vec3.zero
        for (p, w) in zip(points, weights) { total += w; centroid += p * w }
        guard points.count >= 3, total > 0 else { return nil }
        centroid /= total
        var C: [[Double]] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
        for (p, w) in zip(points, weights) {
            let d = p - centroid
            for r in 0..<3 { for c in 0..<3 { C[r][c] += w * d[r] * d[c] / total } }
        }
        let eigen = symmetricEigen(C)
        var normal = simd_normalize(eigen.vectors[0])
        if simd_dot(normal, gravityUp) < 0 { normal = -normal }
        guard normal.x.isFinite, normal.y.isFinite, normal.z.isFinite else { return nil }
        return PlaneFit(centroid: centroid, normal: normal, eigenvalues: eigen.values)
    }

    struct Cell { let i: Int; let j: Int; let key: String; var samples: [Observation] }

    static func cells(_ observations: [Observation], origin: Vec3, xAxis: Vec3, zAxis: Vec3) -> [Cell] {
        var cells: [String: Cell] = [:]
        for o in observations {
            let d = o.point - origin
            let i = Int(floor(simd_dot(d, xAxis) / cellSize)), j = Int(floor(simd_dot(d, zAxis) / cellSize))
            let key = "\(i),\(j)"
            cells[key, default: Cell(i: i, j: j, key: key, samples: [])].samples.append(o)
        }
        return cells.values
            .map { Cell(i: $0.i, j: $0.j, key: $0.key, samples: Array($0.samples.suffix(maxPerCell))) }
            .sorted { $0.i != $1.i ? $0.i < $1.i : $0.j < $1.j }
    }

    static func ransac(_ points: [Vec3], gravityUp: Vec3) -> (normal: Vec3, point: Vec3)? {
        var random = Mulberry32(seed: ransacSeed)
        let n = Double(points.count)
        var best: (normal: Vec3, point: Vec3, score: Int)?
        for _ in 0..<ransacIterations {
            let a = Int(floor(random.next() * n)), b = Int(floor(random.next() * n)), c = Int(floor(random.next() * n))
            if a == b || b == c || a == c { continue }
            let raw = simd_cross(points[b] - points[a], points[c] - points[a])
            if simd_length(raw) < 1e-9 { continue }
            var normal = simd_normalize(raw)
            if simd_dot(normal, gravityUp) < 0 { normal = -normal }
            if simd_dot(normal, gravityUp) <= 0.5 { continue }
            let score = points.filter { abs(simd_dot(normal, $0 - points[a])) <= inlierThreshold }.count
            if best == nil || score > best!.score { best = (normal, points[a], score) }
        }
        return best.map { ($0.normal, $0.point) }
    }

    static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }

    static func fit(observations: [Observation], origin: Vec3, heading: Vec3,
                    gravityUp: Vec3 = MatrixMath.gravityUp, epoch: Int, recentInclinations: [Double] = []) -> Result {
        let g = simd_normalize(gravityUp)
        let zAxis = simd_normalize(heading - g * simd_dot(heading, g))
        let xAxis = simd_normalize(simd_cross(g, zAxis))
        var result = Result()
        let valid = observations.filter { o in
            let values = [o.point.x, o.point.y, o.point.z, o.camera.x, o.camera.y, o.camera.z]
            guard o.epoch == epoch, values.allSatisfy(\.isFinite) else { return false }
            let range = simd_distance(o.point, o.camera)
            return range >= minRange && range <= maxRange && simd_dot(o.camera - o.point, g) > minBelowCamera
        }
        // Keep source-specific groups; never blend sources as equally accurate.
        var bySource: [String: [Observation]] = [:]
        for o in valid { bySource[o.source, default: []].append(o) }
        var chosen: String?
        for source in bySource.keys.sorted() {
            let count = cells(bySource[source]!, origin: origin, xAxis: xAxis, zAxis: zAxis).count
            result.sourceCells[source] = count
            if chosen == nil || count > result.sourceCells[chosen!]! { chosen = source }
        }
        guard let chosen else { result.reasons.append("no valid floor samples"); return result }
        result.source = chosen
        let grid = cells(bySource[chosen]!, origin: origin, xAxis: xAxis, zAxis: zAxis)
        let means = grid.map { cell in cell.samples.reduce(Vec3.zero) { $0 + $1.point } / Double(cell.samples.count) }
        guard means.count >= 3, let consensus = ransac(means, gravityUp: g) else {
            result.reasons.append("no floor-plane consensus"); return result
        }
        struct Sample { let o: Observation; let cell: Cell; let weight: Double }
        let samples = grid.flatMap { cell in cell.samples.map { Sample(o: $0, cell: cell, weight: 1 / Double(cell.samples.count)) } }
        let totalWeight = samples.reduce(0) { $0 + $1.weight }
        var plane: PlaneFit?
        var inliers = samples.filter { abs(simd_dot(consensus.normal, $0.o.point - consensus.point)) <= inlierThreshold }
        for _ in 0..<2 {
            plane = weightedPlane(inliers.map(\.o.point), inliers.map(\.weight), gravityUp: g)
            guard let fitted = plane else { break }
            inliers = samples.filter { abs(simd_dot(fitted.normal, $0.o.point - fitted.centroid)) <= inlierThreshold }
        }
        guard let plane, inliers.count >= 3, simd_dot(plane.normal, g) > 0.5 else {
            result.reasons.append("plane refinement failed or surface too steep"); return result
        }
        let normal = plane.normal, centroid = plane.centroid
        var inlierCells: [String: Cell] = [:]
        for s in inliers { inlierCells[s.cell.key] = s.cell }
        let iValues = inlierCells.values.map(\.i), jValues = inlierCells.values.map(\.j)
        let residuals = inliers.map { simd_dot(normal, $0.o.point - centroid) }
        let absolute = residuals.map(abs).sorted()
        let inlierWeight = inliers.reduce(0) { $0 + $1.weight }
        let shift = simd_dot(normal, centroid - origin) / simd_dot(normal, g)
        let fittedOrigin = origin + g * shift
        let frame = SurfacePose.rowFrame(origin: fittedOrigin, normal: normal, heading: heading, gravityUp: g)
        result.normal = normal
        result.planeOffset = -simd_dot(normal, centroid)
        result.origin = fittedOrigin
        result.matrix = frame?.matrix
        result.alongRowInclination = frame?.alongRowInclination
        result.crossSlope = frame?.crossSlope
        result.slope = acos(min(1, simd_dot(normal, g))) * 180 / .pi
        result.observations = samples.count
        result.occupiedCells = inlierCells.count
        result.batches = Set(inliers.map(\.o.batch)).count
        result.alongExtentM = Double(iValues.max()! - iValues.min()! + 1) * cellSize
        result.acrossExtentM = Double(jValues.max()! - jValues.min()! + 1) * cellSize
        result.inlierFraction = inlierWeight / totalWeight
        result.robustResidualM = 1.4826 * median(absolute)
        result.rmsResidualM = (zip(inliers, residuals).reduce(0) { $0 + $1.0.weight * $1.1 * $1.1 } / inlierWeight).squareRoot()
        result.p95ResidualM = absolute[Int(floor(0.95 * Double(absolute.count - 1)))]
        result.eigenvalues = plane.eigenvalues
        func inclination(_ fit: PlaneFit?) -> Double? {
            guard let fit else { return nil }
            return SurfacePose.rowFrame(origin: fittedOrigin, normal: fit.normal, heading: heading, gravityUp: g)?.alongRowInclination
        }
        // Frame-block bootstrap: resample whole batches, not neighbouring pixels.
        let batches = Array(Set(inliers.map(\.o.batch))).sorted()
        if batches.count >= 3 {
            var random = Mulberry32(seed: bootstrapSeed)
            var values: [Double] = []
            for _ in 0..<bootstrapReps {
                let draw = batches.map { _ in batches[Int(floor(random.next() * Double(batches.count)))] }
                let chosenSamples = draw.flatMap { batch in inliers.filter { $0.o.batch == batch } }
                if let value = inclination(weightedPlane(chosenSamples.map(\.o.point), chosenSamples.map(\.weight), gravityUp: g)) {
                    values.append(value)
                }
            }
            if values.count >= 2 {
                let mean = values.reduce(0, +) / Double(values.count)
                result.uncertaintyDeg = 1.96 * (values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count)).squareRoot()
            }
        }
        // Held-out spatial cells: checkerboard halves must agree.
        let halves = [0, 1].map { parity in inliers.filter { abs($0.cell.i + $0.cell.j) % 2 == parity } }
        if halves.allSatisfy({ Set($0.map(\.cell.key)).count >= 3 }) {
            let values = halves.map { half in inclination(weightedPlane(half.map(\.o.point), half.map(\.weight), gravityUp: g)) }
            if let a = values[0], let b = values[1] { result.heldOutDifferenceDeg = abs(a - b) }
        }
        if let current = result.alongRowInclination, !recentInclinations.isEmpty {
            let all = recentInclinations + [current]
            result.stabilityDeg = all.max()! - all.min()!
        }
        let spread = max(0, plane.eigenvalues[1]).squareRoot()
        if frame == nil { result.reasons.append("row orientation undefined on this plane") }
        if result.occupiedCells < Commit.cells { result.reasons.append("cells \(result.occupiedCells)/\(Commit.cells)") }
        if result.batches < Commit.batches { result.reasons.append("batches \(result.batches)/\(Commit.batches)") }
        if result.alongExtentM < Commit.alongM { result.reasons.append(String(format: "along %.1f/%g m", result.alongExtentM, Commit.alongM)) }
        if result.acrossExtentM < Commit.acrossM { result.reasons.append(String(format: "across %.1f/%g m", result.acrossExtentM, Commit.acrossM)) }
        if result.inlierFraction < Commit.inlierFraction { result.reasons.append(String(format: "inliers %.0f%%", result.inlierFraction * 100)) }
        if spread < Commit.minSpreadM { result.reasons.append("near-collinear support") }
        guard result.reasons.isEmpty else { return result }
        let research = result.occupiedCells >= Research.cells && result.batches >= Research.batches
            && result.alongExtentM >= Research.alongM && result.acrossExtentM >= Research.acrossM
            && result.inlierFraction >= Research.inlierFraction && (result.robustResidualM ?? .infinity) <= Research.residualM
            && (result.stabilityDeg.map { $0 <= Research.stabilityDeg } ?? false)
            && (result.uncertaintyDeg.map { $0 <= Research.intervalDeg } ?? false)
        result.status = research ? .research_consistent : .measured
        return result
    }
}
