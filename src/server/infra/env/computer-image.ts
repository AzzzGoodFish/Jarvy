/** The image a Bot's sandbox starts from (A50), built on this machine: Ubuntu 24.04 with Node, Python, git,
 * build tools and Playwright with its browsers (the package matches the browsers and any script finds it). The Bot
 * runs as `bot`, with the owner's user and group ids so files it makes in the mounted workspace are the owner's; sudo
 * lets it install software, which stays until its computer is reset. One image serves every Bot and is stored once,
 * so what most Bots need belongs here and the rest is theirs to install (fish m992–m994). */
export const COMPUTER_DOCKERFILE = `FROM mcr.microsoft.com/playwright:v1.61.1-noble
ARG UID=1000
ARG GID=1000
RUN apt-get update \\
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl fonts-noto-cjk git python3 python3-dev python3-pip python3-venv sudo \\
 && rm -rf /var/lib/apt/lists/* \\
 && npm install -g playwright@1.61.1 && npm cache clean --force \\
 && taken="$(getent passwd "$UID" | cut -d: -f1)"; if [ -n "$taken" ]; then userdel -r "$taken" 2>/dev/null || userdel "$taken"; fi \\
 && (getent group "$GID" > /dev/null || groupadd -g "$GID" bot) \\
 && useradd -m -u "$UID" -g "$GID" -s /bin/bash bot \\
 && install -d -o "$UID" -g "$GID" /home/bot/.npm-global /home/bot/.npm-global/bin /home/bot/.npm-global/lib \\
 && echo "bot ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/bot && chmod 0440 /etc/sudoers.d/bot \\
 && mkdir -p /workspace && chown "$UID:$GID" /workspace
ENV NPM_CONFIG_PREFIX=/home/bot/.npm-global PATH=/home/bot/.npm-global/bin:$PATH \\
    NODE_PATH=/home/bot/.npm-global/lib/node_modules:/usr/lib/node_modules
USER bot
WORKDIR /workspace
`;
