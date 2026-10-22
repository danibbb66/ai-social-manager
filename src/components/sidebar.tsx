"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FileText,
  CalendarDays,
  Image as ImageIcon,
  Palette,
  Share2,
  Settings,
  Plane,
  BookOpen,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: typeof FileText; hub?: boolean };

/**
 * Navigazione principale: il percorso del prodotto.
 * Chat crea, Contents controlla, Calendario pianifica.
 */
const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/generate", label: "Crea video & post", icon: Sparkles, hub: true },
  { href: "/planning", label: "Pianificazione", icon: CalendarDays, hub: true },
];

/**
 * Catalogo: la fonte da cui i contenuti potranno attingere.
 * Isolato in un gruppo proprio perché non è né un flusso editoriale né una
 * configurazione: è la base dati commerciale che va consultata a parte.
 */
const CATALOG_NAV: NavItem[] = [
  { href: "/catalog", label: "Catalogo Agenzia", icon: BookOpen },
];

/**
 * Configurazione: archivio asset, account, contesto AI, stato sistema.
 * Non fanno parte del flusso editoriale.
 */
const SETTINGS_NAV: NavItem[] = [
  { href: "/media", label: "Media", icon: ImageIcon },
  { href: "/social", label: "Social", icon: Share2 },
  { href: "/brand", label: "Brand", icon: Palette },
  { href: "/settings", label: "Impostazioni", icon: Settings },
];

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  // Active state invariato: "/" è attivo solo sulla home esatta, ogni altra
  // voce resta attiva anche su query string (?view=approvals) e sotto-route.
  const active =
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sky-50 text-sky-700"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
        // L'hub editoriale è evidenziato anche da spento: è la sezione da cui
        // passa tutto il lavoro sui contenuti.
        item.hub && !active && "text-slate-900"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {item.label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 border-r border-slate-200 bg-white sticky top-0 self-start h-screen overflow-y-auto">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-600 text-white">
          <Plane className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-bold text-slate-900">Social Manager</div>
          <div className="text-xs text-slate-500">Agenzia di viaggi</div>
        </div>
      </div>

      <nav className="space-y-1 px-3 pb-6">
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Principale
        </div>
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}

        <div className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Catalogo
        </div>
        {CATALOG_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}

        <div className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Configurazione
        </div>
        {SETTINGS_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </nav>
    </aside>
  );
}
