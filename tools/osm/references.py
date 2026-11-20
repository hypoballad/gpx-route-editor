import argparse
import json
from pathlib import Path

import osmium


def verify_clipped_nodes(references, bounds, paths):
    remaining = set(references)
    for path in paths:
        if not remaining:
            break
        selected = osmium.filter.IdFilter(remaining)
        reader = osmium.FileProcessor(str(path), osmium.osm.NODE).with_filter(selected)
        for node in reader:
            lon, lat = node.location.lon, node.location.lat
            if bounds["west"] <= lon <= bounds["east"] and bounds["south"] <= lat <= bounds["north"]:
                raise ValueError(f"In-bounds OSM node {node.id} is missing from the extract")
            remaining.discard(node.id)
    if remaining:
        raise ValueError(f"{len(remaining)} unresolved PBF references; examples: {sorted(remaining)[:10]}")
    return len(references)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("pbf", type=Path, nargs=2)
    args = parser.parse_args()
    graph = json.loads(args.input.read_text(encoding="utf-8"))
    clipped_nodes = {
        node for way in graph["elements"] if way["type"] == "way"
        for node, geometry in zip(way["nodes"], way["geometry"], strict=True)
        if geometry is None
    }
    verified = verify_clipped_nodes(clipped_nodes, graph["graphBounds"], args.pbf)
    print(f"Verified {verified} references omitted only at the bounds")
