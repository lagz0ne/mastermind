/**
 * `GET /install.sh`: a POSIX sh script that installs mastermind-runner from the
 * Mastermind that served it. It finds the OS and CPU, downloads the binary from
 * `<origin>/download/mastermind-runner`, checks it against the sha256 that the
 * server publishes, and puts it in ~/.local/bin (or $MASTERMIND_RUNNER_DIR).
 *
 *   curl -fsSL <origin>/install.sh | sh
 */

/** A URL origin that is safe to put in single quotes in a shell script. */
export const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/;

export function installScript(origin: string): string {
	if (!SAFE_ORIGIN.test(origin)) throw new Error(`unsafe origin ${origin}`);
	return `#!/bin/sh
# mastermind-runner installer, served by ${origin}.
# Installs the runner built from the same commit as that server.
# MASTERMIND_URL overrides the server; MASTERMIND_RUNNER_DIR the install directory.
set -eu

origin="\${MASTERMIND_URL:-}"
[ -n "$origin" ] || origin='${origin}'
dir="\${MASTERMIND_RUNNER_DIR:-$HOME/.local/bin}"

fail() {
	echo "mastermind-runner: $*" >&2
	exit 1
}

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) fail "no build for OS $(uname -s) (linux and darwin only)" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "no build for CPU $(uname -m) (x64 and arm64 only)" ;;
esac
# An arm64 Mac can run this shell under Rosetta; install the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
	[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
	arch=arm64
fi

command -v curl >/dev/null 2>&1 || fail "needs curl"
if command -v sha256sum >/dev/null 2>&1; then
	sum() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sum() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
	fail "needs sha256sum or shasum"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
query="os=$os&arch=$arch"

echo "mastermind-runner: downloading $os-$arch from $origin"
curl -fsSL "$origin/download/mastermind-runner.sha256?$query" -o "$tmp/sha256" ||
	fail "no sha256 for $os-$arch at $origin"
curl -fSL --compressed --progress-bar "$origin/download/mastermind-runner?$query" -o "$tmp/mastermind-runner" ||
	fail "download failed"

expected="$(cut -d ' ' -f 1 "$tmp/sha256")"
actual="$(sum "$tmp/mastermind-runner")"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
	fail "sha256 mismatch: expected $expected, got $actual; nothing installed"
fi

chmod 755 "$tmp/mastermind-runner"
mkdir -p "$dir"
mv -f "$tmp/mastermind-runner" "$dir/mastermind-runner"
echo "mastermind-runner: installed $dir/mastermind-runner (version $("$dir/mastermind-runner" --version))"
case ":$PATH:" in
*":$dir:"*) ;;
*) echo "mastermind-runner: $dir is not on PATH; run it as $dir/mastermind-runner" ;;
esac
`;
}
