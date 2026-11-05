/** @jsxImportSource @opentui/solid */

import type { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { formatDuration } from "./duration";
import type { MonitorSummary } from "./rpc";
import { createSidebarFeed, type SidebarState } from "./sidebar-state";

const REFRESH_MS = 2_000;

export function registerMonitorSidebar(
  context: Plugin.Context,
  load: (sessionID: string) => Promise<MonitorSummary[] | undefined>,
  show: (sessionID: string) => Promise<void>,
) {
  return context.ui.slot({
    append: "sidebar.content",
    render: (props) => {
      const [state, setState] = createSignal<SidebarState>({ monitors: [], error: false });
      const [now, setNow] = createSignal(Date.now());

      createEffect(() => {
        const sessionID = props.sessionID;
        // Reconnect when a subagent is added or the session's location changes.
        context.data.session.family(sessionID);
        context.data.session.get(sessionID)?.location;
        untrack(() => {
          setState({ monitors: [], error: false });
          const feed = createSidebarFeed(() => load(sessionID), setState);
          void feed.refresh();
          const timer = setInterval(() => {
            setNow(Date.now());
            void feed.refresh();
          }, REFRESH_MS);
          onCleanup(() => {
            clearInterval(timer);
            feed.dispose();
          });
        });
      });

      return (
        <Show when={state().error || state().monitors.length > 0}>
          <box>
            <text fg={context.theme.text.base} onMouseUp={() => void show(props.sessionID)}>
              <b>Monitors{state().error ? "" : ` (${state().monitors.length})`}</b>
            </text>
            <Show when={state().error}>
              <text fg={context.theme.text.muted}>Unable to refresh monitors</text>
            </Show>
            <For each={state().monitors}>
              {(monitor) => (
                <box onMouseUp={() => void show(props.sessionID)}>
                  <text fg={context.theme.text.base} wrapMode="word">
                    ● {monitor.description}
                  </text>
                  <text fg={context.theme.text.muted} wrapMode="word">
                    {formatDuration(Math.max(0, now() - monitor.startedAt))} elapsed ·{" "}
                    {formatDuration(Math.max(0, monitor.expiresAt - now()))} left
                    {monitor.sessionID === props.sessionID ? "" : " · Subagent"}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      );
    },
  });
}
