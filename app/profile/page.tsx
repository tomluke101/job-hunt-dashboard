import { User, FileText, Sparkles, Pencil, Settings2, Briefcase, Star } from "lucide-react";
import PageHeader from "@/app/_components/PageHeader";
import ProfileCompletion from "./_components/ProfileCompletion";
import ConstantsForm from "./_components/ConstantsForm";
import CVManager from "./_components/CVManager";
import WorkHistoryManager from "./_components/WorkHistoryManager";
import SkillsManager from "./_components/SkillsManager";
import WritingExamples from "./_components/WritingExamples";
import CoverLetterPrefsForm from "./_components/CoverLetterPrefsForm";
import MasterProfileSection from "./_components/MasterProfileSection";
import {
  getProfile, getCVs, getSkills, getWritingExamples, getProfileCompleteness, getCoverLetterPrefs, getEmployers,
} from "@/app/actions/profile";
import { getMasterProfile } from "@/app/actions/cv-tailoring";

function Section({ icon: Icon, title, description, children }: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center">
            <Icon size={16} className="text-slate-600" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 text-sm">{title}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{description}</p>
          </div>
        </div>
      </div>
      <div className="px-6 py-5">{children}</div>
    </div>
  );
}

export default async function ProfilePage() {
  const [profile, cvs, skills, writingExamples, completeness, clPrefs, employers, masterProfile] = await Promise.all([
    getProfile(),
    getCVs(),
    getSkills(),
    getWritingExamples(),
    getProfileCompleteness(),
    getCoverLetterPrefs(),
    getEmployers(),
    getMasterProfile(),
  ]);

  return (
    <div className="p-8 max-w-3xl">
      <PageHeader
        title="My Profile"
        description="Everything the AI needs to write cover letters that sound like you"
      />

      <ProfileCompletion completeness={completeness} />

      <div className="space-y-6">
        <Section
          icon={User}
          title="Your Details"
          description="Name, contact info, and how you sign off — used across every cover letter automatically"
        >
          <ConstantsForm initial={profile} />
        </Section>

        <Section
          icon={FileText}
          title="Your CV"
          description="The foundation of every cover letter — upload once and use across all applications"
        >
          <CVManager initial={cvs} />
        </Section>

        <Section
          icon={Briefcase}
          title="Work History"
          description="Your roles and dates — used by the AI to attribute skills and achievements to the right employer when writing cover letters"
        >
          <WorkHistoryManager initial={employers} hasCV={cvs.length > 0} />
        </Section>

        <Section
          icon={Sparkles}
          title="Skills & Experience"
          description="Achievements and experiences beyond your CV — tag each to the right role above so the AI places them correctly"
        >
          <SkillsManager initial={skills} employers={employers} />
        </Section>

        <Section
          icon={Star}
          title="Master Profile"
          description="Your canonical Profile section — generated once with AI help, edited freely, used as the base for every CV (tailored per role)"
        >
          <MasterProfileSection initial={masterProfile} />
        </Section>

        <Section
          icon={Pencil}
          title="Your Writing Style"
          description="Optional — paste a cover letter you've written before so the AI can match your voice"
        >
          <WritingExamples initial={writingExamples} />
        </Section>

        <Section
          icon={Settings2}
          title="Cover Letter Preferences"
          description="Set your greeting, contact header, things to always or never include, and tone notes — applied to every letter automatically"
        >
          <CoverLetterPrefsForm initial={clPrefs} />
        </Section>
      </div>
    </div>
  );
}
