interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "blue" | "green" | "amber" | "red" | "purple";
}

const accentBar: Record<NonNullable<StatCardProps["accent"]>, string> = {
  blue:   "bg-blue-500",
  green:  "bg-emerald-500",
  amber:  "bg-amber-500",
  red:    "bg-red-500",
  purple: "bg-purple-500",
};

const accentText: Record<NonNullable<StatCardProps["accent"]>, string> = {
  blue:   "text-blue-600",
  green:  "text-emerald-600",
  amber:  "text-amber-600",
  red:    "text-red-600",
  purple: "text-purple-600",
};

export default function StatCard({ label, value, sub, accent = "blue" }: StatCardProps) {
  return (
    <div className="relative bg-white rounded-xl border border-slate-200 p-5 shadow-sm overflow-hidden">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${accentBar[accent]}`} />
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">{label}</p>
      <p className={`text-3xl font-bold tracking-tight ${accentText[accent]}`}>{value}</p>
      {sub && <p className="text-slate-400 text-xs mt-1.5">{sub}</p>}
    </div>
  );
}
