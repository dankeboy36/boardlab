#!/usr/bin/env bash
set -Eeuo pipefail

# Defaults (override via env or flags)
TAG="${TAG:-1.10.2}"
TARGET="${TARGET:-resources/arduino-examples/examples}"

usage() {
  echo "Usage: TAG=<tag> TARGET=<dir> $0
  or:   $0 --tag <tag> --target <dir>

Defaults:
  TAG    = ${TAG}
  TARGET = ${TARGET}
" >&2
}

# Very light flag parser
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0;;
    --tag)    TAG="$2"; shift 2;;
    --target) TARGET="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

# Create temp dir (works on macOS & Linux)
TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t arduino-examples)"
cleanup() { rm -rf -- "$TMPDIR"; }
trap cleanup EXIT

echo "→ Cloning arduino/arduino-examples (full clone with tags)…"
git clone --quiet "https://github.com/arduino/arduino-examples.git" "${TMPDIR}/src"
git -C "${TMPDIR}/src" checkout -q "${TAG}" -b "${TAG}"
COMMIT_HASH=$(git -C "${TMPDIR}/src" rev-parse --short HEAD)
echo "✓ Checked out tag ${TAG} (${COMMIT_HASH})"

# Sanity check: ensure we got something meaningful
if [[ ! -d "${TMPDIR}/src/examples" ]]; then
  echo "✖ Clone failed or examples directory missing" >&2
  exit 2
fi

# Prepare target
mkdir -p "$(dirname "${TARGET}")"
echo "→ Copying examples to ${TARGET}…"
rm -rf -- "${TARGET}"
cp -r "${TMPDIR}/src/examples" "${TARGET}"

echo "✓ Done. Installed examples from arduino/arduino-examples@${TAG} into ${TARGET}"
