"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Search,
  Bell,
  FileText,
  ScrollText,
  Users,
  ClipboardList,
  BriefcaseBusiness,
} from "lucide-react";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/tracker", label: "Applications", icon: ClipboardList },
  { href: "/roles", label: "Ideal Roles", icon: Search },
  { href: "/alerts", label: "Daily Alerts", icon: Bell },
  { href: "/cover-letter", label: "Cover Letters", icon: FileText },
  { href: "/cv", label: "CV Builder", icon: ScrollText },
  { href: "/contacts", label: "Contacts", icon: Users },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 shrink-0 bg-slate-900 flex flex-col min-h-screen sticky top-0">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
            <BriefcaseBusiness size={16} className="text-white" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm leading-tight">Job Hunt</p>
            <p className="text-slate-500 text-xs">Command Centre</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              <Icon size={17} className={active ? "text-blue-400" : ""} />
              {label}
              {label === "Daily Alerts" && (
                <span className="ml-auto bg-blue-500 text-white text-xs font-semibold px-1.5 py-0.5 rounded-full">
                  3
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-slate-800">
        <p className="text-slate-600 text-xs text-center">
          Built for your job hunt
        </p>
      </div>
    </aside>
  );
}
