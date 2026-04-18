"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import {
  LayoutDashboard,
  Search,
  Bell,
  FileText,
  ScrollText,
  Users,
  ClipboardList,
  BriefcaseBusiness,
  Settings,
  UserCircle,
} from "lucide-react";

const mainNav = [
  { href: "/",        label: "Overview",      icon: LayoutDashboard },
  { href: "/tracker", label: "Applications",  icon: ClipboardList },
  { href: "/roles",   label: "Ideal Roles",   icon: Search },
  { href: "/alerts",  label: "Daily Alerts",  icon: Bell },
];

const toolsNav = [
  { href: "/cover-letter", label: "Cover Letters", icon: FileText },
  { href: "/cv",           label: "CV Builder",    icon: ScrollText },
  { href: "/contacts",     label: "Contacts",      icon: Users },
];

const bottomNav = [
  { href: "/profile",  label: "My Profile", icon: UserCircle },
  { href: "/settings", label: "Settings",   icon: Settings },
];

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: React.ElementType; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-100 ${
        active
          ? "bg-white/10 text-white shadow-sm"
          : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
      }`}
    >
      <Icon size={16} className={active ? "text-blue-400" : "text-slate-500"} />
      {label}
      {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" />}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-1 text-xs font-semibold text-slate-600 uppercase tracking-wider">{children}</p>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const { user } = useUser();

  return (
    <aside className="w-60 shrink-0 bg-slate-900 flex flex-col min-h-screen sticky top-0 border-r border-slate-800">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-700 rounded-lg flex items-center justify-center shadow-md">
            <BriefcaseBusiness size={15} className="text-white" />
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight tracking-tight">HuntHQ</p>
            <p className="text-slate-500 text-xs">Job Hunt Dashboard</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 flex flex-col gap-0.5 overflow-y-auto">
        <SectionLabel>Workspace</SectionLabel>
        {mainNav.map(({ href, label, icon }) => (
          <NavLink key={href} href={href} label={label} icon={icon} active={pathname === href} />
        ))}

        <SectionLabel>Tools</SectionLabel>
        {toolsNav.map(({ href, label, icon }) => (
          <NavLink key={href} href={href} label={label} icon={icon} active={pathname === href} />
        ))}
      </nav>

      {/* Bottom nav + user */}
      <div className="px-3 pb-3 border-t border-slate-800">
        <div className="pt-3 space-y-0.5 mb-3">
          {bottomNav.map(({ href, label, icon }) => (
            <NavLink key={href} href={href} label={label} icon={icon} active={pathname === href} />
          ))}
        </div>
        <div className="flex items-center gap-3 px-3 py-2.5">
          <UserButton appearance={{ elements: { avatarBox: "w-7 h-7" } }} />
          <div className="flex-1 min-w-0">
            <p className="text-white text-xs font-medium truncate">
              {user?.firstName ?? user?.emailAddresses[0]?.emailAddress ?? "Account"}
            </p>
            <p className="text-slate-500 text-xs truncate">
              {user?.emailAddresses[0]?.emailAddress}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
