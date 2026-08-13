"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/programs", label: "Programs" },
  { href: "/settings/services", label: "Services" },
  { href: "/settings/users", label: "Users" },
  { href: "/settings/fpl", label: "FPL" },
  { href: "/settings/forms", label: "Forms" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/database", label: "Database" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <div className="seg">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={pathname.startsWith(t.href) ? "on" : ""}
          style={{
            display: "inline-block", padding: "8px 14px", textDecoration: "none",
            fontFamily: "var(--font-sub)", fontWeight: 700, fontSize: 11, letterSpacing: ".03em",
            textTransform: "uppercase",
            background: pathname.startsWith(t.href) ? "var(--calv-slate)" : "#fff",
            color: pathname.startsWith(t.href) ? "#fff" : "var(--calv-slate)",
            borderRight: "1px solid var(--calv-slate-15)",
          }}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
