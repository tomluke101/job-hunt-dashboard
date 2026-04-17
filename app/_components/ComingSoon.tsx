import { LucideIcon } from "lucide-react";

interface ComingSoonProps {
  icon: LucideIcon;
  title: string;
  description: string;
  features: string[];
}

export default function ComingSoon({ icon: Icon, title, description, features }: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] text-center px-4">
      <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mb-4">
        <Icon size={28} className="text-blue-500" />
      </div>
      <h2 className="text-xl font-bold text-slate-900 mb-2">{title}</h2>
      <p className="text-slate-500 text-sm max-w-md mb-6">{description}</p>
      <div className="bg-white border border-slate-200 rounded-xl p-5 w-full max-w-sm text-left shadow-sm">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">What this will do</p>
        <ul className="space-y-2">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
              <span className="text-blue-500 mt-0.5 font-bold">✓</span>
              {f}
            </li>
          ))}
        </ul>
      </div>
      <span className="mt-6 inline-flex items-center gap-1.5 bg-amber-50 text-amber-700 text-xs font-semibold px-3 py-1.5 rounded-full border border-amber-200">
        Coming soon
      </span>
    </div>
  );
}
