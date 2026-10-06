"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Save,
  Loader2,
  Trash2,
  Copy,
  Check,
  X,
  CalendarClock,
  Image as ImageIcon,
  RotateCcw,
  Rocket,
} from "lucide-react";
import {
  updateContentAction,
  deleteContentAction,
  duplicateContentAction,
  setStatusAction,
  scheduleAction,
  unscheduleAction,
  publishAction,
} from "@/lib/actions/content";
import { PLATFORM_LABELS, TYPE_OPTIONS } from "@/lib/status";
import {
  Card,
  CardHeader,
  Button,
  Input,
  Textarea,
  Select,
  Field,
  StatusBadge,
  TypeBadge,
  Badge,
  toDateTimeLocal,
  PLATFORM_VALUES,
} from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { ContentMediaSection } from "@/components/content/media-section";
import { ApprovalActions } from "@/components/content/approval-actions";

type EditorContent = {
  id: string;
  type: string;
  title: string | null;
  caption: string | null;
  hashtags: string | null;
  status: string;
  scheduledDate: string | null;
  platforms: { id: string; platform: string }[];
  assets: {
    id: string;
    kind: string;
    url: string;
    filename: string;
    mimeType: string | null;
    size: number | null;
  }[];
  slides: {
    id: string;
    imageUrl: string | null;
    title: string | null;
    text: string | null;
    order: number;
  }[];
};

type EditorApproval = {
  id: string;
  decision: string;
  note: string | null;
  decidedBy: string | null;
  createdAt: string;
};

type LibraryAsset = {
  id: string;
  url: string;
  filename: string;
  kind: string;
  contentId: string | null;
  content: { id: string; title: string | null; status: string } | null;
};

export function ContentEditor({
  content,
  approvals,
  hasExplicitApproval,
  library,
}: {
  content: EditorContent;
  approvals: EditorApproval[];
  hasExplicitApproval: boolean;
  library: LibraryAsset[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [title, setTitle] = useState(content.title ?? "");
  const [caption, setCaption] = useState(content.caption ?? "");
  const [hashtags, setHashtags] = useState(content.hashtags ?? "");
  const [type, setType] = useState(content.type);
  const [platforms, setPlatforms] = useState<Set<string>>(
    new Set(content.platforms.map((p) => p.platform))
  );
  const [scheduledDate, setScheduledDate] = useState(
    content.scheduledDate
      ? toDateTimeLocal(new Date(content.scheduledDate))
      : ""
  );

  const [showSchedule, setShowSchedule] = useState(false);
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const hasCaption = caption.trim().length > 0;

  // hasExplicitApproval arriva dal server (stessa query del publish gate):
  // non va ricalcolato qui sull'array `approvals`, che non è completo.
  const canApprove = content.status === "DRAFT";
  const canReject = content.status === "DRAFT";
  const canSchedule = content.status === "APPROVED";
  const canPublish =
    ["APPROVED", "SCHEDULED"].includes(content.status) && hasExplicitApproval;
  const canUnschedule = content.status === "SCHEDULED";
  const canRestoreDraft = ["REJECTED", "FAILED"].includes(content.status);

  /**
   * Instagram richiede obbligatoriamente un media. Se il contenuto è destinato
   * a Instagram ma non ha media, il publish viene bloccato in UI con un
   * warning chiaro invece di far fallire la pubblicazione lato server.
   */
  const instagramWithoutMedia = platforms.has("INSTAGRAM") && content.assets.length === 0;
  const publishable = !instagramWithoutMedia;

  const togglePlatform = (p: string) => {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  /**
   * Ripristina i campi sui valori arrivati dal server.
   *
   * Serve quando si annulla la modifica: senza questo, i valori digitati
   * restavano nello stato locale e continuavano a pilotare i gate di
   * approvazione/pubblicazione (es. una caption scritta ma mai salvata
   * rendeva "Approva" abilitato mentre in database la caption era vuota).
   */
  const resetForm = () => {
    setTitle(content.title ?? "");
    setCaption(content.caption ?? "");
    setHashtags(content.hashtags ?? "");
    setType(content.type);
    setPlatforms(new Set(content.platforms.map((p) => p.platform)));
    setScheduledDate(
      content.scheduledDate
        ? toDateTimeLocal(new Date(content.scheduledDate))
        : ""
    );
    setActionError(null);
    setActionMessage(null);
  };

  /**
   * Chiusura dei pannelli dopo un'azione riuscita.
   *
   * Non chiamiamo router.refresh(): ogni action usata da runAction revalida già
   * "/", "/contents", "/calendar" e "/contents/{id}" lato server, quindi la
   * risposta della action contiene l'albero aggiornato. Il refresh aggiuntivo
   * partiva DENTRO la stessa startTransition e ne impediva la chiusura:
   * `pending` restava true per sempre e i pulsanti del flusso di lavoro
   * (inclusi "Approva" e "Rifiuta") rimanevano disabilitati senza fine.
   */
  const afterAction = () => {
    setEditing(false);
    setShowSchedule(false);
  };

  /**
   * Esegue un'action del server gestendo gli esiti in modo visibile:
   * messaggio di errore specifico in caso di fallimento, nessun errore generico.
   */
  const runAction = async (
    fn: () => Promise<{ ok: boolean; message?: string } | undefined | null>,
    options?: { refreshOnError?: boolean }
  ) => {
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fn();
      if (res && res.ok === false) {
        setActionError(res.message ?? "Operazione non riuscita.");
        if (options?.refreshOnError) afterAction();
        return false;
      }
      afterAction();
      return true;
    } catch (e) {
      setActionError(
        e instanceof Error && e.message
          ? e.message
          : "Si è verificato un errore. Riprova."
      );
      return false;
    }
  };

  const save = () =>
    startTransition(async () => {
      const payload: {
        id: string;
        title: string | null;
        caption: string | null;
        hashtags: string | null;
        type: string;
        platforms: string[];
        scheduledDate: string | null;
      } = {
        id: content.id,
        title: title.trim() || null,
        caption: caption.trim() || null,
        hashtags: hashtags.trim() || null,
        type,
        platforms: [...platforms],
        scheduledDate: scheduledDate
          ? new Date(scheduledDate).toISOString()
          : null,
      };
      await runAction(() => updateContentAction(payload));
    });

  const doSetDraft = () =>
    startTransition(async () => {
      await runAction(() => setStatusAction(content.id, "DRAFT"));
    });

  const doSchedule = () =>
    startTransition(async () => {
      const d = new Date(scheduledDate);
      if (!scheduledDate || Number.isNaN(d.getTime())) {
        setActionError("Seleziona una data e ora valide per la programmazione.");
        return;
      }
      await runAction(() => scheduleAction(content.id, d.toISOString()));
    });

  const doUnschedule = () =>
    startTransition(async () => {
      await runAction(() => unscheduleAction(content.id));
    });

  const doPublish = (platform?: string) =>
    startTransition(async () => {
      await runAction(() => publishAction(content.id, platform), {
        refreshOnError: true,
      });
    });

  const doDuplicate = () =>
    startTransition(async () => {
      const res = await duplicateContentAction(content.id);
      if (res && res.ok === false) {
        setActionError(res.message ?? "Duplicazione non riuscita.");
        return;
      }
      if (res?.ok && res.id) router.push(`/contents/${res.id}`);
    });

  const doDelete = () =>
    startTransition(async () => {
      if (!window.confirm("Eliminare definitivamente questo contenuto?")) return;
      const res = await deleteContentAction(content.id);
      if (res && res.ok === false) {
        setActionError(res.message ?? "Eliminazione non riuscita.");
        return;
      }
      router.push("/contents");
    });

  const previewBody = (hashtags ? `${caption}\n\n${hashtags}` : caption).trim();

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/contents"
            className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Tutti i contenuti
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
            <TypeBadge type={content.type} />
            {title || "Senza titolo"}
            <StatusBadge status={content.status} />
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {content.status === "PUBLISHED" ? null : (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={pending}>
              <Save className="h-4 w-4" /> Modifica
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {actionMessage}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Dettagli del contenuto"
              description="Titolo, testo, hashtag, tipo e piattaforme"
            />
            <div className="space-y-4 px-5 py-5">
              <Field label="Titolo">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  readOnly={!editing}
                  placeholder="Titolo breve del post…"
                />
              </Field>

              <Field label="Tipo di contenuto">
                <Select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  disabled={!editing}
                >
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Caption"
                hint={`${caption.length} caratteri`}
              >
                <Textarea
                  rows={6}
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  readOnly={!editing}
                  placeholder="Testo da pubblicare sulla piattaforma…"
                />
              </Field>

              <Field label="Hashtag" hint="Separati da spazio (es. #grecia #mare)">
                <Textarea
                  rows={2}
                  value={hashtags}
                  onChange={(e) => setHashtags(e.target.value)}
                  readOnly={!editing}
                  placeholder="#viaggi #estate…"
                />
              </Field>

              <Field label="Piattaforme">
                <div className="flex flex-wrap gap-2">
                  {PLATFORM_VALUES.map((p) => {
                    const selected = platforms.has(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        disabled={!editing}
                        onClick={() => togglePlatform(p)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                          selected
                            ? "border-sky-300 bg-sky-50 text-sky-700"
                            : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        {selected ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <X className="h-3.5 w-3.5 opacity-40" />
                        )}
                        {PLATFORM_LABELS[p as keyof typeof PLATFORM_LABELS]}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {/* Azioni visibili solo in modifica: fuori dalla modifica
                  "Annulla" non avrebbe nulla da annullare e "Salva" sarebbe
                  un pulsante permanentemente disabilitato senza spiegazione. */}
              {editing ? (
                <div className="flex items-center gap-2 border-t border-slate-100 pt-4">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      resetForm();
                      setEditing(false);
                    }}
                    disabled={pending}
                  >
                    Annulla
                  </Button>
                  <Button onClick={save} disabled={pending}>
                    {pending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Salva modifiche
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>

          <ContentMediaSection
            contentId={content.id}
            assets={content.assets}
            library={library}
            targetsInstagram={platforms.has("INSTAGRAM")}
          />

          {content.slides.length > 0 ? (
            <Card>
              <CardHeader
                title="Slide del carousel"
                description={`${content.slides.length} slide in ordine`}
              />
              <div className="divide-y divide-slate-100">
                {content.slides.map((s, i) => (
                  <div
                    key={s.id}
                    className="flex items-start gap-3 px-5 py-3"
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-xs font-bold text-sky-700">
                      {i + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      {s.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.imageUrl}
                          alt=""
                          className="mb-2 h-20 w-20 rounded-md object-cover"
                        />
                      ) : null}
                      {s.title ? (
                        <div className="text-sm font-medium text-slate-800">
                          {s.title}
                        </div>
                      ) : null}
                      {s.text ? (
                        <div className="text-xs text-slate-500">{s.text}</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Approvazioni"
              description="Storico delle decisioni su questo contenuto"
            />
            {approvals.length === 0 ? (
              <div className="px-5 py-5 text-sm text-slate-500">
                Nessuna approvazione registrata.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {approvals.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-start justify-between gap-3 px-5 py-3"
                  >
                    <div>
                      <Badge
                        className={
                          a.decision === "APPROVED"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-red-50 text-red-700 border-red-200"
                        }
                      >
                        {a.decision === "APPROVED" ? "Approvato" : "Rifiutato"}
                      </Badge>
                      {a.note ? (
                        <p className="mt-1 text-sm text-slate-600">{a.note}</p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-xs text-slate-400">
                      {formatDate(a.createdAt, "dd/MM/yyyy HH:mm")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Flusso di lavoro" />
            <div className="space-y-2.5 px-5 py-4">
              {canApprove || canReject ? (
                <ApprovalActions
                  contentId={content.id}
                  layout="stack"
                  size="md"
                  disabled={!hasCaption}
                  disabledReason="La caption è obbligatoria per approvare"
                />
              ) : null}

              {canRestoreDraft ? (
                <Button
                  className="w-full"
                  variant="secondary"
                  onClick={doSetDraft}
                  disabled={pending}
                >
                  <RotateCcw className="h-4 w-4" />
                  Ripristina bozza
                </Button>
              ) : null}

              {canSchedule ? (
                showSchedule ? (
                  <div className="space-y-2">
                    <Input
                      type="datetime-local"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={doSchedule} disabled={pending || !scheduledDate}>
                        Programma
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setShowSchedule(false)}>
                        Annulla
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    className="w-full"
                    variant="warning"
                    onClick={() => setShowSchedule(true)}
                    disabled={pending}
                  >
                    <CalendarClock className="h-4 w-4" />
                    Programma
                  </Button>
                )
              ) : null}

              {canUnschedule ? (
                <Button
                  className="w-full"
                  variant="warning"
                  onClick={doUnschedule}
                  disabled={pending}
                >
                  <CalendarClock className="h-4 w-4" />
                  Annulla programmazione
                </Button>
              ) : null}

              {canPublish ? (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <p className="text-xs font-medium text-slate-500">
                    Pubblicazione
                  </p>

                  {content.platforms.length === 0 ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Nessuna piattaforma selezionata. Scegline almeno una nei
                      dettagli del contenuto per poter pubblicare.
                    </p>
                  ) : (
                    <>
                      <Button
                        className="w-full"
                        variant="success"
                        onClick={() => doPublish("ALL")}
                        disabled={pending || !hasCaption || !publishable}
                        title={
                          !publishable
                            ? "Instagram richiede almeno un media associato"
                            : undefined
                        }
                      >
                        <Rocket className="h-4 w-4" />
                        Pubblica su tutte le piattaforme
                      </Button>

                      <p className="pt-1 text-[11px] text-slate-400">
                        Oppure pubblica su una singola piattaforma:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {content.platforms.map((p) => (
                          <Button
                            key={p.id}
                            size="sm"
                            variant="secondary"
                            onClick={() => doPublish(p.platform)}
                            disabled={pending || !publishable}
                          >
                            <Rocket className="h-3.5 w-3.5" />
                            {PLATFORM_LABELS[
                              p.platform as keyof typeof PLATFORM_LABELS
                            ]}
                          </Button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {!canPublish && ["APPROVED", "SCHEDULED"].includes(content.status) ? (
                <p className="text-xs text-slate-400">
                  Per pubblicare è necessaria un&apos;approvazione esplicita
                  registrata in precedenza.
                </p>
              ) : null}

              {!hasCaption ? (
                <p className="text-xs text-amber-600">
                  Scrivi una caption per procedere con approvazione,
                  programmazione o pubblicazione.
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Programmazione" description="Data e ora pianificate" />
            <div className="space-y-3 px-5 py-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Status</span>
                <StatusBadge status={content.status} />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Data pianificata</span>
                <span className="font-medium text-slate-800">
                  {content.scheduledDate
                    ? formatDate(content.scheduledDate, "dd/MM/yyyy HH:mm")
                    : "Non programmato"}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Anteprima</span>
                <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs text-slate-500">
                  {previewBody.length} caratteri
                </span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Azioni" />
            <div className="space-y-2 px-5 py-4">
              <Button
                className="w-full"
                variant="secondary"
                onClick={doDuplicate}
                disabled={pending}
              >
                <Copy className="h-4 w-4" />
                Duplica contenuto
              </Button>
              <Button
                className="w-full"
                variant="danger"
                onClick={doDelete}
                disabled={pending}
              >
                <Trash2 className="h-4 w-4" />
                Elimina contenuto
              </Button>
            </div>
          </Card>

          <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-gradient-to-br from-sky-50 to-white p-4">
            <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
            <p className="text-xs text-slate-600">
              <span className="font-semibold text-slate-800">
                Suggerimento:
              </span>{" "}
              usa l&apos;Assistente AI per generare caption, hashtag, immagini e
              carousel direttamente dalla chat.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}