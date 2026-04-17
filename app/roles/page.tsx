import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import { Search } from "lucide-react";

export default function RolesPage() {
  return (
    <div className="p-8">
      <PageHeader
        title="Ideal Roles"
        description="Find roles that match your profile and goals"
      />
      <ComingSoon
        icon={Search}
        title="Role Discovery"
        description="Set your criteria once and we'll surface the best-matched roles from across the web, ranked by fit and filtered to your preferences."
        features={[
          "Define your target role types, seniority, and sector",
          "Set salary range, location, and remote preferences",
          "AI ranks roles by fit against your CV and goals",
          "Summarises each role: pros, cons, earnings, career path",
          "One-click to generate a tailored cover letter or CV",
        ]}
      />
    </div>
  );
}
