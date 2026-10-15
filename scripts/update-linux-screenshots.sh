#!/usr/bin/env bash
# Regenerates the Linux reference screenshots inside the official Playwright
# image (same Chromium + SwiftShader stack as the CI runners).
set -euo pipefail
cd "$(dirname "$0")/.."
PLAYWRIGHT_VERSION=$(node -p 'require("playwright/package.json").version')
PNPM_VERSION=$(node -p 'require("./package.json").packageManager.split("@")[1]')
docker run --rm --ipc=host -v "$PWD:/src" "mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble" bash -c "
  set -e
  mkdir /work && cd /src && tar --exclude=node_modules --exclude=.git --exclude=dist -cf - . | tar -xf - -C /work
  cd /work
  rm -f test/__screenshots__/*/*-linux.png
  npx -y pnpm@${PNPM_VERSION} install --frozen-lockfile
  npx -y pnpm@${PNPM_VERSION} exec vitest run test/screenshots.test.ts --update || true
  cp test/__screenshots__/*/*-linux.png /src/test/__screenshots__/screenshots.test.ts/
"
ls test/__screenshots__/screenshots.test.ts/
