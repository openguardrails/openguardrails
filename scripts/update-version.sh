#!/bin/bash

# Version Update Script - Based on environment variables and VERSION file
# Usage:
#   Method 1: ./scripts/update-version.sh 1.3.0
#   Method 2: Manually edit VERSION file, then run ./scripts/update-version.sh
#   

set -e

# Project root directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$ROOT_DIR/VERSION"

# Get version number
if [ $# -eq 1 ]; then
    # Get version number from command line parameter
    VERSION="$1"
    # Remove v prefix (if exists)
    VERSION=${VERSION#v}
    echo "Use command line parameter version: $VERSION"
    
    # Update VERSION file
    echo "$VERSION" > "$VERSION_FILE"
    echo "✓ VERSION file updated"
elif [ -f "$VERSION_FILE" ]; then
    # Read version number from VERSION file
    VERSION=$(cat "$VERSION_FILE" | tr -d '\n\r')
    echo "Read version number from VERSION file: $VERSION"
else
    echo "❌ Error: Please provide version number parameter or create VERSION file"
    echo "Usage:"
    echo "  ./scripts/update-version.sh 1.3.0"
    echo "  or create/edit VERSION file first, then run ./scripts/update-version.sh"
    exit 1
fi

echo "Updating version number to: $VERSION"

# 1. Update version number in frontend/package.json
PACKAGE_JSON="$ROOT_DIR/frontend/package.json"
if [ -f "$PACKAGE_JSON" ]; then
    echo "Updating frontend/package.json version..."
    sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PACKAGE_JSON"
    echo "✓ Updated frontend/package.json"
else
    echo "⚠ Warning: frontend/package.json not found"
fi

# 2. Backend configuration now reads version number from VERSION file, no need to modify
echo "✓ Backend version will be automatically read from VERSION file"

# 3. Update initial version number in frontend/src/components/Layout/Layout.tsx
LAYOUT_TSX="$ROOT_DIR/frontend/src/components/Layout/Layout.tsx"
if [ -f "$LAYOUT_TSX" ]; then
    echo "Updating initial version number in frontend/src/components/Layout/Layout.tsx..."
    sed -i "s/const \[systemVersion, setSystemVersion\] = useState<string>('v[^']*')/const [systemVersion, setSystemVersion] = useState<string>('v$VERSION')/" "$LAYOUT_TSX"
    echo "✓ Updated frontend/src/components/Layout/Layout.tsx"
else
    echo "⚠ Warning: frontend/src/components/Layout/Layout.tsx not found"
fi

# 4. Frontend version now reads from API dynamically, but initial state is also synchronized
echo "✓ Frontend version will be read from API automatically, initial state is also synchronized"

echo ""
echo "🎉 Version update completed!"
echo "Current version: $VERSION"
echo ""
echo "Updated files:"
echo "  - VERSION (Main version file)"
echo "  - frontend/package.json"
echo "  - frontend/src/components/Layout/Layout.tsx"
echo ""
echo "Version number reading method:"
echo "  - Backend: VERSION file → Environment variable APP_VERSION → Default value"
echo "  - Frontend: Read from API from backend"
echo ""
echo "Suggested operations:"
echo "1. Check VERSION file content: cat VERSION"
echo "2. Rebuild and deploy application"
echo "3. Optional: Set environment variable export APP_VERSION=$VERSION"
echo "4. Submit version update to git:"
echo "   git add ."
echo "   git commit -m \"chore: update version to $VERSION\""
echo ""
echo "Sync with Git Tag (optional):"
echo "   git tag v$VERSION"
echo "   git push origin v$VERSION"