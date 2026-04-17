import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import { Bell } from "lucide-react";

export default function AlertsPage() {
  return (
    <div className="p-8">
      <PageHeader
        title="Daily Alerts"
        description="Get new roles delivered to you every day"
      />
      <ComingSoon
        icon={Bell}
        title="Daily Role Digest"
        description="Receive a curated digest of new roles matching your criteria every morning, or trigger an on-demand search whenever you like."
        features={[
          "Set a daily delivery time (e.g. 8 AM)",
          "Choose your channels: email, Slack, or in-app",
          "Request an on-demand search at any time",
          "Each alert includes a role summary and quick-apply actions",
          "Digest highlights the top 5–10 best-matched roles",
        ]}
      />
    </div>
  );
}
