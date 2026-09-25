#!/usr/bin/env bash
# Installs each artifact into an environment of its own and runs smoke_test.py against it, from
# outside the source tree. Everything that goes in is checked by hash: the SDK's dependencies as
# uv.lock pins them, the artifact itself, and for an sdist the build backend that builds it.
#
#   bash tests/smoke.sh dist/jiayang-*.whl dist/jiayang-*.tar.gz

set -euo pipefail

[ $# -gt 0 ] || { echo "usage: bash tests/smoke.sh <wheel or sdist>..." >&2; exit 2; }

pkg=$(cd "$(dirname "$0")/.." && pwd)
artifacts=()
for artifact in "$@"; do
	artifacts+=("$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")")
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

uv export --project "$pkg" --locked --no-default-groups --no-emit-project --quiet -o runtime.txt
uv export --project "$pkg" --locked --only-group build --no-emit-project --quiet -o build.txt

for artifact in "${artifacts[@]}"; do
	echo "--- $(basename "$artifact")"
	rm -rf venv
	uv venv --quiet venv
	printf 'jiayang @ file://%s --hash=sha256:%s\n' "${artifact// /%20}" "$(shasum -a 256 "$artifact" | cut -d' ' -f1)" >artifact.txt
	uv pip install --quiet --python venv/bin/python --require-hashes --build-constraint build.txt -r runtime.txt -r artifact.txt
	venv/bin/python "$pkg/tests/smoke_test.py"
done
