export function formatDuration(ms: number) {
  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [hours && `${hours}h`, minutes && `${minutes}m`, seconds && `${seconds}s`].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "0s";
}
