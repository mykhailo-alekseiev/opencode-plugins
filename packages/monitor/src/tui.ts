import { Plugin } from "@opencode/plugin/tui";
import { formatDuration } from "./duration";
import { MonitorRpc, readMonitors, readStopped, type MonitorSummary } from "./rpc";

export const STOP_BINDING = "ctrl+k";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default Plugin.define({
  id: "mykhailo.monitor.tui",
  setup(context) {
    const locationOf = (sessionID: string) => context.data.session.get(sessionID)?.location ?? context.location;

    const familyOf = (sessionID: string) => {
      const family = context.data.session.family(sessionID);
      return family.includes(sessionID) ? family : [sessionID, ...family];
    };

    const list = async (sessionID: string): Promise<MonitorSummary[] | undefined> => {
      try {
        const result = await context.client.rpc(MonitorRpc).list({ sessionIDs: familyOf(sessionID) }, { location: locationOf(sessionID) });
        return readMonitors(result);
      } catch (error) {
        context.ui.toast.show({ variant: "error", message: `Could not list monitors: ${errorMessage(error)}` });
        return undefined;
      }
    };

    const stop = async (sessionID: string, id: string) => {
      try {
        const stopped = readStopped(await context.client.rpc(MonitorRpc).stop({ id }, { location: locationOf(sessionID) }));
        context.ui.toast.show({
          variant: stopped ? "success" : "warning",
          message: stopped ? `Monitor ${id} stopped.` : `Monitor ${id} is not running.`,
        });
      } catch (error) {
        context.ui.toast.show({ variant: "error", message: `Could not stop monitor ${id}: ${errorMessage(error)}` });
      }
    };

    const show = async (sessionID: string): Promise<void> => {
      const monitors = await list(sessionID);
      if (!monitors) return;
      if (monitors.length === 0) {
        context.ui.toast.show({ variant: "info", message: "No monitors are running in this session." });
        return;
      }

      const now = Date.now();
      const selected = await context.ui.dialog.select({
        title: "Monitors",
        options: monitors.map((monitor) => ({
          title: monitor.description,
          value: monitor.id,
          description: monitor.command,
          footer: `${formatDuration(now - monitor.startedAt)} · ${formatDuration(Math.max(0, monitor.expiresAt - now))} left`,
          category: monitor.sessionID === sessionID ? undefined : "Subagents",
        })),
        actions: [
          {
            bind: STOP_BINDING,
            title: "Stop",
            onTrigger: (id) => {
              void stop(sessionID, id).then(() => {
                context.ui.dialog.clear();
                return show(sessionID);
              });
            },
          },
        ],
      });
      if (!selected) return;

      const monitor = monitors.find((item) => item.id === selected);
      if (monitor) await context.ui.dialog.alert({ title: `${monitor.id} · ${monitor.description}`, message: monitor.command });
    };

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "mykhailo.monitor.list",
          title: "Monitors",
          description: "List and stop the background monitors of this session",
          group: "Monitor",
          palette: true,
          slash: { name: "monitors" },
          run: () => {
            const route = context.ui.router.current();
            if (route.type !== "session") {
              context.ui.toast.show({ variant: "info", message: "Open a session to see its monitors." });
              return;
            }
            void show(route.sessionID);
          },
        },
      ],
    }));
  },
});
