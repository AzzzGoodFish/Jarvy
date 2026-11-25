---
name: setup
description: How to help the owner get Jarvy ready — model connections, Docker or KVM VMs for Bots' sandboxes, reaching Jarvy from phones and other devices, adding SSH machines or connected desktop devices, secrets, and external service connectors. Use when the owner is new, when environments.list names a problem, or when they ask how to set something up.
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

Every Bot works in a sandbox of its own, a Docker container on the computer running Jarvy. Without Docker, Bots can still chat, and they can work on another machine they are allowed to switch to, but they can't read or write files or run commands in their sandboxes. `environments.list` says why Docker can't be used. Bot info › Environment (环境) shows the owner the same.

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

**Virtual machine sandboxes (optional, Linux only).** A Bot's sandbox can instead be a full Linux virtual machine (Ubuntu 24.04 with systemd, full Linux kernel, dedicated `/workspace` disk, swap, Docker and Docker Compose), managed by libvirt and QEMU (`qemu:///system`). Bot info › Environment (环境) › Type (类型) offers it once Jarvy finds that the computer can run KVM VMs, and says why not otherwise. VM sandboxes work even without Docker on the host.
- It needs KVM: `ls -l /dev/kvm` exists, and `grep -cwE 'vmx|svm' /proc/cpuinfo` is above 0 (virtualization turned on in the firmware). Not on macOS or Windows.
- Installing libvirt and QEMU (Ubuntu/Debian): `sudo apt-get update && sudo apt-get install -y libvirt-daemon-system qemu-system-x86 qemu-utils cloud-image-utils` and `sudo systemctl enable --now libvirtd`.
- Allowing the user Jarvy runs as: `sudo usermod -aG libvirt "$USER"`, then log out and in again (or restart the computer) and restart Jarvy from that new login (`jarvy off`, then `jarvy`).
- "Taken by other virtual machine software": while a VirtualBox machine runs, KVM can't, and the other way round. Stop that machine, or move it to KVM (virt-manager or libvirt).
- Then Check again (重新检查) in Bot info. Each VM takes the memory and CPUs it is given (4 GB and 2 vCPUs by default), changed with its size, which takes effect at its next start. Switching type preserves `/workspace` files in both directions (imported into the VM disk when switching to VM, exported back to the host workspace when switching back to container); the first VM start builds a shared Ubuntu 24.04 base template, which takes a few minutes.

## 3. Phones and other devices

By default Jarvy answers only on the computer running it. Settings › Network (设置 › 网络) turns on LAN access (局域网访问) and shows the addresses to open on other devices. They reach it over HTTPS with Jarvy's own certificate: each device installs and trusts it once, from Download certificate (下载证书) there, which also has the steps for Mac, Windows, iPhone and Android. Until a device trusts it, its browser warns that the connection isn't private. Plain HTTP can be allowed there too, but then others on the same network could read passwords and conversations.

## 4. Other machines and connected devices

A Bot can also work outside its sandbox on:
- **SSH machines**: the owner adds a machine in Settings › Environments (设置 › 工作环境) with Add machine (添加机器), then grants each Bot that may use it in Bot info › Environment (环境). A Bot can also ask for one with `environments.request`; the owner enters its password or key on that card. Because a Bot reaches everything its SSH login user can, suggest a user scoped to what the work needs.
- **Connected desktop devices**: the owner can connect their own Windows, macOS, or Linux computer via the Jarvy desktop client / connector from Settings › Environments (设置 › 工作环境), then grant Bots access per device. While the client is offline or paused, tools there fail and say so.

## 5. Secrets

Reusable credentials the Bots need (logins, API keys, database credentials, or custom structured secrets) go in Settings › Secrets (设置 › 密钥), each granted to the Bots that may use it. A Bot asks for a missing one with `secrets.request`.

## 6. Connectors

External services such as GitHub, Gmail, Linear, or custom remote HTTP MCP servers are connected in Settings › Connectors (设置 › 连接器). Newly connected accounts start ungranted; Bots discover them with `connectors.list` and ask for access on a card with `connectors.request` (every write action also pauses for the owner's confirmation).
