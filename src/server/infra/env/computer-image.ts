/** The image a Bot's sandbox starts from (A50), built on this machine: Ubuntu 24.04 with Node, Python, git,
 * build tools and Playwright with its browsers (the package matches the browsers and any script finds it). The Bot
 * runs as `bot`, with the owner's user and group ids so files it makes in the mounted workspace are the owner's, and
 * the workspace is its home, so its settings (~/.ssh, ~/.gitconfig, caches) stay with it; sudo
 * lets it install software, which stays until its sandbox is reset. One image serves every Bot and is stored once,
 * so what most Bots need belongs here and the rest is theirs to install. */
export const COMPUTER_DOCKERFILE = `FROM mcr.microsoft.com/playwright:v1.61.1-noble
ARG UID=1000
ARG GID=1000
RUN apt-get update \\
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl fonts-noto-cjk git python3 python3-dev python3-pip python3-venv sudo \\
 && rm -rf /var/lib/apt/lists/* \\
 && npm install -g playwright@1.61.1 && npm cache clean --force \\
 && taken="$(getent passwd "$UID" | cut -d: -f1)"; if [ -n "$taken" ]; then userdel -r "$taken" 2>/dev/null || userdel "$taken"; fi \\
 && (getent group "$GID" > /dev/null || groupadd -g "$GID" bot) \\
 && useradd -m -d /workspace -u "$UID" -g "$GID" -s /bin/bash bot \\
 && install -d -o "$UID" -g "$GID" /home/bot/.npm-global /home/bot/.npm-global/bin /home/bot/.npm-global/lib \\
 && echo "bot ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/bot && chmod 0440 /etc/sudoers.d/bot \\
 && mkdir -p /workspace && chown "$UID:$GID" /workspace
ENV NPM_CONFIG_PREFIX=/home/bot/.npm-global PATH=/home/bot/.npm-global/bin:$PATH \\
    NODE_PATH=/home/bot/.npm-global/lib/node_modules:/usr/lib/node_modules
USER bot
WORKDIR /workspace
`;

/** Where a VM sandbox's Docker disk is mounted in it (A85): a sparse file of this machine, one per Bot. */
export const VM_DISK = "/opt/jarvy-disk/docker.img";
/** Starts Docker inside a VM sandbox (A85), run as root after each start: its data on the Bot's own disk at
 * /var/lib/docker (a loop device with direct I/O, made ext4 the first time), and dockerd, unless it already answers.
 * The container's /dev has no loop devices, though the VM's kernel has them; what the last dockerd left in /run is
 * stale after a restart, its pids perhaps taken. */
export const DOCKER_UP = `#!/bin/sh
set -eu
DISK=${VM_DISK}
if ! mountpoint -q /var/lib/docker; then
  [ -e /dev/loop-control ] || mknod -m 660 /dev/loop-control c 10 237
  i=0; while [ $i -lt 8 ]; do [ -e /dev/loop$i ] || mknod -m 660 /dev/loop$i b 7 $i; i=$((i+1)); done
  dev=$(losetup -j "$DISK" | cut -d: -f1 | head -n1)
  [ -n "$dev" ] || dev=$(losetup --direct-io=on -f --show "$DISK")
  blkid "$dev" > /dev/null 2>&1 || mkfs.ext4 -q -F -E lazy_itable_init=1,lazy_journal_init=1 "$dev"
  mkdir -p /var/lib/docker && mount "$dev" /var/lib/docker
fi
grep -q ' /sys/fs/cgroup cgroup2 rw' /proc/mounts || mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
if ! docker version > /dev/null 2>&1; then
  pkill -x dockerd 2>/dev/null || true; pkill -x containerd 2>/dev/null || true
  rm -rf /var/run/docker /var/run/docker.pid /var/run/docker.sock /run/containerd
  setsid nohup dockerd > /var/log/dockerd.log 2>&1 < /dev/null &
  i=0; until docker version > /dev/null 2>&1; do i=$((i+1)); [ $i -lt 120 ] || { tail -n 5 /var/log/dockerd.log >&2; exit 1; }; sleep 0.5; done
fi
`;
/** A VM sandbox's image (A85): the sandbox image with Docker Engine and Compose from Ubuntu, the Bot's user in the
 * docker group, and DOCKER_UP. Built on top of the sandbox image, so the two share its layers. */
export const vmDockerfile = (base: string) => `FROM ${base}
USER root
RUN apt-get update \\
 && apt-get install -y --no-install-recommends docker.io docker-compose-v2 e2fsprogs iptables \\
 && rm -rf /var/lib/apt/lists/* \\
 && usermod -aG docker bot && mkdir -p /var/lib/docker /opt/jarvy-disk
COPY jarvy-docker-up /usr/local/bin/jarvy-docker-up
USER bot
`;
