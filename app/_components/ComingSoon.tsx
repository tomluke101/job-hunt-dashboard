import { LucideIcon } from "lucide-react";

interface ComingSoonProps {
  icon: LucideIcon;
  title: string;
  description: string;
  features: string[];
}

export default function ComingSoon({ icon: Icon, title, description, features }: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[460px] text-center px-4">
      <div className="w-16 h-16 bg-gradient-to-br from-blue-50 to-blue-100 rounded-2xl flex items-center justify-center mb-5 shadow-sm border border-blue-100">
        <Icon size={26} className="text-blue-500" />
      </div>
      <h2 className="text-xl font-bold text-slate-900 tracking-tight mb-2">{title}</h2>
      <p className="text-slate-500 text-sm max-w-md leading-relaxed mb-7">{description}</p>

      <div className="bg-white border border-slate-200 rounded-2xl p-6 w-full max-w-sm text-left shadow-sm mb-6">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">What this will do</p>
        <ul className="space-y-2.5">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
              <span className="mt-0.5 w-4 h-4 rounded-full bg-blue-50 border border-blue-200 flex items-center justify-center shrink-0">
                <span className="text-blue-500 text-[10px] font-bold">✓</span>
              </span>
              {f}
            </li>
          ))}
        </ul>
      </div>

      <span className="inline-flex items-center gap-2 bg-amber-50 text-amber-700 text-xs font-semibold px-3.5 py-1.5 rounded-full border border-amber-200">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        Coming soon
      </span>
    </div>
  );
}
