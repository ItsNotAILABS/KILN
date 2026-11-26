# KILN virtual computer — one agent's machine.
#
# Build with ./build.sh (it feeds every pin from versions.env as a
# --build-arg; building without it fails on the empty ARGs on purpose).
# What's inside: Xvfb + xfwm4 desktop, Chrome for Testing, x11vnc +
# websockify for owner hand-off, xdotool + ffmpeg for agent control, and
# the dev toolchain (git, gh, Node LTS + pnpm + bun, Python 3, Rust via
# rustup, Solana CLI + Anchor, poppler, build-essential). See
# docs/KILN_VIRTUAL_COMPUTERS.md.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG KILN_VC_IMAGE_VERSION
ARG DEBIAN_SNAPSHOT
ARG NODE_VERSION
ARG NODE_SHA256
ARG PNPM_VERSION
ARG BUN_VERSION
ARG BUN_SHA256
ARG GH_VERSION
ARG GH_SHA256
ARG RUSTUP_VERSION
ARG RUSTUP_SHA256
ARG RUST_TOOLCHAIN
ARG SOLANA_VERSION
ARG SOLANA_SHA256
ARG ANCHOR_VERSION
ARG CHROME_VERSION
ARG CHROME_SHA256

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

# apt resolves against a fixed Debian snapshot -> same package set every
# build. snapshot.debian.org is served over https, so ca-certificates is
# bootstrapped first from the base image's own (digest-pinned) sources.
RUN test -n "$DEBIAN_SNAPSHOT" && \
    apt-get -o Acquire::Retries=5 update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/debian.sources && \
    printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s trixie main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s trixie-security main\n' \
      "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list && \
    apt-get -o Acquire::Retries=5 update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl git git-lfs openssh-client xz-utils bzip2 unzip zip jq less nano \
      build-essential pkg-config cmake clang libssl-dev libudev-dev \
      python3 python3-venv python3-pip python3-dev \
      poppler-utils procps psmisc tini \
      xvfb xfwm4 x11vnc websockify novnc xdotool x11-utils ffmpeg dbus-x11 \
      fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
      libasound2t64 libxshmfence1 libgtk-3-0t64 libx11-xcb1 libvulkan1 xdg-utils && \
    rm -rf /var/lib/apt/lists/*

# Unprivileged agent user. /home/agent is the persistent volume.
RUN useradd --create-home --uid 1000 --shell /bin/bash agent && \
    mkdir -p /opt && chown agent:agent /opt

WORKDIR /tmp/build

# Node LTS (+ pnpm via npm, bun) — verified tarballs.
RUN curl -fsSLo node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c - && \
    mkdir -p /opt/node && tar -xJf node.tar.xz -C /opt/node --strip-components=1 && rm node.tar.xz && \
    /opt/node/bin/npm install -g "pnpm@${PNPM_VERSION}" && \
    curl -fsSLo bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" && \
    echo "${BUN_SHA256}  bun.zip" | sha256sum -c - && \
    unzip -q bun.zip && mkdir -p /opt/bun/bin && mv bun-linux-x64/bun /opt/bun/bin/bun && ln -s bun /opt/bun/bin/bunx && rm -rf bun.zip bun-linux-x64

# GitHub CLI.
RUN curl -fsSLo gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" && \
    echo "${GH_SHA256}  gh.tgz" | sha256sum -c - && \
    tar -xzf gh.tgz && install -m 0755 "gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh && rm -rf gh.tgz gh_*

# Chrome for Testing — the only Chrome channel with exact, downloadable
# versions, so the browser is pinned like everything else.
RUN curl -fsSLo chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" && \
    echo "${CHROME_SHA256}  chrome.zip" | sha256sum -c - && \
    unzip -q chrome.zip && mv chrome-linux64 /opt/chrome && rm chrome.zip && \
    missing="$(ldd /opt/chrome/chrome | grep 'not found' || true)" && \
    if [ -n "$missing" ]; then echo "chrome is missing libraries: $missing" >&2; exit 1; fi && \
    ln -s /opt/chrome/chrome /usr/local/bin/chrome

# Toolchains below are owned by the agent so `cargo install`, `pnpm add -g`
# and friends work without root; they live in /opt, NOT the home volume,
# so an image upgrade upgrades them.
RUN chown agent:agent /tmp/build
USER agent
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo
RUN curl -fsSLo /tmp/build/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" && \
    echo "${RUSTUP_SHA256}  /tmp/build/rustup-init" | sha256sum -c - && \
    chmod +x /tmp/build/rustup-init && \
    /tmp/build/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" -c clippy -c rustfmt && \
    rm /tmp/build/rustup-init

RUN curl -fsSLo /tmp/build/solana.tar.bz2 "https://github.com/anza-xyz/agave/releases/download/v${SOLANA_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" && \
    echo "${SOLANA_SHA256}  /tmp/build/solana.tar.bz2" | sha256sum -c - && \
    mkdir -p /opt/solana && tar -xjf /tmp/build/solana.tar.bz2 -C /opt/solana --strip-components=1 && \
    rm /tmp/build/solana.tar.bz2

# Anchor publishes no binaries for 0.30.1 — build the tagged CLI with its lockfile.
RUN PATH="/opt/rust/cargo/bin:$PATH" cargo install --git https://github.com/coral-xyz/anchor \
      --tag "v${ANCHOR_VERSION}" anchor-cli --locked && \
    rm -rf /opt/rust/cargo/registry /opt/rust/cargo/git

USER root
ENV PATH=/opt/rust/cargo/bin:/opt/solana/bin:/opt/bun/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN printf 'export RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo\nexport PATH=%s\n' "$PATH" > /etc/profile.d/kiln-vc.sh

COPY bin/ /usr/local/bin/
COPY versions.env /etc/kiln-vc/versions.env
RUN chmod 0755 /usr/local/bin/kiln-vc-* && \
    echo "${KILN_VC_IMAGE_VERSION}" > /etc/kiln-vc/image-version && \
    /usr/local/bin/kiln-vc-toolcheck && rm -rf /tmp/build

USER agent
WORKDIR /home/agent
ENV HOME=/home/agent KILN_VC_DISPLAY=:0 KILN_VC_RUNDIR=/tmp/kiln-vc KILN_VC_CHROME=/opt/chrome/chrome \
    KILN_VC_CHROME_FLAGS=--no-sandbox KILN_VC_IN_CONTAINER=1
LABEL org.opencontainers.image.title="kiln-vc" \
      org.opencontainers.image.source="https://github.com/ItsNotAILABS/KILN" \
      org.opencontainers.image.description="KILN virtual computer: desktop + browser + dev toolchain for one agent"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/kiln-vc-session"]
