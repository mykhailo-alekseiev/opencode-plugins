# `@mykhailo-alekseiev/opencode-monitor`

Runs a shell command in the background and wakes the session with each line it prints, like Claude Code's `Monitor` tool. Use it to babysit a pull request, watch CI, tail a log, or wait for a long build without the agent writing `sleep` loops.

```text
[monitor mon_3db156b4 · PR 123 checks]
check failed: lint https://github.com/acme/app/actions/runs/1/job/2
Monitor exited with code 0.
```

## Install

Add the package directory to `opencode.jsonc`:

```jsonc
{
  "plugins": ["/path/to/opencode-plugins/packages/monitor"],
}
```

One entry loads the server tools, the TUI command, and the RPC part they share. Requires an OpenCode V2 release with `@opencode/plugin` 2.1.

## Use

- **`monitor`** starts `command` with `$SHELL -c` in the session directory and returns a `taskId`. `timeout_ms` defaults to 5 minutes and is capped at 24 hours.
- **`monitor_stop`** stops a monitor by `taskId` without a notice.
- **`/monitors`** or **Monitors** in the command palette (`ctrl+p`) lists the session's running monitors; `ctrl+k` stops the selected one.

Each stdout line is one event. Lines that arrive close together become one notice: after 1 second of quiet, or 5 seconds after the first line. While the session is working, notices wait until the turn ends. Notices are capped at 16 KB and keep the newest lines.

stderr is never an event; its last 20 lines arrive with the exit notice. A monitor ends when its command exits (one notice with the exit code), when `timeout_ms` passes (one notice), or silently when it is stopped, its session is deleted, the subagent that started it finishes, or OpenCode reloads the plugin.

The command does its own polling, so print only lines worth waking for and drop repeats:

```sh
while true; do
  gh pr checks 123 --json name,bucket,link --jq '.[] | select(.bucket == "fail") | "check failed: \(.name) \(.link)"'
  state=$(gh pr view 123 --json state --jq .state)
  if [ "$state" != OPEN ]; then echo "pull request $state"; break; fi
  sleep 60
done | awk '!seen[$0]++ {print; fflush()}'
```

Monitors run with your full permissions and no permission prompt. They live in memory and do not survive an OpenCode restart.
