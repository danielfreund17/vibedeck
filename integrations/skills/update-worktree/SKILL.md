---
name: update-worktree
description: Update the active VibeDeck tab/session so it tracks the actual git worktree, branch, and PR for the current task. Use when the user asks to update VibeDeck, fix VibeDeck worktree/PR tracking, update the tab context, or when the current work is happening in a worktree different from the agent process cwd.
---

Update VibeDeck's active vertical tab to the real worktree for this task.

Do not assume the agent process cwd is the worktree. In agentic sessions, the worktree is often only visible in recent shell/tool commands such as `cd /.../git-repos/wor/t123456/repo && ...`.

Steps:

1. Identify the actual worktree directory for the current task.
   - Prefer an explicit absolute path from the recent conversation/tool commands.
   - Prefer paths under `git-repos/wor/` when present.
   - If multiple repos are involved, choose the repo the current user request is about; if ambiguous, ask which repo/worktree to use.
   - Verify the candidate with `git -C <path> rev-parse --show-toplevel` when practical.
2. Choose a short title.
   - Use a user-provided title if present.
   - Otherwise use the task/PR context, e.g. `CXLLM Streaming`, `Uniclient Deploy`, or the PR title/branch summary.
3. Run the shared helper from inside the worktree:

```bash
cd "<actual-worktree-path>" && vibedeck-update-worktree "<short title>"
```

4. Report the helper output briefly.

Important:
- Running `vibedeck-update-worktree` from the wrong cwd will update VibeDeck to the wrong branch/PR.
- A child shell cannot change the parent agent process cwd; the `cd ... && vibedeck-update-worktree ...` command is the intended mechanism.
- The helper updates VibeDeck through a file side-channel, so it works even when terminal escape sequences are captured by an agent TUI.
