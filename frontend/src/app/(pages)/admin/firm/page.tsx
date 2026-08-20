"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    SETTINGS_CONTROL_CLASS,
    SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { cn } from "@/app/lib/utils";
import { getFirm, updateFirm, type Firm } from "@/app/lib/mikeApi";
import { SettingsSection } from "../../settings/SettingsSection";
import { AdminErrorBanner } from "../AdminErrorBanner";
import {
    CITATION_STYLE_OPTIONS,
    US_STATE_OPTIONS,
    errorMessage,
} from "../adminHelpers";

const NOT_SET = "__not_set__";

function FirmSkeleton() {
    return (
        <div className="space-y-6 p-4">
            {[0, 1, 2, 3].map((row) => (
                <div key={row} className="space-y-2">
                    <div className="h-3 w-24 animate-pulse rounded bg-gray-100" />
                    <div className="h-10 w-full animate-pulse rounded-lg bg-gray-100" />
                </div>
            ))}
        </div>
    );
}

export default function AdminFirmPage() {
    const [firm, setFirm] = useState<Firm | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const [name, setName] = useState("");
    const [address, setAddress] = useState("");
    const [phone, setPhone] = useState("");
    const [website, setWebsite] = useState("");
    const [jurisdiction, setJurisdiction] = useState(NOT_SET);
    const [citationStyle, setCitationStyle] = useState(NOT_SET);

    const applyFirm = useCallback((loaded: Firm) => {
        setFirm(loaded);
        setName(loaded.name ?? "");
        setAddress((loaded.address_lines ?? []).join("\n"));
        setPhone(loaded.phone ?? "");
        setWebsite(loaded.website ?? "");
        setJurisdiction(loaded.default_jurisdiction || NOT_SET);
        setCitationStyle(loaded.citation_style || NOT_SET);
    }, []);

    const loadFirm = useCallback(async () => {
        setLoading(true);
        try {
            applyFirm(await getFirm());
        } catch (loadError) {
            setError(
                errorMessage(loadError, "Could not load the firm's details."),
            );
        } finally {
            setLoading(false);
        }
    }, [applyFirm]);

    useEffect(() => {
        void loadFirm();
    }, [loadFirm]);

    async function handleSave() {
        if (!name.trim()) return;
        setSaving(true);
        setError(null);
        try {
            const updated = await updateFirm({
                name: name.trim(),
                address_lines: address
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                phone: phone.trim() || null,
                website: website.trim() || null,
                default_jurisdiction:
                    jurisdiction === NOT_SET ? null : jurisdiction,
                citation_style:
                    citationStyle === NOT_SET ? null : citationStyle,
            });
            applyFirm(updated);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (saveError) {
            setError(errorMessage(saveError, "Those details did not save."));
        } finally {
            setSaving(false);
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
                    Firm details
                </h2>
                <SettingsSection>
                    {loading ? (
                        <FirmSkeleton />
                    ) : !firm ? (
                        <div className="flex flex-col items-start gap-3 p-4">
                            <p className="text-sm text-gray-500">
                                The firm&apos;s details could not be loaded.
                            </p>
                            <PillButton
                                tone="white"
                                size="sm"
                                onClick={() => void loadFirm()}
                            >
                                Try again
                            </PillButton>
                        </div>
                    ) : (
                        <div className="space-y-6 p-4">
                            <div>
                                <FieldLabel
                                    htmlFor="firm-name"
                                    className="text-sm text-gray-600"
                                >
                                    Firm name
                                </FieldLabel>
                                <SettingsTextInput
                                    id="firm-name"
                                    type="text"
                                    value={name}
                                    onChange={(event) =>
                                        setName(event.target.value)
                                    }
                                    placeholder="Enter the firm's name"
                                />
                            </div>

                            <div>
                                <FieldLabel
                                    htmlFor="firm-address"
                                    className="text-sm text-gray-600"
                                >
                                    Address
                                </FieldLabel>
                                <textarea
                                    id="firm-address"
                                    value={address}
                                    onChange={(event) =>
                                        setAddress(event.target.value)
                                    }
                                    rows={4}
                                    placeholder={
                                        "123 Main Street\nSuite 200\nOverland Park, KS 66210"
                                    }
                                    className={cn(
                                        "min-h-24 resize-none py-2.5 leading-relaxed",
                                        SETTINGS_CONTROL_CLASS,
                                    )}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    One line each, the way it should appear on
                                    letterhead.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                <div>
                                    <FieldLabel
                                        htmlFor="firm-phone"
                                        className="text-sm text-gray-600"
                                    >
                                        Phone
                                    </FieldLabel>
                                    <SettingsTextInput
                                        id="firm-phone"
                                        type="tel"
                                        value={phone}
                                        onChange={(event) =>
                                            setPhone(event.target.value)
                                        }
                                        placeholder="(913) 555-0134"
                                    />
                                </div>
                                <div>
                                    <FieldLabel
                                        htmlFor="firm-website"
                                        className="text-sm text-gray-600"
                                    >
                                        Website
                                    </FieldLabel>
                                    <SettingsTextInput
                                        id="firm-website"
                                        type="text"
                                        value={website}
                                        onChange={(event) =>
                                            setWebsite(event.target.value)
                                        }
                                        placeholder="www.yourfirm.com"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                <div>
                                    <FieldLabel
                                        as="span"
                                        className="text-sm text-gray-600"
                                    >
                                        State you mainly practise in
                                    </FieldLabel>
                                    <ModalSelect
                                        id="firm-jurisdiction"
                                        value={jurisdiction}
                                        options={[
                                            { value: NOT_SET, label: "Not set" },
                                            ...US_STATE_OPTIONS.map((state) => ({
                                                value: state,
                                                label: state,
                                            })),
                                        ]}
                                        onChange={setJurisdiction}
                                    />
                                </div>
                                <div>
                                    <FieldLabel
                                        as="span"
                                        className="text-sm text-gray-600"
                                    >
                                        Citation style
                                    </FieldLabel>
                                    <ModalSelect
                                        id="firm-citation-style"
                                        value={citationStyle}
                                        options={[
                                            { value: NOT_SET, label: "Not set" },
                                            ...CITATION_STYLE_OPTIONS.map(
                                                (style) => ({
                                                    value: style,
                                                    label: style,
                                                }),
                                            ),
                                        ]}
                                        onChange={setCitationStyle}
                                    />
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-3">
                                {saved && (
                                    <span className="text-xs font-medium text-green-700">
                                        Saved
                                    </span>
                                )}
                                <PillButton
                                    tone="black"
                                    size="normal"
                                    onClick={() => void handleSave()}
                                    disabled={saving || !name.trim()}
                                >
                                    {saving ? (
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
                    )}
                </SettingsSection>
            </section>
        </div>
    );
}
