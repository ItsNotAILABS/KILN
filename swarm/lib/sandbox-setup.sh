#!/bin/bash
# KILN sandbox setup — runs INSIDE fresh Linux namespaces (mount, pid, uts,
# ipc, and optionally net) created by `unshare` in lib/sandbox.mjs.
#
# What it builds:
#   - workdir bind-mounted to /tmp/kiln-sandbox/w (the only writable user path)
#   - /home, /root covered with an empty dir (function cannot see other users)
#   - /etc covered too when network is off (no DNS/config to read)
#   - wall-clock timeout with SIGTERM-then-SIGKILL teeth (parent supervisor)
#   - fork-bomb guard is supervisor-side (see header): NO ulimit -u here.
#   - CPU time is METERED (runner reports process.cpuUsage()), not capped:
#     RLIMIT_CPU was dropped because this build of unshare mishandles the
#     child's SIGXCPU death ("sigprocmask unblock failed: Invalid argument",
#     exit 1 instead of reporting the signal). The wall-clock timeout is the
#     hard bound on burners, same as Lambda's 15-minute max.
#
# Memory note: V8 reserves ~4GB of *virtual* address space at startup, so
# RLIMIT_AS cannot be used to cap Node (it kills V8 during init). Instead:
#   1. --max-old-space-size caps the JS heap (hard, deterministic), and
#   2. the parent supervisor (sandbox.mjs) polls RSS and SIGKILLs past 2x.
#
# Fork-bomb note: RLIMIT_NPROC is deliberately NOT used. It counts
# processes+threads per real UID across the whole machine, so on a busy box
# (this one: 5000+ threads for the daemon's UID) even a modest limit kills
# Node at startup — pthread_create fails and V8 SIGSEGVs in
# WorkerThreadsTaskRunner. The fork guard is supervisor-side instead:
# sandbox.mjs counts processes in the sandbox's PID namespace every 50ms
# and SIGKILLs the tree past 128 processes (a bomb doubles ~7 times to get
# there; legitimate functions never fork at all).
#
# Only soft rlimits are set: this VM's container user-ns denies raising or
# re-setting hard CPU limits (Operation not permitted); soft limits enforce
# identically for our purpose.
#
# Exit codes 21..27 = sandbox setup failed LOUDLY (function never runs).
set -u
: "${KILN_SB_WORK:?missing KILN_SB_WORK}"
: "${KILN_SB_MEM_MB:?missing KILN_SB_MEM_MB}"
: "${KILN_SB_NET:?missing KILN_SB_NET}"
: "${KILN_SB_NODE:?missing KILN_SB_NODE}"
: "${KILN_SB_RUNNER:=runner.mjs}"
case "$KILN_SB_RUNNER" in
  *..*|/*) echo "sandbox: runner must be a relative path inside the workdir" >&2; exit 28 ;;
esac

STAGE=/tmp/kiln-sandbox
mkdir -p "$STAGE/empty" "$STAGE/w"

# The workdir must stay reachable after /home is covered, so stage it first.
mount --bind "$KILN_SB_WORK" "$STAGE/w" || exit 21
mount --bind "$STAGE/empty" /home || exit 22
mount --bind "$STAGE/empty" /root || exit 23
if [ "$KILN_SB_NET" != "1" ]; then
  mount --bind "$STAGE/empty" /etc || exit 24
fi

cd "$STAGE/w" || exit 27
# Minimal environment: no host secrets, no HOME pointing at real user data.
exec env -i "PATH=/usr/bin:/bin" "HOME=$STAGE/w" \
  "$KILN_SB_NODE" --max-old-space-size="$KILN_SB_MEM_MB" "$KILN_SB_RUNNER"
