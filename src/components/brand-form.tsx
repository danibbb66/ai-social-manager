"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, UploadCloud } from "lucide-react";
import { Button, Input, Textarea, Field } from "@/components/ui";
import { saveBrandAction } from "@/lib/actions/brand";

type Brand = {
  name: string;
  description: string | null;
  website: string | null;
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
  logoUrl: string | null;
  tone: string | null;
  audience: string | null;
  style: string | null;
  preferredTopics: string[] | null;
  forbiddenTopics: string[] | null;
  forbiddenWords: string[] | null;
  preferredCtas: string[] | null;
  colors: Record<string, string> | null;
  fonts: Record<string, string> | null;
};

function joinArray(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return "";
}

function parseArray(raw: string): string[] | null {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

function parseColorMap(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split(":").map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function toColorMapString(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, string>)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
  }
  return "";
}

export function BrandForm({ brand }: { brand: Brand | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: brand?.name ?? "",
    description: brand?.description ?? "",
    website: brand?.website ?? "",
    instagram: brand?.instagram ?? "",
    facebook: brand?.facebook ?? "",
    tiktok: brand?.tiktok ?? "",
    logoUrl: brand?.logoUrl ?? "",
    tone: brand?.tone ?? "",
    audience: brand?.audience ?? "",
    style: brand?.style ?? "",
    preferredTopics: joinArray(brand?.preferredTopics),
    forbiddenTopics: joinArray(brand?.forbiddenTopics),
    forbiddenWords: joinArray(brand?.forbiddenWords),
    preferredCtas: joinArray(brand?.preferredCtas),
    colors: toColorMapString(brand?.colors),
    fonts: toColorMapString(brand?.fonts),
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  // Upload del logo: il file viene salvato in /uploads e il percorso tornato
  // finisce nel campo `logoUrl`. Il campo accetta SOLO un percorso /uploads/…
  // (mai un percorso del PC né un URL remoto), quindi qui l'utente non deve
  // sapere nulla di cartelle: carica e basta.
  const logoFileRef = useRef<HTMLInputElement>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const uploadLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ""; // reset: riselezionare lo stesso file riemette l'evento
    if (!file) return;
    setSaveError(null);
    setUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setSaveError(body?.message ?? "Upload del logo non riuscito.");
        return;
      }
      const url = body?.assets?.[0]?.url as string | undefined;
      if (url) setForm((f) => ({ ...f, logoUrl: url }));
      else setSaveError("Upload riuscito ma senza percorso: riprova.");
    } catch {
      setSaveError("Upload del logo non riuscito. Riprova.");
    } finally {
      setUploadingLogo(false);
    }
  };

  const save = () =>
    startTransition(async () => {
      setSaveError(null);
      const res = await saveBrandAction({
        name: form.name,
        description: form.description || null,
        website: form.website || null,
        instagram: form.instagram || null,
        facebook: form.facebook || null,
        tiktok: form.tiktok || null,
        logoUrl: form.logoUrl || null,
        tone: form.tone || null,
        audience: form.audience || null,
        style: form.style || null,
        preferredTopics: parseArray(form.preferredTopics),
        forbiddenTopics: parseArray(form.forbiddenTopics),
        forbiddenWords: parseArray(form.forbiddenWords),
        preferredCtas: parseArray(form.preferredCtas),
        colors: parseColorMap(form.colors),
        fonts: parseColorMap(form.fonts),
      });
      if (res.ok === false) {
        setSaveError(res.message ?? "Salvataggio non riuscito.");
        return;
      }
      router.refresh();
    });

  return (
    // Form vera e propria: così il tasto Invio in qualsiasi campo salva,
    // invece di non fare nulla (prima non c'era alcun gestore di submit).
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {saveError ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {saveError}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome agenzia *">
          <Input
            value={form.name}
            onChange={set("name")}
            required
            placeholder="La Mia Agenzia di Viaggi"
          />
        </Field>
        <Field label="Sito web">
          <Input value={form.website} onChange={set("website")} placeholder="https://…" />
        </Field>
        <Field label="Instagram">
          <Input value={form.instagram} onChange={set("instagram")} placeholder="@handle" />
        </Field>
        <Field label="Facebook">
          <Input value={form.facebook} onChange={set("facebook")} placeholder="pagina" />
        </Field>
        <Field label="TikTok">
          <Input value={form.tiktok} onChange={set("tiktok")} placeholder="@handle" />
        </Field>
        <Field label="Logo" hint="Carica il file, oppure incolla un percorso /uploads/…">
          <div className="flex items-center gap-2">
            <Input
              value={form.logoUrl}
              onChange={set("logoUrl")}
              placeholder="/uploads/images/…"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => logoFileRef.current?.click()}
              disabled={uploadingLogo}
              aria-busy={uploadingLogo}
            >
              {uploadingLogo ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              {uploadingLogo ? "Caricamento…" : "Carica"}
            </Button>
          </div>
          <input
            ref={logoFileRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={uploadLogo}
          />
        </Field>
      </div>

      <Field label="Descrizione">
        <Textarea
          rows={3}
          value={form.description}
          onChange={set("description")}
          placeholder="Cosa fa l'agenzia, specializzazioni…"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tono di voce">
          <Textarea
            rows={3}
            value={form.tone}
            onChange={set("tone")}
            placeholder="Es. Caldo, entusiasta e informativo…"
          />
        </Field>
        <Field label="Pubblico">
          <Textarea
            rows={3}
            value={form.audience}
            onChange={set("audience")}
            placeholder="Es. Coppie e famiglie tra i 25 e i 55 anni…"
          />
        </Field>
      </div>

      <Field label="Stile visivo / testuale">
        <Textarea
          rows={2}
          value={form.style}
          onChange={set("style")}
          placeholder="Es. Fotografie vibranti, testi brevi…"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Argomenti preferiti" hint="Separati da virgola">
          <Input value={form.preferredTopics} onChange={set("preferredTopics")} placeholder="Sardegna, Grecia, isole…" />
        </Field>
        <Field label="Argomenti vietati" hint="Separati da virgola">
          <Input value={form.forbiddenTopics} onChange={set("forbiddenTopics")} placeholder="Politica…" />
        </Field>
        <Field label="Parole vietate" hint="Separati da virgola">
          <Input value={form.forbiddenWords} onChange={set("forbiddenWords")} placeholder="regalo, vinci subito…" />
        </Field>
        <Field label="CTA preferite" hint="Separate da virgola">
          <Input value={form.preferredCtas} onChange={set("preferredCtas")} placeholder="Prenota ora, Scopri di più…" />
        </Field>
        <Field label="Colori brand" hint="Formato chiave:valore, separati da virgola (es. primary:#0ea5e9, accent:#f97316)">
          <Input value={form.colors} onChange={set("colors")} placeholder="primary:#0ea5e9, accent:#f97316" />
        </Field>
        <Field label="Font" hint="Es. heading:Inter, body:Inter">
          <Input value={form.fonts} onChange={set("fonts")} placeholder="heading:Inter, body:Inter" />
        </Field>
      </div>

      <div className="flex justify-end border-t border-slate-100 pt-4">
        <Button type="submit" disabled={pending || !form.name.trim()}>
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Salva brand
        </Button>
      </div>
    </form>
  );
}