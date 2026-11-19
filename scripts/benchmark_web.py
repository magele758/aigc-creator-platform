"""Measure interactive HTTP latency and bytes against the running app, without changing projects."""

import argparse
import json
import math
import statistics
import time
from pathlib import Path
from urllib.request import urlopen


def sample(base, path, count):
    elapsed = []
    for _ in range(count + 1):
        start = time.perf_counter()
        with urlopen(base + path, timeout=20) as response:
            data = response.read()
        elapsed.append(1000 * (time.perf_counter() - start))
    ordered = sorted(elapsed[1:])
    return {
        "sampleCount": count,
        "bytes": len(data),
        "p50Ms": round(statistics.median(ordered), 2),
        "p95Ms": round(ordered[math.ceil(0.95 * count) - 1], 2),
        "coldSampleMs": round(elapsed[0], 2),
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base", default="http://127.0.0.1:4327")
    p.add_argument("--count", type=int, default=50)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    if a.count < 5:
        p.error("use at least five samples")
    projects = json.load(urlopen(a.base + "/api/projects?summary=1", timeout=20))["projects"]
    result = {
        "projects": len(projects),
        "directory": sample(a.base, "/api/projects?summary=1", a.count),
        "jobs": sample(a.base, "/api/jobs", a.count),
        "page": sample(a.base, "/", a.count),
    }
    if projects:
        result["oneProject"] = sample(a.base, "/api/projects/" + projects[0]["id"], a.count)
    a.output.parent.mkdir(exist_ok=True, parents=True)
    a.output.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
