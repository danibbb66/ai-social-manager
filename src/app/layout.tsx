import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

export const metadata: Metadata = {
  title: {
    default: "Social Manager",
    template: "%s · Social Manager",
  },
  description:
    "Gestione contenuti social per agenzia di viaggi con AI locale (Ollama)",
};

const themeInit = `
(function () {
  try {
    if (localStorage.getItem('theme') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it" suppressHydrationWarning>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 min-w-0 px-4 py-6 sm:px-8 lg:px-10">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}