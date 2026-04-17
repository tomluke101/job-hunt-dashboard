import ApplicationTable from "./_components/ApplicationTable";
import PageHeader from "../_components/PageHeader";

export default function TrackerPage() {
  return (
    <div className="p-8">
      <PageHeader
        title="Applications"
        description="Track every role you've applied to"
      />
      <ApplicationTable />
    </div>
  );
}
