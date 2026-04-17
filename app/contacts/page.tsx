import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import { Users } from "lucide-react";

export default function ContactsPage() {
  return (
    <div className="p-8">
      <PageHeader
        title="Contacts"
        description="Find the right people and craft messages that open doors"
      />
      <ComingSoon
        icon={Users}
        title="Contact Finder & Outreach Drafter"
        description="Identify hiring managers, recruiters, and relevant employees at target companies — then generate personalised outreach messages that actually get replies."
        features={[
          "Searches LinkedIn, company sites, and public data for contacts",
          "Finds hiring managers, team leads, and relevant employees",
          "Drafts personalised LinkedIn messages and cold emails",
          "Falls back to template outreach if no contact found",
          "Tracks who you've messaged and their responses",
        ]}
      />
    </div>
  );
}
