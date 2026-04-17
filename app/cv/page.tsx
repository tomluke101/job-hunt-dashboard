import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import { ScrollText } from "lucide-react";

export default function CVPage() {
  return (
    <div className="p-8">
      <PageHeader
        title="CV Builder"
        description="Adapt your CV to every role automatically"
      />
      <ComingSoon
        icon={ScrollText}
        title="Adaptive CV Generator"
        description="Your base CV, intelligently reordered and reworded for each application — surfacing the skills and experience that matter most for that specific role."
        features={[
          "Upload your master CV once",
          "AI reorders and rewrites sections to match each JD",
          "Keyword optimisation for ATS systems",
          "Preserves your authentic voice and facts",
          "Side-by-side diff view to see what changed and why",
        ]}
      />
    </div>
  );
}
