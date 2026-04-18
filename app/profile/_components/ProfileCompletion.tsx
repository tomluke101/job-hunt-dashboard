import { CheckCircle2, Circle } from "lucide-react";
import type { ProfileCompleteness } from "@/app/actions/profile";

const steps = [
  {
    key: "hasConstants" as const,
    label: "Your details",
    description: "Name, contact info, sign-off",
    required: true,
  },
  {
    key: "hasCV" as const,
    label: "Your CV",
    description: "Uploaded and ready",
    required: true,
  },
  {
    key: "hasSkills" as const,
    label: "Skills & experience",
    description: "Achievements beyond your CV",
    required: true,
  },
  {
    key: "hasWritingExamples" as const,
    label: "Writing style",
    description: "Past cover letters for tone matching",
    required: false,
  },
];

export default function ProfileCompletion({ completeness }: { completeness: ProfileCompleteness }) {
  const percent = Math.round((completeness.score / 4) * 100);
  const isReady = completeness.score >= 3;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-slate-900">Profile Setup</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {isReady
              ? "Your profile is ready — cover letters will be highly personalised."
              : "Complete your profile so the AI can write cover letters that sound like you."}
          </p>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-bold ${isReady ? "text-emerald-600" : "text-blue-600"}`}>{percent}%</p>
          <p className="text-xs text-slate-400">{completeness.score} of 4 complete</p>
        </div>
      </div>

      <div className="h-2 bg-slate-100 rounded-full overflow-hidden mb-5">
        <div
          className={`h-full rounded-full transition-all duration-500 ${isReady ? "bg-emerald-500" : "bg-blue-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {steps.map((step) => {
          const done = completeness[step.key];
          return (
            <div key={step.key} className={`flex items-start gap-2.5 p-3 rounded-lg ${done ? "bg-slate-50" : "bg-amber-50/60 border border-amber-100"}`}>
              {done
                ? <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 shrink-0" />
                : <Circle size={16} className="text-amber-400 mt-0.5 shrink-0" />}
              <div>
                <p className="text-sm font-medium text-slate-800">
                  {step.label}
                  {!step.required && <span className="ml-1.5 text-xs text-slate-400 font-normal">Optional</span>}
                </p>
                <p className="text-xs text-slate-500">{step.description}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
