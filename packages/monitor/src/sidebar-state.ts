import type { MonitorSummary } from "./rpc";

export type SidebarState = {
  monitors: MonitorSummary[];
  error: boolean;
};

// Each mounted session owns a feed, so late replies cannot leak across tabs.
export function createSidebarFeed(
  load: () => Promise<MonitorSummary[] | undefined>,
  update: (state: SidebarState) => void,
) {
  let disposed = false;
  let loading = false;

  return {
    async refresh() {
      if (disposed || loading) return;
      loading = true;
      try {
        const monitors = await load();
        if (!disposed) update({ monitors: monitors ?? [], error: monitors === undefined });
      } catch {
        if (!disposed) update({ monitors: [], error: true });
      } finally {
        loading = false;
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
