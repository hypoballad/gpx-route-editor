import argparse
import hashlib
import json
import shutil
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "data/source.json").read_text(encoding="utf-8"))


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for item in CONFIG["files"]:
        destination = directory / item["name"]
        expected = item["sha256"]
        if destination.exists():
            if sha256(destination) == expected:
                print(f"Verified {destination}")
                continue
            raise ValueError(f"{destination} exists with a different SHA-256")
        temporary = destination.with_suffix(".part")
        try:
            with urlopen(CONFIG["upstream"] + item["name"], timeout=60) as response:
                with temporary.open("wb") as stream:
                    shutil.copyfileobj(response, stream, length=1024 * 1024)
            if sha256(temporary) != expected:
                raise ValueError(f"{item['name']} has moved past the pinned snapshot; supply the matching local PBF")
            temporary.replace(destination)
            print(f"Stored {destination}")
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path, nargs="?", default=ROOT / ".data")
    main(parser.parse_args().directory)
