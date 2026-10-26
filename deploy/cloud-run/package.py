#!/usr/bin/env python3
"""Create a private, source-only Cloud Shell upload ZIP with Python's stdlib."""

from __future__ import annotations

import argparse
import fnmatch
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile
import zipfile


REPOSITORIES = ("Daisy_form", "Daisy_form_backend")
SOURCE_DIRECTORIES = {
    "Daisy_form": {"src", "public"},
    "Daisy_form_backend": {"src", "scripts", "deploy"},
}
ROOT_FILES = {
    "Daisy_form": {
        "package.json", "yarn.lock", "README.md", "index.html", "vite.config.ts",
        "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "components.json",
        "eslint.config.js", ".gitignore", ".prettierignore", ".prettierrc", ".env.example",
    },
    "Daisy_form_backend": {
        "package.json", "package-lock.json", "README.md", ".gitignore", ".env.example",
    },
}
EXCLUDED_DIRECTORIES = {
    ".git", ".hg", ".svn", "node_modules", "dist", "dist-ssr", ".next",
    ".aws", ".ssh", ".gnupg", ".codex", ".agents", ".idea", ".vscode",
    "data", "backup", "backups", "coverage", ".nyc_output", "test", "tests",
    "test-results", "playwright-report", ".pytest_cache", "__pycache__",
    ".cache", ".vite", ".turbo", "tmp", "temp", "scratch", "release",
    "releases", "__macosx", "logs",
}
EXCLUDED_PATTERNS = (
    "*.sqlite*", "*.db", "*-wal", "*-shm", "*-journal", "*.log", "*.pyc",
    "*.zip", "*.tar", "*.tgz", "*.gz", "*.bz2", "*.xz", "*.7z", "*.rar",
    "*.bak", "*.backup", "*.pem", "*.key", "*.p12", "*.pfx", "*.csv", "*.tsv",
    "*.ndjson", "*.jsonl", "*credentials*",
    "*secret*", "*service-account*.json", "*service_account*.json",
    "*inquiries*.json", ".daisy-backup-*", "._*", "*~", "*.swp", "*.swo",
)
EXCLUDED_FILES = {".ds_store", ".npmrc", ".netrc", ".pypirc"}


def should_include(relative_path: PurePosixPath) -> bool:
    """Apply the denylist to every path component, before opening any file."""
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return False
    parts = relative_path.parts
    if not parts or parts[0] not in REPOSITORIES:
        return False
    # Restrict repository roots to known build inputs. Unrelated exports and
    # personal files at the root are never swept into the upload.
    if len(parts) > 1 and parts[1] not in SOURCE_DIRECTORIES[parts[0]]:
        if len(parts) != 2 or parts[1] not in ROOT_FILES[parts[0]]:
            return False
    for component in relative_path.parts:
        name = component.lower()
        if name in EXCLUDED_DIRECTORIES or name in EXCLUDED_FILES:
            return False
        # Permit only template environment files, including *.env.example.
        is_environment = name == ".env" or name.startswith(".env.") or ".env" in name
        if is_environment and not (name == ".env.example" or name.endswith(".env.example")):
            return False
        if any(fnmatch.fnmatchcase(name, pattern) for pattern in EXCLUDED_PATTERNS):
            return False
    return relative_path.as_posix() != "Daisy_form_backend/yarn.lock"


def source_files(source_root: Path):
    """Yield regular files only; never follow symlinks or leave either repo."""
    for repository in REPOSITORIES:
        repository_root = source_root / repository
        if repository_root.is_symlink() or not repository_root.is_dir():
            raise ValueError(f"Expected a real directory: {repository_root}")
        for directory, directories, filenames in os.walk(repository_root, followlinks=False):
            directory_path = Path(directory)
            directories[:] = sorted(
                name for name in directories
                if not (directory_path / name).is_symlink()
                and should_include(PurePosixPath((directory_path / name).relative_to(source_root).as_posix()))
            )
            for name in sorted(filenames):
                path = directory_path / name
                relative_path = PurePosixPath(path.relative_to(source_root).as_posix())
                if not should_include(relative_path):
                    continue
                if not stat.S_ISREG(path.lstat().st_mode):
                    continue
                yield path, relative_path.as_posix()


def package_sources(source_root: Path, output: Path, *, overwrite: bool = False) -> int:
    """Atomically publish a completed ZIP, refusing replacement by default."""
    source_root = source_root.resolve()
    output = output.absolute()
    if output.exists() and not overwrite:
        raise FileExistsError(f"Output exists: {output}; use --overwrite to replace it")
    if output.is_symlink():
        raise ValueError("The output must not be a symlink")
    files = list(source_files(source_root))
    if not files:
        raise ValueError("No source files found")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".daisy-package-", suffix=".zip", dir=output.parent)
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path, archive_name in files:
                # Fixed timestamps and regular-file metadata make archive entries
                # reproducible and prevent executable/symlink metadata surprises.
                info = zipfile.ZipInfo(archive_name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        if overwrite:
            os.replace(temporary_path, output)
        else:
            # A hard link publishes without a race that could replace an existing
            # file. Both paths are in the same output directory/filesystem.
            os.link(temporary_path, output)
        output.chmod(0o600)
    finally:
        temporary_path.unlink(missing_ok=True)
    return len(files)


def main() -> int:
    source_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=source_root / "release" / "daisy-cloud-run.zip")
    parser.add_argument("--overwrite", action="store_true", help="Explicitly replace an existing output ZIP")
    parser.add_argument("--list", action="store_true", help="List included paths without writing an archive")
    arguments = parser.parse_args()
    try:
        if arguments.list:
            for _, archive_name in source_files(source_root):
                print(archive_name)
            return 0
        count = package_sources(source_root, arguments.output, overwrite=arguments.overwrite)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        return 1
    print(f"Created {arguments.output.absolute()} ({count} source files; no local data or credentials)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
