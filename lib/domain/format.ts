export const money = (value: number, asset = "USDC") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: asset === "USDC" ? "USD" : "USD", minimumFractionDigits: 2 }).format(value);

export const compactMoney = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);

export const shortId = (value: string, start = 7, end = 5) => value.length <= start + end + 1 ? value : `${value.slice(0, start)}…${value.slice(-end)}`;

export const titleCase = (value: string) => value.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

export const relativeTime = (iso: string) => {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};
