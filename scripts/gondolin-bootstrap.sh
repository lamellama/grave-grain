#!/bin/sh
# Bootstrap the gondolin VM toolchain for Pi agents. Source this file:
#   . scripts/gondolin-bootstrap.sh

if [ -d /workspace ]; then
  GONDOLIN_WORKSPACE=/workspace
  export HOME=/workspace
else
  GONDOLIN_WORKSPACE="$(pwd)"
fi

if ! command -v git >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    apk add git
  else
    echo "git is missing and apk is not available; install git in this sandbox." >&2
    return 1 2>/dev/null || exit 1
  fi
fi

if command -v git >/dev/null 2>&1; then
  if [ -d /workspace ]; then
    git config --global --add safe.directory "$GONDOLIN_WORKSPACE"
  fi
fi

if [ -d /workspace ] && [ ! -x /usr/local/bin/pnpm ] && [ -f /workspace/.tooling/pnpm/bin/pnpm.cjs ]; then
  printf '#!/bin/sh\nexec node /workspace/.tooling/pnpm/bin/pnpm.cjs "$@"\n' > /usr/local/bin/pnpm
  chmod +x /usr/local/bin/pnpm 2>/dev/null || true
fi
