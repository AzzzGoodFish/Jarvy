---
name: setup
description: How to help the owner get Jarvy ready — model connections, Docker for the Bots' sandboxes (not installed, not running or not allowed), reaching Jarvy from phones and other devices, adding other machines, and secrets. Use when the owner is new, when your environment names a problem, or when they ask how to set something up.
---

# Getting Jarvy ready

These are suggestions for the owner, not steps to run yourself. Take one thing at a time, in the owner's words, and check each before the next. Settings is opened from the owner's name at the bottom of the sidebar; its sections are named below in English and Chinese.

## What you can and can't do

- You can't add model connections, keys, logins or machine passwords. The owner does that in Settings; tell them where.
- When Docker can't be used, your own file and command tools don't work either. Then every check is a command the owner runs in a terminal on the computer running Jarvy, pasting the output back to you. Give one command at a time and say what you expect to see.
- Never ask for a password, token or key in the chat.

## 1. Models

A Bot needs a model to work. Settings › Models (设置 › 模型) adds a provider: a subscription login, an API key, or a custom API. `models.list` shows what is there. Without any, point the owner there first.

## 2. Docker for the Bots' sandboxes

Every Bot works in a sandbox of its own, a Docker container on the computer running Jarvy. Without Docker, Bots can still chat, and they can work on another machine they are allowed to switch to, but they can't read or write files or run commands in their sandboxes. Your environment line and `environments.list` say why Docker can't be used. Bot info › Environment (环境) shows the owner the same.

**Not installed.** Ask which system the computer runs.
- Linux: Docker Engine, from https://docs.docker.com/engine/install/ for their distribution (or the distribution's own `docker.io` package).
- macOS: Docker Desktop (https://docs.docker.com/desktop/), or another runtime that provides the `docker` command, such as OrbStack or Colima.
- Windows: Docker Desktop, which runs on WSL 2. When Jarvy runs inside a WSL distribution, Docker Desktop's WSL integration is turned on for that distribution.

**Installed but not running.**
- Linux: `sudo systemctl enable --now docker` starts it now and at every boot. `systemctl status docker` shows why it stopped.
- macOS and Windows: open Docker Desktop and wait until it says it is running.

**Not allowed for the user Jarvy runs as.** Docker answers only root and the members of the `docker` group.
- Say first what this gives: whoever can use Docker can become root on that computer, and so can every Bot through its sandbox. On a computer shared with others, or holding things the Bots shouldn't reach, suggest rootless Docker (https://docs.docker.com/engine/security/rootless/) or a separate machine.
- To allow it: `sudo usermod -aG docker "$USER"`, run as that user.
- A group is taken up when the user logs in, so they log out and in again (or restart the computer), check with `docker version` that the Server part now answers, and restart Jarvy from that new login: `jarvy off`, then `jarvy`.

**Afterwards.** Jarvy looks for Docker again every 30 seconds, so after installing or starting it nothing needs restarting, except for the group change above. The first sandbox to start builds the sandboxes' image, which takes a few minutes and about 3 GB of disk. `docker version` failing in another way: ask for its whole output and read it with them.

**Virtual machine sandboxes (optional, Linux only).** A Bot's sandbox can instead be a small virtual machine, run by Kata Containers, in which the Bot can use Docker and Docker Compose itself. Bot info › Environment (环境) › Type (类型) offers it once Jarvy finds that the computer can run one, and says why not otherwise.
- It needs KVM: `ls -l /dev/kvm` exists, and `grep -cwE 'vmx|svm' /proc/cpuinfo` is above 0 (virtualization turned on in the firmware). Not on macOS or Windows.
- Installing Kata: download `kata-static-<version>-amd64.tar.zst` from https://github.com/kata-containers/kata-containers/releases, then `sudo tar --zstd -xf kata-static-<version>-amd64.tar.zst -C /` (it unpacks to /opt/kata) and `sudo ln -sf /opt/kata/runtime-rs/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2`. Docker's own settings stay as they are, and nothing needs restarting.
- "Taken by other virtual machine software": while a VirtualBox machine runs, KVM can't, and the other way round. Stop that machine, or move it to KVM (virt-manager or libvirt).
- Then Check again (重新检查) in Bot info. Each VM takes the memory and CPUs it is given (4 GB and 2 by default), changed with its size, which takes effect at its next start. Switching type makes the sandbox afresh: the workspace stays, installed software goes.

## 3. Phones and other devices

By default Jarvy answers only on the computer running it. Settings › Network (设置 › 网络) turns on LAN access (局域网访问) and shows the addresses to open on other devices. They reach it over HTTPS with Jarvy's own certificate: each device installs and trusts it once, from Download certificate (下载证书) there, which also has the steps for Mac, Windows, iPhone and Android. Until a device trusts it, its browser warns that the connection isn't private. Plain HTTP can be allowed there too, but then others on the same network could read passwords and conversations.

## 4. Other machines

A Bot that needs another computer, the one running Jarvy included, works there over SSH. The owner adds the machine in Settings › Environments (设置 › 工作环境) with Add machine (添加机器), then allows each Bot that may use it in Bot info › Environment (环境). You can ask for one with `environments.request`; the owner types its password on that card. A Bot reaches on that machine everything its login user can, so suggest a user with only what the work needs.

## 5. Secrets

Tokens and keys the Bots need, such as for a code host, go in Settings › Secrets (设置 › 密钥), each given to the Bots that may use it. A Bot asks for a missing one with `secrets.request`.
