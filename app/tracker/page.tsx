import PageHeader from "../_components/PageHeader";
import ApplicationTable from "./_components/ApplicationTable";

export default function TrackerPage() {
  return (
    <div className="p-8">
      <PageHeader
        title="Applications"
        description="Track every role you've applied to"
      >
        <label className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg cursor-pointer hover:bg-slate-50 transition-colors">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7.5 1v13M1 7.5h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Bulk Upload
          <input type="file" accept=".csv,.xlsx" className="hidden" />
        </label>
        <button className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
          + Add Application
        </button>
      </PageHeader>

      <ApplicationTable />
    </div>
  );
}
