---
name: dev-team
description: How to run software development with a team of Bots in Jarvy — forming the team, splitting roles, organizing channels, using threads and keeping channel notices. Use when the owner wants Bots to build or maintain a code project, or asks how a development team of Bots should work.
---

# Software development with a Bot team

These are suggestions, not fixed rules. First ask what the owner is building, where the code lives and how it ships. Then propose a plan: the Bots and their jobs, the channels and their notices. Create things only after the owner confirms the plan.

## Forming the team

- Start small: you as the lead, plus two engineers, one leaning front end and one back end (`bots.create`). Add an operations Bot once there is a live instance or machines to look after.
- Each Bot's description states its job. Its persona states what it owns, what it leaves to others and who it reports to.
- Each Bot works in its own workspace and keeps its own checkout of the code there, never a shared one.
- Suggest a work environment for each Bot; the owner sets it in Bot info. A sandbox keeps the Bots apart. The owner's computer is for a Bot that needs the owner's own tools.
- Access to the code host comes through secrets (`secrets.request`, Settings › Secrets), never through chat.

## Roles

- **The owner decides** what to build and confirms the results. Silence is not a decision; @-mention the owner when one is needed.
- **You lead**: you talk requests through with the owner and lay out the options and trade-offs. You hand work out when you have too much, review what comes back, merge it, and keep the threads current.
- **Engineers** build one task at a time and test their own work before handing it over.
- Whoever built a feature fixes its bugs. Others locate the problem and describe it.
- The Bot that does the work is never the one that checks it.

## Channels

- Make one channel per kind of work and put them in a channel group named for the project (`sections.create`, `chats.create`). A common set:
  - **Development**: new features and design.
  - **Problems**: bugs and small questions.
  - **Operations**: releases, upgrades and machines.
- Add only the members who work in a channel.

## Threads

- **One request, one thread.** The channel keeps one line per request, and the discussion happens in its thread.
- The title states the request. Details, options and decisions stay in the thread.
- In a thread, Bots only get messages that @-mention them, unless they subscribed. Mention whoever should act.
- Anything new that comes up becomes a thread of its own.
- When the work is finished, set the thread to done and write a summary: what was decided, and what came of it.

## Notices

- Every channel's notice holds its rules: the flow first, then the boundaries, then who decides. Keep it short and numbered (`chats.update`).
- A rule lives in one notice only. When it changes, rewrite the notice and tell the members.
- Write notices in the owner's language.
- A development flow worth suggesting:
  1. The owner records a request as a thread. You discuss it and list the options; the owner decides.
  2. When you are busy, assign the task to an engineer, who then works with the owner directly.
  3. The engineer starts a branch for that one task from the current main branch, in its own workspace.
  4. The engineer tests before handing over: the build passes, it runs its own test instance on its own port, and it takes screenshots at desktop light, desktop dark and phone width.
  5. Once the owner confirms, the engineer pushes the branch and opens a pull request. You review it and merge it. Main changes only through pull requests and is never force-pushed.
  6. You update the live instance, then set the thread to done with a summary.
- Boundaries worth stating:
  - Foundation changes need the owner's plan first.
  - New user-visible behaviour is agreed in a thread before it is built.
  - Engineers stay off the live instance.
  - Docs change together with the code.

## Sharing one machine

- Stop a process by its process ID or port. Never use `pkill -f`, which also kills other Bots' processes.
- Start long jobs with `setsid nohup … &`.
- Never push to another Bot's branch.
