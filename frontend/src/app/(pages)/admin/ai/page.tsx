"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    MODELS,
    SETTINGS_MODELS,
} from "@/app/components/assistant/ModelToggle";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";
import {
    getFirm,
    getFirmApiKeys,
    removeFirmApiKey,
    saveFirmApiKey,
    updateFirm,
    type Firm,
    type FirmApiKeyStatus,
} from "@/app/lib/mikeApi";
import { SettingsSection } from "../../settings/SettingsSection";
import { AdminErrorBanner } from "../AdminErrorBanner";
import { errorMessage } from "../adminHelpers";

const PROVIDER_LABELS: Record<string, string> = {
    claude: "Anthropic (Claude)",
    gemini: "Google (Gemini)",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    courtlistener: "CourtListener (case law)",
};

function providerLabel(provider: string) {
    return PROVIDER_LABELS[provider] ?? provider;
}

export default function AdminAiPage() {
    const [keys, setKeys] = useState<FirmApiKeyStatus[]>([]);
    const [keysLoading, setKeysLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [savingProvider, setSavingProvider] = useState<string | null>(null);
    const [savedProvider, setSavedProvider] = useState<string | null>(null);
    const [pendingRemoval, setPendingRemoval] =
        useState<FirmApiKeyStatus | null>(null);
    const [removeStatus, setRemoveStatus] = useState<
        "idle" | "loading" | "complete"
    >("idle");

    const [firm, setFirm] = useState<Firm | null>(null);
    const [allowed, setAllowed] = useState<string[] | null>(null);
    const [savingModels, setSavingModels] = useState(false);
    const [savedModels, setSavedModels] = useState(false);

    const ollamaModels = useOllamaModels();
    const everyModel = useMemo(() => {
        const seen = new Map<string, { id: string; label: string }>();
        for (const model of [...SETTINGS_MODELS, ...MODELS, ...ollamaModels]) {
            if (!seen.has(model.id)) seen.set(model.id, model);
        }
        // A model the firm has already picked stays listed even if it is not
        // currently on offer, so choosing it once cannot make it invisible.
        for (const id of allowed ?? []) {
            if (!seen.has(id)) seen.set(id, { id, label: id });
        }
        return [...seen.values()];
    }, [ollamaModels, allowed]);

    const loadKeys = useCallback(async () => {
        setKeysLoading(true);
        try {
            setKeys(await getFirmApiKeys());
        } catch (loadError) {
            setError(
                errorMessage(loadError, "Could not load the firm's accounts."),
            );
        } finally {
            setKeysLoading(false);
        }
    }, []);

    const loadFirm = useCallback(async () => {
        try {
            const loaded = await getFirm();
            setFirm(loaded);
            setAllowed(
                Array.isArray(loaded.allowed_models)
                    ? loaded.allowed_models
                    : null,
            );
        } catch (loadError) {
            setError(
                errorMessage(loadError, "Could not load the firm's settings."),
            );
        }
    }, []);

    useEffect(() => {
        void loadKeys();
        void loadFirm();
    }, [loadKeys, loadFirm]);

    async function handleSaveKey(provider: string) {
        const value = (drafts[provider] ?? "").trim();
        if (!value) return;
        setSavingProvider(provider);
        setError(null);
        try {
            await saveFirmApiKey(provider, value);
            setDrafts((current) => ({ ...current, [provider]: "" }));
            await loadKeys();
            setSavedProvider(provider);
            setTimeout(() => setSavedProvider(null), 2000);
        } catch (saveError) {
            setError(errorMessage(saveError, "That key did not save."));
        } finally {
            setSavingProvider(null);
        }
    }

    async function confirmRemoveKey() {
        const pending = pendingRemoval;
        if (!pending || removeStatus === "loading") return;
        setRemoveStatus("loading");
        try {
            await removeFirmApiKey(pending.provider);
            await loadKeys();
            setRemoveStatus("complete");
            setTimeout(() => {
                setPendingRemoval(null);
                setRemoveStatus("idle");
            }, 650);
        } catch (removeError) {
            setRemoveStatus("idle");
            setError(
                errorMessage(removeError, "That key could not be removed."),
            );
        }
    }

    function toggleModel(id: string) {
        setAllowed((current) => {
            if (current === null) {
                // Narrowing for the first time starts from just this one.
                return [id];
            }
            const next = current.includes(id)
                ? current.filter((entry) => entry !== id)
                : [...current, id];
            return next.length ? next : null;
        });
    }

    async function handleSaveModels() {
        setSavingModels(true);
        setError(null);
        try {
            const updated = await updateFirm({ allowed_models: allowed });
            setFirm(updated);
            setAllowed(
                Array.isArray(updated.allowed_models)
                    ? updated.allowed_models
                    : null,
            );
            setSavedModels(true);
            setTimeout(() => setSavedModels(false), 2000);
        } catch (saveError) {
            setError(
                errorMessage(saveError, "That list of models did not save."),
            );
        } finally {
            setSavingModels(false);
        }
    }

    return (
        <div className="space-y-8">
            <AdminErrorBanner
                message={error}
                onDismiss={() => setError(null)}
            />

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    The firm&apos;s accounts with the AI providers
                </h2>
                <p className="text-sm text-gray-500">
                    Put the firm&apos;s key in once and nobody has to find their
                    own. A key somebody has set for themselves in their own
                    settings is used first; the firm&apos;s comes next; and
                    whatever this server was set up with is the last resort. A
                    key is never shown again once it is saved.
                </p>
                <SettingsSection>
                    {keysLoading ? (
                        <div className="space-y-2 p-4">
                            {[0, 1, 2].map((row) => (
                                <div
                                    key={row}
                                    className="h-10 w-full animate-pulse rounded-lg bg-gray-100"
                                />
                            ))}
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {keys.map((entry) => (
                                <li key={entry.provider} className="p-4">
                                    <div className="flex flex-wrap items-end gap-3">
                                        <div className="min-w-0 flex-1">
                                            <FieldLabel
                                                htmlFor={`key-${entry.provider}`}
                                                className="text-sm text-gray-600"
                                            >
                                                {providerLabel(entry.provider)}
                                            </FieldLabel>
                                            <SettingsTextInput
                                                id={`key-${entry.provider}`}
                                                type="password"
                                                autoComplete="off"
                                                value={
                                                    drafts[entry.provider] ?? ""
                                                }
                                                onChange={(event) =>
                                                    setDrafts((current) => ({
                                                        ...current,
                                                        [entry.provider]:
                                                            event.target.value,
                                                    }))
                                                }
                                                placeholder={
                                                    entry.firm_key_set
                                                        ? "A key is saved — paste a new one to replace it"
                                                        : "Paste the firm's key"
                                                }
                                            />
                                        </div>
                                        <div className="flex items-center gap-2 pb-1">
                                            {savedProvider ===
                                                entry.provider && (
                                                <span className="flex items-center gap-1 text-xs font-medium text-green-700">
                                                    <Check className="h-3.5 w-3.5" />
                                                    Saved
                                                </span>
                                            )}
                                            <PillButton
                                                tone="black"
                                                size="sm"
                                                onClick={() =>
                                                    void handleSaveKey(
                                                        entry.provider,
                                                    )
                                                }
                                                disabled={
                                                    savingProvider ===
                                                        entry.provider ||
                                                    !(
                                                        drafts[entry.provider] ??
                                                        ""
                                                    ).trim()
                                                }
                                            >
                                                {savingProvider ===
                                                entry.provider ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : entry.firm_key_set ? (
                                                    "Replace"
                                                ) : (
                                                    "Save"
                                                )}
                                            </PillButton>
                                            {entry.firm_key_set && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setPendingRemoval(entry)
                                                    }
                                                    className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <p className="mt-1.5 text-xs text-gray-500">
                                        {entry.firm_key_set
                                            ? "The firm has an account here."
                                            : entry.server_key_set
                                              ? "No firm key. This server has its own, so this provider still works."
                                              : "Nothing set. This provider will not work unless somebody adds their own key."}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Which models people may use
                </h2>
                <p className="text-sm text-gray-500">
                    Leave everything unpicked and the whole list stays
                    available. Pick some and only those are offered — to
                    everyone, administrators included. Somebody who had already
                    chosen a model that is no longer allowed will be moved on to
                    one that is.
                </p>
                <SettingsSection>
                    <div className="space-y-4 p-4">
                        {allowed === null && (
                            <p className="text-xs text-gray-500">
                                Every model is currently allowed.
                            </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                            {everyModel.map((model) => {
                                const picked = allowed?.includes(model.id) ?? false;
                                return (
                                    <button
                                        key={model.id}
                                        type="button"
                                        aria-pressed={picked}
                                        onClick={() => toggleModel(model.id)}
                                        className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                                            picked
                                                ? "border-gray-900 bg-gray-900 text-white"
                                                : "border-gray-200 text-gray-600 hover:border-gray-400"
                                        }`}
                                    >
                                        {model.label}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <button
                                type="button"
                                onClick={() => setAllowed(null)}
                                disabled={allowed === null}
                                className="text-xs text-gray-500 underline-offset-2 hover:underline disabled:opacity-40 disabled:hover:no-underline"
                            >
                                Allow every model again
                            </button>
                            <div className="flex items-center gap-3">
                                {savedModels && (
                                    <span className="text-xs font-medium text-green-700">
                                        Saved
                                    </span>
                                )}
                                <PillButton
                                    tone="black"
                                    size="normal"
                                    onClick={() => void handleSaveModels()}
                                    disabled={savingModels || !firm}
                                >
                                    {savingModels ? (
                                        <>
                                            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                                            Saving...
                                        </>
                                    ) : (
                                        "Save"
                                    )}
                                </PillButton>
                            </div>
                        </div>
                    </div>
                </SettingsSection>
            </section>

            <ConfirmPopup
                open={!!pendingRemoval}
                title="Remove the firm's key?"
                message={
                    <p>
                        The firm&apos;s{" "}
                        <span className="font-medium text-gray-950">
                            {pendingRemoval
                                ? providerLabel(pendingRemoval.provider)
                                : ""}
                        </span>{" "}
                        key is deleted.{" "}
                        {pendingRemoval?.server_key_set
                            ? "This server has its own key, so the provider keeps working."
                            : "Nobody will be able to use this provider unless they have their own key."}
                    </p>
                }
                confirmLabel="Remove it"
                confirmStatus={removeStatus}
                onConfirm={() => void confirmRemoveKey()}
                onCancel={() => {
                    if (removeStatus === "loading") return;
                    setPendingRemoval(null);
                    setRemoveStatus("idle");
                }}
            />
        </div>
    );
}
