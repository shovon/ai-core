#!/usr/bin/env bash
# Checks what would be published, as someone who installs it gets it: packs
# every package that is not private, installs the tarballs together into an
# empty project outside the workspace, and imports each one.
#
# Run from the repo's root. Packing a package builds it first.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/tarballs" "$work/project"

names=$(npm query .workspace | jq -r '.[] | select(.private != true) | .name')
if [ -z "$names" ]; then
  echo "No package here is published." >&2
  exit 1
fi

for name in $names; do
  npm pack --workspace "$name" --pack-destination "$work/tarballs" > /dev/null
done

cd "$work/project"
echo '{ "private": true, "type": "module" }' > package.json
npm install --no-audit --no-fund "$work"/tarballs/*.tgz > /dev/null

for name in $names; do
  node --input-type=module --eval "await import('$name');"
  echo "Installs and imports: $name"
done
