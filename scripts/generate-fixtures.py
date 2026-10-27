#!/usr/bin/env python3
"""Generate shared Swift/TypeScript fixtures in Tests/fixtures.

Expected values come from ground truth (known planes, poses and closed-form
formulas) computed here independently of either app implementation. Units:
metres and degrees. Axes: right-handed, +Y gravity-up. Matrices: 16 numbers,
column-major.
"""
import json
import math
import os
import random

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Tests", "fixtures")
DEG = 180 / math.pi


def dot(a, b): return sum(x * y for x, y in zip(a, b))
def sub(a, b): return [x - y for x, y in zip(a, b)]
def addv(a, b): return [x + y for x, y in zip(a, b)]
def mul(a, s): return [x * s for x in a]
def norm(a): return math.sqrt(dot(a, a))
def unit(a): return mul(a, 1 / norm(a))
def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def mat(x, y, z, p): return [*x, 0, *y, 0, *z, 0, *p, 1]
def col(m, c): return m[4 * c:4 * c + 3]


def mmul(a, b):
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def inv_rigid(m):
    x, y, z, p = col(m, 0), col(m, 1), col(m, 2), col(m, 3)
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, p), -dot(y, p), -dot(z, p), 1]


def apply(m, p): return [m[12 + r] + m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] for r in range(3)]


def rot_axis(axis, deg, p=(0, 0, 0)):
    a = unit(axis)
    t = deg / DEG
    c, s = math.cos(t), math.sin(t)
    x, y, z = a
    r = [[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
         [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
         [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]]
    return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, *p, 1]


def rnd(v, digits=12):
    if isinstance(v, list): return [rnd(x, digits) for x in v]
    if isinstance(v, dict): return {k: rnd(x, digits) for k, x in v.items()}
    if isinstance(v, float): return round(v, digits)
    return v


def write(name, data):
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, name), "w") as f:
        json.dump(rnd(data), f, indent=1)
        f.write("\n")


G = [0.0, 1.0, 0.0]


# Plan section 3, written directly from the specification.
def row_frame(origin, normal, heading, g=G):
    n = unit(normal)
    if dot(n, g) < 0: n = mul(n, -1)
    zh = unit(sub(heading, mul(g, dot(heading, g))))
    xh = unit(cross(g, zh))
    x = unit(sub(xh, mul(g, dot(n, xh) / dot(n, g))))
    z = unit(cross(x, n))
    def incline(a): return math.atan2(dot(a, g), norm(sub(a, mul(g, dot(a, g))))) * DEG
    return {"x": x, "y": n, "z": z, "alongRowInclination": incline(x), "crossSlope": incline(z), "matrix": mat(x, n, z, origin)}


def mulberry32(seed):
    a = seed & 0xFFFFFFFF
    def f():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return f


def prng():
    r = mulberry32(12345)
    write("prng.json", {"seed": 12345, "values": [r() for _ in range(8)]})


def yaw():
    cases = []
    for name, position, normal, camera in [
        ("level floor", [0, 0, 0], [0, 1, 0], [0, 1.6, 2]),
        ("level floor, viewer to the side", [0, 0, 0], [0, 1, 0], [2, 1.6, 0]),
        ("pitched toward viewer", [0, 0, 0], [0, 0.866025403784, 0.5], [0, 1.6, 2]),
        ("pitched along row", [0, 0, 0], [math.sin(5 / DEG), math.cos(5 / DEG), 0], [0, 1.6, 2]),
        ("compound incline", [1, -0.2, -1], [0.3, 0.9, 0.2], [-2, 1.6, 2]),
        ("compound incline, oblique viewer", [0, 0, 0], [-0.1, 0.95, 0.25], [1.5, 1.4, 2.5]),
    ]:
        heading = unit(sub(sub(camera, position), mul(G, dot(sub(camera, position), G))))
        frame = row_frame(position, normal, heading)
        cases.append({"name": name, "position": position, "normal": normal, "camera": camera,
                      "heading": heading, **frame})
    rejects = [
        {"name": "wall", "position": [0, 0, 0], "normal": [0, 0, 1], "camera": [0, 1.6, 2]},
        {"name": "overhead", "position": [0, 0, 0], "normal": [0, 1, 0], "camera": [0, -1, 2]},
        {"name": "beyond 8 m", "position": [0, 0, 0], "normal": [0, 1, 0], "camera": [0, 1.6, 10]},
        {"name": "camera directly above", "position": [0, 0, 0], "normal": [0, 1, 0], "camera": [0, 1.6, 0]},
        {"name": "zero normal", "position": [0, 0, 0], "normal": [0, 0, 0], "camera": [0, 1.6, 2]},
    ]
    write("yaw_cases.json", {"tolerance": 1e-9, "cases": cases, "rejects": rejects})


def floor_point(normal, d, x, z):
    # Solve n.(x, y, z) + d = 0 for y.
    return [x, -(normal[0] * x + normal[2] * z + d) / normal[1], z]


def plane_case(name, rnd_seed, along_deg, cross_deg, noise, outlier_fraction=0.0, batches=6, per_batch=25,
               region=(-1.6, 1.6, -1.4, -0.1), patch=None, step=None, bias=None, collinear=False,
               stale_batches=0, expect=None, note=""):
    rng = random.Random(rnd_seed)
    # Normal from along-row (X) and cross (Z) inclinations.
    tx, tz = math.tan(along_deg / DEG), math.tan(cross_deg / DEG)
    normal = unit([-tx, 1, -tz])
    d = 0.0
    obs = []
    camera = [0.0, 1.5, 1.2]
    for b in range(1, batches + 1 + stale_batches):
        stale = b > batches
        cam = [camera[0] + rng.uniform(-0.6, 0.6), camera[1], camera[2] + rng.uniform(-0.2, 0.2)]
        for _ in range(per_batch):
            if collinear:
                x, z = rng.uniform(region[0], region[1]), -0.6 + rng.gauss(0, 0.005)
            elif patch and rng.random() < patch["fraction"]:
                x, z = rng.uniform(*patch["x"]), rng.uniform(*patch["z"])
            else:
                x, z = rng.uniform(region[0], region[1]), rng.uniform(region[2], region[3])
            p = floor_point(normal, d, x, z)
            if step and x > step["x"]:
                p[1] += step["height"]
            p[1] += rng.gauss(0, noise)
            source = "estimatedPlane"
            if bias and rng.random() < bias["fraction"]:
                source = "DepthPoint"
                p[1] += bias["offset"]
            if rng.random() < outlier_fraction:
                p[1] += rng.choice([-1, 1]) * rng.uniform(0.08, 0.4)
            obs.append({"point": p, "camera": cam, "source": source, "batch": b,
                        "epoch": 7 if stale else 3, "receivedTimestamp": b * 0.4})
    return {"name": name, "note": note, "origin": floor_point(normal, d, 0, 0), "heading": [0, 0, 1],
            "gravityUp": G, "epoch": 3, "observations": obs,
            "trueNormal": normal, "trueAlongRowInclination": row_frame([0, 0, 0], normal, [0, 0, 1])["alongRowInclination"],
            "expect": expect}


def plane_fit():
    cases = [
        plane_case("level floor", 1, 0, 0, 0.002, expect={"status": ["measured", "research_consistent"], "normalToleranceDeg": 0.15}),
        plane_case("pitched along row with gross outliers", 2, 3, 0, 0.003, outlier_fraction=0.1,
                   expect={"status": ["measured", "research_consistent"], "normalToleranceDeg": 0.2}),
        plane_case("compound incline, uneven sampling", 3, 2, -4, 0.003, batches=8,
                   patch={"fraction": 0.7, "x": (-0.2, 0.2), "z": (-0.5, -0.3)},
                   expect={"status": ["measured", "research_consistent"], "normalToleranceDeg": 0.3}),
        plane_case("depth discontinuity (15 cm step)", 4, 1, 0, 0.002, step={"x": 1.0, "height": 0.15},
                   expect={"status": ["measured", "research_consistent"], "normalToleranceDeg": 0.2}),
        plane_case("biased minority source is not blended", 5, 2, 1, 0.002,
                   bias={"fraction": 0.3, "offset": 0.04},
                   expect={"status": ["measured", "research_consistent"], "normalToleranceDeg": 0.2, "source": "estimatedPlane"}),
        plane_case("collinear support", 6, 0, 0, 0.002, collinear=True,
                   expect={"status": ["insufficient"]}),
        plane_case("too few batches", 7, 0, 0, 0.002, batches=2, expect={"status": ["insufficient"]}),
        plane_case("stale epoch samples ignored", 8, 2, 0, 0.002, batches=6, stale_batches=4,
                   expect={"status": ["measured", "research_consistent"], "normalToleranceDeg": 0.2, "batches": 6}),
    ]
    # A low-residual fit of a biased sensor: the gate cannot see absolute bias.
    biased = plane_case("low-residual biased fixture", 9, 0.3, 0, 0.001,
                        expect={"status": ["measured", "research_consistent"], "normalToleranceDeg": 0.1})
    biased["note"] = "Samples come from a floor tilted 0.3 deg; the physical floor is level. Passing gates is not truth."
    biased["physicalAlongRowInclination"] = 0.0
    cases.append(biased)
    write("plane_fit_cases.json", {"cases": cases})


def radius(width, count):
    offsets = [0 if i == 0 else (-1 if i % 2 else 1) * ((i + 1) // 2) * width for i in range(count)]
    best = 0
    for x in (min(offsets) - width / 2, max(offsets) + width / 2):
        for y in (0.001, width * 0.5 + 0.001):
            for z in (-width * 0.45, 0):
                best = max(best, math.sqrt(x * x + y * y + z * z))
    return best


def budget():
    cases = []
    for width, count in [(3, 11), (3, 15), (0.2, 51), (0.2, 11), (3, 1), (3, 51)]:
        r = radius(width, count)
        vertical = 0.02 if width >= 1 else 0.005
        cases.append({"width": width, "count": count, "radiusM": r, "verticalLimitM": vertical,
                      "verticalAngleAllowanceDeg": 2 * math.asin(min(1, vertical / 2 / (2 * r))) * DEG,
                      "horizontalRotationAllowanceDeg": 2 * math.asin(min(1, 0.05 / (2 * r))) * DEG})
    displacement = [{"errorDeg": e, "radiusM": 20, "displacementM": 2 * 20 * math.sin(e / DEG / 2)} for e in (0.05, 0.1, 0.25, 0.5, 1.0)]
    write("budget_cases.json", {"cases": cases, "displacement": displacement})


def height():
    base = mmul(rot_axis([0, 1, 0], 30, [1, 0.2, -2]), rot_axis([1, 0, 0], 2))
    n = col(base, 1)
    origin = col(base, 3)

    def floor_obs(local_x, height_m, cycle, source="estimatedPlane", miss=0.05, normal=None):
        p = apply(base, [local_x, 0, -0.3])
        p = addv(p, [0, height_m, 0])
        o = {"point": p, "source": source, "targetMissM": miss, "cycle": cycle}
        if normal is not None: o["normal"] = normal
        return o

    expected_residual = 0.03  # +Y offset of 3 cm along gravity
    steps = []
    t = 0.0
    applied = 0.0
    window = []
    for cycle in range(1, 6):
        t += 1.0
        obs = [floor_obs(x, 0.03, cycle, normal=n) for x in (-2, 0, 2)]
        obs.append(floor_obs(0, 0.03, cycle, source="FeaturePoint"))
        obs.append(floor_obs(1, 0.03, cycle, miss=0.9))
        obs.append(floor_obs(1, 0.03, cycle, normal=[0, 0, 1]))
        window = [w for w in window if t - w[0] <= 3] + [(t, expected_residual, cycle) for _ in range(3)]
        cycles = len({w[2] for w in window})
        proposed = expected_residual if len(window) >= 3 and cycles >= 2 else None
        dt = 0 if cycle == 1 else 1.0
        if proposed is not None and abs(proposed - applied) >= 0.005:
            applied += max(-0.02 * dt, min(0.02 * dt, proposed - applied))
        steps.append({"time": t, "observations": obs, "apply": True,
                      "expectedResidualCount": 3, "expectedRejected": 3,
                      "expectedProposedM": proposed, "expectedAppliedM": applied})
    write("height_correction_cases.json", {
        "base": base, "gravityUp": G, "residualForPointAbove": {"point": addv(origin, [0, 0.03, 0]), "expectedM": 0.03 / dot(n, G) * dot(n, G)},
        "steps": steps,
        "note": "A pure +Y offset h of a floor point gives gravity residual h on any pitched plane.",
    })


def survey_reference(rid, matrix, role="correction", pos_u=0.002, rot_u=0.1):
    return {"id": rid, "image": {"asset": f"board-{rid}.png"}, "physicalWidthM": 0.4, "physicalHeightM": 0.3,
            "surveyFromMarker": matrix, "uncertainty": {"positionM": pos_u, "rotationDeg": rot_u, "confidence": "95%"},
            "role": role}


def base_manifest():
    upright = mmul(rot_axis([0, 1, 0], 0, [0, 0.5, -1]), rot_axis([1, 0, 0], 90))
    tilt = math.tan(1.5 / DEG)
    floor = [[x, x * tilt, z] for x in (-3, 0, 3, 6, 9) for z in (-1.5, 0, 1.5)]
    return {
        "schema": "floorframe.survey/1", "surveyId": "fixture-route", "revision": 2, "units": "m",
        "convention": {"handedness": "right", "up": "+Y", "matrixLayout": "column-major"},
        "validRouteExtentM": 25,
        "references": [
            survey_reference("A", upright),
            survey_reference("B", mmul(rot_axis([0, 1, 0], -20, [4, 0.6, -1.2]), rot_axis([1, 0, 0], 90))),
            survey_reference("C", mmul(rot_axis([0, 1, 0], 15, [8, 0.7, -1.0]), rot_axis([1, 0, 0], 90))),
            survey_reference("V", mmul(rot_axis([0, 1, 0], 5, [2, 0.6, 1.5]), rot_axis([1, 0, 0], 90)), role="heldOutValidation"),
        ],
        "floorControl": {"points": floor, "uncertaintyM": 0.001, "confidence": "95%"},
    }


def survey():
    good = base_manifest()
    cases = [{"name": "valid", "manifest": good, "ok": True,
              "floorNormal": unit([-math.tan(1.5 / DEG), 1, 0])}]

    def variant(name, error, mutate):
        m = json.loads(json.dumps(good))
        mutate(m)
        cases.append({"name": name, "manifest": m, "ok": False, "error": error})

    variant("wrong units", "units", lambda m: m.__setitem__("units", "cm"))
    variant("left-handed", "convention", lambda m: m["convention"].__setitem__("handedness", "left"))
    variant("duplicate id", "references[1].duplicateId", lambda m: m["references"][1].__setitem__("id", "A"))
    variant("reflected transform", "references[0].surveyFromMarker",
            lambda m: m["references"][0].__setitem__("surveyFromMarker", [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
    variant("scaled transform", "references[0].surveyFromMarker",
            lambda m: m["references"][0].__setitem__("surveyFromMarker", [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]))
    variant("missing print size", "references[2].physicalWidthM", lambda m: m["references"][2].pop("physicalWidthM"))
    variant("invalid uncertainty", "references[0].uncertainty", lambda m: m["references"][0]["uncertainty"].__setitem__("positionM", 0))
    variant("bad role", "references[0].role", lambda m: m["references"][0].__setitem__("role", "both"))
    variant("no correction boards", "noCorrectionReference", lambda m: [r.__setitem__("role", "heldOutValidation") for r in m["references"]])
    variant("stale schema", "schema", lambda m: m.__setitem__("schema", "floorframe.survey/0"))
    variant("non-planar floor control", "floorControl.nonPlanar",
            lambda m: m["floorControl"].__setitem__("points", [[x, (0.08 if (i % 2) else 0), z] for i, (x, _, z) in enumerate(m["floorControl"]["points"])]))
    variant("collinear floor control", "floorControl.collinear",
            lambda m: m["floorControl"].__setitem__("points", [[x, 0, 0] for x in range(5)]))
    write("survey_manifests.json", {"cases": cases})

    # Fusion: a known world-from-survey transform.
    world_from_survey = rot_axis([0.1, 1, 0.05], 37, [2.5, -0.4, 1.2])
    refs = {r["id"]: r for r in good["references"]}

    def observe(rid, offset=(0, 0, 0), deg=0.0, t=10.0, epoch=1, tracking=True):
        w = mmul(world_from_survey, refs[rid]["surveyFromMarker"])
        w = mmul(rot_axis([0, 1, 0], deg, offset), w) if deg or any(offset) else w
        return {"id": rid, "worldFromMarker": w, "timestamp": t, "epoch": epoch, "tracking": tracking}

    fusion_cases = [
        {"name": "single exact board", "observations": [observe("A")], "now": 10.1, "epoch": 1,
         "expected": world_from_survey, "used": ["A"], "observability": "single-board", "toleranceM": 1e-9, "toleranceDeg": 1e-6},
        {"name": "three exact boards", "observations": [observe("A"), observe("B"), observe("C")], "now": 10.1, "epoch": 1,
         "expected": world_from_survey, "used": ["A", "B", "C"], "observability": "multi-board", "toleranceM": 1e-9, "toleranceDeg": 1e-6},
        {"name": "outlier board rejected", "observations": [observe("A"), observe("B", offset=(0.4, 0, 0)), observe("C")], "now": 10.1, "epoch": 1,
         "expected": world_from_survey, "used": ["A", "C"], "rejected": ["B"], "observability": "multi-board", "toleranceM": 1e-9, "toleranceDeg": 1e-6},
        {"name": "stale, wrong epoch, not tracking and unknown ids rejected",
         "observations": [observe("A", t=9.0), observe("B", epoch=0), observe("C", tracking=False),
                          {"id": "Z", "worldFromMarker": world_from_survey, "timestamp": 10, "epoch": 1, "tracking": True}],
         "now": 10.1, "epoch": 1, "expected": None, "used": [], "rejected": ["A", "B", "C", "Z"], "observability": "none"},
        {"name": "two disagreeing boards give no pose", "observations": [observe("A"), observe("B", offset=(0, 0.3, 0))], "now": 10.1, "epoch": 1,
         "expected": None, "used": [], "rejected": ["A", "B"], "observability": "none"},
        {"name": "repeated callbacks from one board count once",
         "observations": [observe("A", t=9.9), observe("A", t=10.0), observe("A", t=10.05)], "now": 10.1, "epoch": 1,
         "expected": world_from_survey, "used": ["A"], "observability": "single-board", "toleranceM": 1e-9, "toleranceDeg": 1e-6},
        {"name": "held-out board reports validation only",
         "observations": [observe("A"), observe("V", offset=(0.01, 0, 0))], "now": 10.1, "epoch": 1,
         "expected": world_from_survey, "used": ["A"], "observability": "single-board", "toleranceM": 1e-9, "toleranceDeg": 1e-6,
         "validation": {"V": 0.01}},
    ]
    write("fusion_cases.json", {"manifest": good, "worldFromSurvey": world_from_survey, "cases": fusion_cases})


def transport():
    # Hit pose and the actual created anchor differ (Viro baseline mismatch).
    hit = rot_axis([0, 1, 0], 12, [1, -1.4, -2])
    anchor = mmul(rot_axis([0.2, 1, 0], 14, [1.03, -1.39, -2.05]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    placed = row_frame([1, -1.4, -2], [0.05, 1, 0.02], [0.3, 0, 1])["matrix"]
    reference_from_row = mmul(inv_rigid(anchor), placed)
    updates = [rot_axis([0.1, 1, 0.1], 15, [1.1, -1.35, -2.0]), rot_axis([0, 1, 0.2], 13, [0.95, -1.42, -2.1])]
    rendered = [mmul(u, reference_from_row) for u in updates]
    # A quaternion [x, y, z, w] for the anchor, as Viro iOS returns it.
    q = quaternion(anchor)
    write("transport_cases.json", {
        "hit": hit, "anchor": anchor, "anchorPosition": col(anchor, 3), "anchorQuaternion": q,
        "placed": placed, "referenceFromRow": reference_from_row, "updates": updates, "rendered": rendered,
        "naiveFirstRender": mmul(mmul(anchor, inv_rigid(hit)), placed),
        "note": "First render must equal placed; using the hit as baseline makes it jump.",
    })


def quaternion(m):
    m00, m10, m20, m01, m11, m21, m02, m12, m22 = m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]
    w = math.sqrt(max(0, 1 + m00 + m11 + m22)) / 2
    x = (m21 - m12) / (4 * w)
    y = (m02 - m20) / (4 * w)
    z = (m10 - m01) / (4 * w)
    return [x, y, z, w]


if __name__ == "__main__":
    prng()
    yaw()
    plane_fit()
    budget()
    height()
    survey()
    transport()
    print("fixtures written to", os.path.normpath(ROOT))
