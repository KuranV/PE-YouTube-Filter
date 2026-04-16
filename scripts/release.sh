#!/usr/bin/env bash
set -e

# Usage: ./scripts/release.sh 1.2.0
VERSION="${1:?Usage: $0 <version>  e.g. $0 1.2.0}"
TAG="v$VERSION"
ZIP="pe-youtube-filter-$VERSION.zip"
REPO="KuranV/PE-YouTube-Filter"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

# 1. Bump version in manifest.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$ROOT/manifest.json"
echo "Bumped manifest.json to $VERSION"

# 2. Build zip
cd "$ROOT"
rm -f "../$ZIP"
zip -r "../$ZIP" . \
  --exclude "*.git*" \
  --exclude ".wrangler/*" \
  --exclude "worker/*" \
  --exclude "scripts/*" \
  --exclude "wrangler.toml" \
  --exclude "*.txt" \
  --exclude "*.zip" \
  --exclude "node_modules/*" \
  --exclude ".claude/*"
echo "Built ../$ZIP"

# 3. Commit + tag
git add manifest.json
git commit -m "Release $TAG"
git tag "$TAG"
git push
git push origin "$TAG"
echo "Pushed tag $TAG"

# 4. Create GitHub release via API
if [ -z "$GITHUB_TOKEN" ]; then
  echo ""
  echo "No GITHUB_TOKEN env var found — upload the zip manually:"
  echo "  https://github.com/$REPO/releases/new?tag=$TAG"
  exit 0
fi

RELEASE=$(curl -sf -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"draft\":false,\"prerelease\":false}")

UPLOAD_URL=$(echo "$RELEASE" | grep -o '"upload_url":"[^"]*"' | cut -d'"' -f4 | sed 's/{.*}//')

curl -sf -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@../$ZIP" \
  "${UPLOAD_URL}?name=$ZIP" > /dev/null

echo "Release created: https://github.com/$REPO/releases/tag/$TAG"
