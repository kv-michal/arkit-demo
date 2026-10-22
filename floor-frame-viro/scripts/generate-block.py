"""Unit-width rounded cuboid; scales uniformly for both sizes."""
from math import sqrt
from pathlib import Path
out = []
index = 1
half = [.5, .25, .225]
radius = .075  # height * 0.15, matching RealityKit's cornerRadius
segments = 12
for axis in range(3):
    for side in [-1, 1]:
        u, v = (axis+1) % 3, (axis+2) % 3
        grid = []
        for j in range(segments+1):
            row = []
            for i in range(segments+1):
                p = [0., 0., 0.]
                p[axis] = half[axis]*side
                p[u] = half[u]*(2*i/segments-1)
                p[v] = half[v]*(2*j/segments-1)
                c = [max(-half[k]+radius, min(half[k]-radius, p[k])) for k in range(3)]
                n = [p[k]-c[k] for k in range(3)]
                magnitude = sqrt(sum(t*t for t in n))
                n = [t/magnitude for t in n]
                p = [c[k]+radius*n[k] for k in range(3)]
                out.extend(['v '+' '.join(map(str, p)), 'vn '+' '.join(map(str, n))])
                row.append(index)
                index += 1
            grid.append(row)
        for j in range(segments):
            for i in range(segments):
                a, b, c, d = grid[j][i], grid[j][i+1], grid[j+1][i+1], grid[j+1][i]
                faces = [(a,b,c), (a,c,d)] if side == 1 else [(a,c,b), (a,d,c)]
                for face in faces:
                    out.append('f '+' '.join(f'{n}//{n}' for n in face))
Path(__file__).resolve().parents[1].joinpath('assets/block.obj').write_text('\n'.join(out)+'\n')
