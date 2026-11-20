import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import osmium
from references import verify_clipped_nodes

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "data/source.json").read_text(encoding="utf-8"))
HIGHWAYS = {
    "path", "footway", "steps", "track", "pedestrian", "bridleway", "service",
    "residential", "living_street", "unclassified", "tertiary", "secondary", "primary",
}
NODE_TAGS = {"barrier", "locked", "foot", "access", "foot:conditional", "access:conditional"}


def expanded_bounds():
    bounds = CONFIG["bounds"]
    latitude = CONFIG["bufferMeters"] / 111000
    longitude = latitude / math.cos(math.radians(bounds["north"] + latitude))
    return {
        "west": bounds["west"] - longitude, "south": bounds["south"] - latitude,
        "east": bounds["east"] + longitude, "north": bounds["north"] + latitude,
    }


class Nodes(osmium.SimpleHandler):
    def __init__(self, bounds):
        super().__init__()
        self.bounds = bounds
        self.positions = {}
        self.tagged = {}

    def node(self, node):
        location = node.location
        lon, lat = location.lon, location.lat
        if not (self.bounds["west"] <= lon <= self.bounds["east"]
                and self.bounds["south"] <= lat <= self.bounds["north"]):
            return
        node_id = node.id
        if node_id in self.positions:
            if self.positions[node_id] != (lon, lat):
                raise ValueError(f"Coordinate conflict for OSM node {node_id}")
            return
        self.positions[node_id] = (lon, lat)
        selected = {tag.k: tag.v for tag in node.tags if tag.k in NODE_TAGS}
        if selected:
            self.tagged[node_id] = selected


class Ways(osmium.SimpleHandler):
    def __init__(self, positions):
        super().__init__()
        self.positions = positions
        self.ways = {}
        self.seen_nodes = set()

    def way(self, way):
        if way.tags.get("highway") not in HIGHWAYS:
            return
        refs = [node.ref for node in way.nodes]
        positions = self.positions
        if not any(a in positions and b in positions for a, b in zip(refs, refs[1:])):
            return
        record = (refs, dict(way.tags))
        if way.id in self.ways and self.ways[way.id] != record:
            raise ValueError(f"Definition conflict for OSM way {way.id}")
        self.ways[way.id] = record
        self.seen_nodes.update(ref for ref in refs if ref in positions)


def main(paths, output):
    sources = []
    for path, expected in zip(paths, CONFIG["files"], strict=True):
        with path.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        if checksum != expected["sha256"]:
            raise ValueError(f"Unexpected SHA-256 for {path}; use the pinned snapshot")
        with osmium.io.Reader(str(path), osmium.osm.NOTHING) as reader:
            timestamp = reader.header().get("osmosis_replication_timestamp")
        if timestamp != CONFIG["timestamp"]:
            raise ValueError(f"Unexpected replication version in {path}")
        sources.append({"file": expected["name"], "sha256": checksum, "replicationTimestamp": timestamp})

    bounds = expanded_bounds()
    nodes = Nodes(bounds)
    for path in paths:
        print(f"Reading nodes: {path.name}", file=sys.stderr, flush=True)
        nodes.apply_file(str(path))
    ways = Ways(nodes.positions)
    for path in paths:
        print(f"Reading ways: {path.name}", file=sys.stderr, flush=True)
        ways.apply_file(str(path))

    elements = []
    clipped_nodes = set()
    for way_id, (refs, tags) in sorted(ways.ways.items()):
        geometry = []
        for ref in refs:
            point = nodes.positions.get(ref)
            if point is None:
                clipped_nodes.add(ref)
            geometry.append({"lon": point[0], "lat": point[1]} if point else None)
        elements.append({"type": "way", "id": way_id, "nodes": refs, "geometry": geometry, "tags": tags})
    for node_id in sorted(ways.seen_nodes & nodes.tagged.keys()):
        elements.append({"type": "node", "id": node_id, "tags": nodes.tagged[node_id]})
    verified = verify_clipped_nodes(clipped_nodes, bounds, paths)
    print(f"Verified {verified} references omitted only at the bounds", file=sys.stderr)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump({"sources": sources, "graphBounds": bounds, "elements": elements},
                  stream, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("kanto", type=Path)
    parser.add_argument("chubu", type=Path)
    args = parser.parse_args()
    main([args.kanto, args.chubu], args.output)
