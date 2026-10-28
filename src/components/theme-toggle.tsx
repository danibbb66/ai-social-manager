"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Interruttore tema chiaro/scuro in stile iOS (switch con manopola che scorre).
 * Lo stato vive sull'elemento `<html>` (classe `.dark`) e persiste in
 * `localStorage.theme`; il colore di sfondo/testo del body segue le variabili
 * CSS definite in globals.css.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // localStorage non disponibile: il tema resta solo per questa sessione.
    }
  }

  return (
    <div className={cn("flex items-center justify-between", className)}>
      <span className="text-sm font-medium text-slate-600 dark:text-slate-400">
        Tema scuro
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label="Tema scuro"
        onClick={toggle}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200",
          dark
            ? "bg-sky-600"
            : "bg-slate-300 dark:bg-slate-700"
        )}
      >
        <span
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200",
            dark ? "translate-x-5" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
