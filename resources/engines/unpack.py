"""Extract only regular files under a reviewed archive prefix; never extract links."""
import pathlib
import shutil
import sys
import tarfile


def unpack(source, destination, prefix):
    destination = pathlib.Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    total = 0
    count = 0
    with tarfile.open(source, "r:*") as archive:
        for member in archive:
            if member.isdir():
                continue
            count += 1
            total += member.size
            if not member.isfile() or count > 50000 or total > 2 * 1024 ** 3:
                raise ValueError("Archive contains links, devices, or excessive data")
            if not member.name.startswith(prefix):
                raise ValueError("Archive prefix does not match pinned model")
            relative = pathlib.PurePosixPath(member.name[len(prefix):])
            if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative) or ":" in str(relative):
                raise ValueError("Archive path escapes destination")
            target = destination.joinpath(*relative.parts)
            if not target.resolve().is_relative_to(destination):
                raise ValueError("Archive path escapes destination")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)


if __name__ == "__main__":
    unpack(*sys.argv[1:])
