#!/bin/sh
# Keep execution behind the final call: a truncated download must not install anything.
llmhub_install() (
    set -eu
    step='configuration'
    trap 'result=$?; if [ "$result" -ne 0 ]; then printf "\nLLMHub failed during: %s (exit %s)\n" "$step" "$result" >&2; fi' 0
    fail() { printf '%s\n' "$*" >&2; exit 1; }
    progress() { step=$1; printf '\n==> %s\n' "$step"; }
    directory=${LLMHUB_INSTALL_DIR:-"$HOME/llmhub"}
    source=${LLMHUB_SOURCE:-https://github.com/huangdihd/LLMHub.git}
    reference=${LLMHUB_REF:-auto-stable}
    port=${LLMHUB_PORT:-3000}
    host=${LLMHUB_HOST:-127.0.0.1}
    service=${LLMHUB_SERVICE:-auto}
    action=${LLMHUB_ACTION:-install}
    dry_run=${LLMHUB_DRY_RUN:-0}
    unit=/etc/systemd/system/llmhub.service
    # These values enter a systemd unit as well as shell commands. Reject ambiguous syntax.
    case "$directory" in /*) ;; *) fail 'LLMHUB_INSTALL_DIR must be absolute.' ;; esac
    case "$directory" in *[!a-zA-Z0-9_./-]*|/|*/../*|*/..|*/./*|*/.) fail 'Install path must use letters, digits, /, _, ., - only, without dot segments.' ;; esac
    case "$host" in ''|*[!a-zA-Z0-9.:-]*) fail 'Invalid listening host.' ;; esac
    case "$port" in ''|*[!0-9]*|??????*) fail 'Invalid port.' ;; esac
    [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail 'Port must be 1..65535.'
    case "$service" in auto|yes|no) ;; *) fail 'LLMHUB_SERVICE must be auto, yes or no.' ;; esac
    case "$action" in install|uninstall) ;; *) fail 'LLMHUB_ACTION must be install or uninstall.' ;; esac
    case "$dry_run" in 0|1) ;; *) fail 'LLMHUB_DRY_RUN must be 0 or 1.' ;; esac
    case "$reference" in ''|-*) fail 'Invalid branch/tag.' ;; esac
    case "$source" in ''|-*) fail 'Invalid source.' ;; esac
    if [ "$dry_run" = 1 ]; then
        printf 'DRY RUN: action=%s directory=%s source=%s ref=%s host=%s port=%s service=%s\n' "$action" "$directory" "$source" "$reference" "$host" "$port" "$service"
        if [ "$action" = install ]; then
            printf '%s\n' 'Would check git, Node 20.19+ or 22.12+, and npm; clone or require a clean worktree and fast-forward/switch tag; npm ci --include=dev; npm run build.'
            printf 'On Linux/systemd, with consent: write %s, daemon-reload, enable and restart llmhub. Otherwise print manual startup.\n' "$unit"
        else
            printf 'With consent: stop/disable llmhub, remove owned %s, daemon-reload.\n' "$unit"
        fi
        printf 'Installation directory and %s/.data are never removed.\n' "$directory"
        exit 0
    fi
    case "$(uname -s)" in Linux|Darwin) ;; *) fail 'Only Linux and macOS are supported.' ;; esac
    elevated() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -- "$@"; fi; }
    consent() {
        printf 'Service operations: %s\nSystem file: %s\n' "$1" "$unit"
        printf '%s\n' 'Only these service operations use sudo (unless already root); the application runs as the current user.'
        if [ "$(id -u)" != 0 ] && ! command -v sudo >/dev/null 2>&1; then return 1; fi
        if ! (printf 'Proceed? [y/N] ' >/dev/tty) 2>/dev/null; then return 1; fi
        answer=''
        read -r answer </dev/tty || return 1
        case "$answer" in y|Y|yes) return 0 ;; *) return 1 ;; esac
    }
    owned_unit() { grep -Fx "# LLMHub installer: $directory" "$unit" >/dev/null 2>&1; }
    if [ "$action" = uninstall ]; then
        progress 'remove service (keep all data)'
        if [ -e "$unit" ]; then
            owned_unit || fail 'Refusing to remove a service belonging to another installation.'
            if consent 'systemctl disable --now llmhub; rm service file; systemctl daemon-reload'; then
                elevated systemctl disable --now llmhub
                elevated rm -- "$unit"
                elevated systemctl daemon-reload
            else
                printf '%s\n' 'No service changes made. Ask an administrator to remove the service above.'
            fi
        fi
        printf 'Retained %s, including data at %s/.data. Stop any manually started process yourself.\n' "$directory" "$directory"
        exit 0
    fi
    progress 'check prerequisites'
    for tool in git node npm; do
        command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool. Install it yourself, then rerun; no system packages will be installed."
    done
    # The same range the locked Nuxt, Nitro and Vite declare: ^20.19.0 || >=22.12.0.
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22; if (!ok) process.exit(1)' || fail "Node 20.19+ or 22.12+ is required; found $(node -v). Install a current LTS release, then rerun."
    if [ "$reference" = auto-stable ]; then
        progress 'select highest stable release (main if none)'
        remote_tags=$(git ls-remote --tags --refs -- "$source") || fail 'Cannot list release tags; refusing an unverified fallback.'
        reference=$(printf '%s\n' "$remote_tags" | node -e '
            let input = "";
            process.stdin.on("data", chunk => { input += chunk });
            process.stdin.on("end", () => {
                const tags = input.split("\n").map(line => line.split("refs/tags/")[1]).filter(tag => /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag));
                tags.sort((left, right) => {
                    const first = left.slice(1).split(".").map(BigInt);
                    const second = right.slice(1).split(".").map(BigInt);
                    for (let index = 0; index < 3; index++) if (first[index] !== second[index]) return first[index] > second[index] ? -1 : 1;
                    return 0;
                });
                console.log(tags[0] || "main");
            });
        ')
    fi
    git check-ref-format "refs/heads/$reference" >/dev/null || fail 'Invalid branch/tag name.'
    node_path=$(command -v node)
    service_ready=no
    if [ "$service" != no ] && [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        [ ! -e "$unit" ] || owned_unit || fail 'Existing llmhub.service belongs to another installation; refusing to overwrite.'
        service_ready=yes
    fi
    progress 'clone or update repository'
    if [ -e "$directory" ]; then
        [ -d "$directory/.git" ] || fail 'Install directory exists but is not a Git checkout; choose another directory.'
        [ ! -e "$directory/.data/updates/supervisor.lock" ] || fail 'Supervisor owns this installation; use dashboard updates or stop it before rerunning the installer.'
        [ ! -e "$directory/.data/updates/current.json" ] || fail 'This installation has switched releases; use dashboard updates. Rebuilding the original checkout would not update the active release.'
        [ -z "$(git -C "$directory" status --porcelain --untracked-files=all)" ] || fail 'Local changes found. Commit/stash or remove them yourself before upgrading; nothing overwritten.'
        [ "$(git -C "$directory" remote get-url origin)" = "$source" ] || fail 'Clone source differs from origin; use the original LLMHUB_SOURCE.'
        if git -C "$directory" fetch origin "refs/heads/$reference:refs/remotes/origin/$reference"; then
            target="refs/remotes/origin/$reference"
        else
            git -C "$directory" fetch origin "refs/tags/$reference:refs/tags/$reference"
            target="refs/tags/$reference"
        fi
        # Do not discard local commits, even when the worktree itself is clean.
        git -C "$directory" merge-base --is-ancestor HEAD "$target" || fail 'Update is not a fast-forward; refusing to discard commits. Choose a new installation directory for a downgrade.'
        git -C "$directory" checkout --detach "$target"
    else
        git clone --branch "$reference" -- "$source" "$directory"
    fi
    cd "$directory"
    progress 'initialize release supervisor'
    [ -f scripts/release-build.mjs ] && [ -f scripts/update-supervisor.mjs ] || fail 'Selected release predates supervised installation; select a release containing scripts/release-build.mjs or set LLMHUB_REF=main.'
    LLMHUB_INSTALL_DIR="$directory" node scripts/update-supervisor.mjs --initialize
    progress 'install dependencies and build production application'
    node scripts/release-build.mjs "$directory"
    progress 'configure service or manual startup'
    if [ "$service_ready" = yes ] && consent 'install service file; systemctl daemon-reload; systemctl enable llmhub; systemctl restart llmhub'; then
        case "$node_path:$PATH" in *[!a-zA-Z0-9_./:-]*) fail 'PATH contains unsupported systemd characters; use LLMHUB_SERVICE=no.' ;; esac
        temporary=$(mktemp)
        trap 'result=$?; rm -f -- "$temporary"; if [ "$result" -ne 0 ]; then printf "LLMHub failed during: %s (exit %s)\n" "$step" "$result" >&2; fi' 0
        cat >"$temporary" <<EOF
# LLMHub installer: $directory
[Unit]
Description=LLMHub
After=network.target
[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$directory
ExecStart=$node_path $directory/scripts/update-supervisor.mjs
Environment="NODE_ENV=production" "HOST=$host" "PORT=$port" "PATH=$PATH" "LLMHUB_DEPLOYMENT=service" "LLMHUB_INSTALL_DIR=$directory"
Restart=on-failure
RestartSec=5
# Let the supervisor stop its detached child before systemd's final group cleanup.
KillMode=mixed
TimeoutStopSec=30
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
        if elevated install -m 644 "$temporary" "$unit"; then
            elevated systemctl daemon-reload
            elevated systemctl enable llmhub
            elevated systemctl restart llmhub
            printf '%s\n' 'Status: systemctl status llmhub' 'Logs: journalctl -u llmhub -f'
        else
            printf '%s\n' 'Permission denied; service not installed. Use manual startup below.'
        fi
    else
        printf '%s\n' 'Service not installed/restarted. Stop any old manually managed process before starting the new build.'
    fi
    printf "Manual startup: cd '%s' && HOST='%s' PORT='%s' node .output/server/index.mjs\n" "$directory" "$host" "$port"
    printf 'Visit: http://%s:%s\n' "$host" "$port"
    printf '%s\n' 'Upgrade: rerun this installer with the same configuration. Uninstall service: rerun with LLMHUB_ACTION=uninstall.'
    printf 'Data retained at %s/.data. Back it up before upgrades.\n' "$directory"
    printf '%s\n' 'To listen externally, set LLMHUB_HOST=0.0.0.0. FIRST set the admin password locally; never expose the uninitialized dashboard to the Internet. Use TLS and a firewall.'
)
llmhub_install
