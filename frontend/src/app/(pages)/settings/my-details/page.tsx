"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    SettingsTextInput,
    SETTINGS_CONTROL_CLASS,
} from "@/app/components/settings/SettingsTextInput";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { BarAdmission } from "@/app/lib/mikeApi";
import { SettingsSection } from "../SettingsSection";

type SaveState = "idle" | "saving" | "saved";

function errorText(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : "Couldn't save that. Try again.";
}

export default function MyDetailsPage() {
    const { profile, loading, updateProfessionalDetails } = useUserProfile();

    const [title, setTitle] = useState("");
    const [phone, setPhone] = useState("");
    const [practiceAreas, setPracticeAreas] = useState("");
    const [admissions, setAdmissions] = useState<BarAdmission[]>([]);
    const [signatureBlock, setSignatureBlock] = useState("");
    const [saveState, setSaveState] = useState<SaveState>("idle");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!profile) return;
        setTitle(profile.profTitle ?? "");
        setPhone(profile.profPhone ?? "");
        setPracticeAreas((profile.practiceAreas ?? []).join(", "));
        setAdmissions(profile.barAdmissions ?? []);
        setSignatureBlock(profile.signatureBlock ?? "");
    }, [profile]);

    function updateAdmission(
        index: number,
        field: "state" | "bar_number",
        value: string,
    ) {
        setAdmissions((prev) =>
            prev.map((row, i) =>
                i === index ? { ...row, [field]: value } : row,
            ),
        );
    }

    async function handleSave() {
        setSaveState("saving");
        setError(null);
        try {
            await updateProfessionalDetails({
                profTitle: title.trim() || null,
                profPhone: phone.trim() || null,
                practiceAreas: practiceAreas
                    .split(",")
                    .map((area) => area.trim())
                    .filter((area) => area !== ""),
                barAdmissions: admissions
                    .map((row) => ({
                        state: row.state.trim(),
                        bar_number: row.bar_number.trim(),
                        ...(row.status ? { status: row.status } : {}),
                    }))
                    .filter((row) => row.state || row.bar_number),
                signatureBlock: signatureBlock.trim() || null,
            });
            setSaveState("saved");
            setTimeout(() => setSaveState("idle"), 2000);
        } catch (err) {
            setError(errorText(err));
            setSaveState("idle");
        }
    }

    if (loading && !profile) {
        return <p className="text-sm text-gray-500">Loading your details...</p>;
    }

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    My details
                </h2>
                <p className="text-sm text-gray-600">
                    Mike uses these when it drafts something for you, so a
                    letter comes back signed the way you sign it, with the right
                    bar number. If you leave a bar number out, Mike leaves a
                    blank rather than making one up.
                </p>

                <SettingsSection>
                    <div className="space-y-8 p-4">
                        <div>
                            <FieldLabel className="text-sm text-gray-600">
                                Your title
                            </FieldLabel>
                            <SettingsTextInput
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Partner, Associate, Paralegal..."
                            />
                        </div>

                        <div>
                            <FieldLabel className="text-sm text-gray-600">
                                Direct phone
                            </FieldLabel>
                            <SettingsTextInput
                                type="text"
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                placeholder="555-0100"
                            />
                        </div>

                        <div>
                            <FieldLabel className="text-sm text-gray-600">
                                Practice areas
                            </FieldLabel>
                            <SettingsTextInput
                                type="text"
                                value={practiceAreas}
                                onChange={(e) =>
                                    setPracticeAreas(e.target.value)
                                }
                                placeholder="Real estate, Probate, Employment"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                                Separate them with commas.
                            </p>
                        </div>
                    </div>
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Where you are admitted
                </h2>
                <p className="text-sm text-gray-600">
                    Every state you are licensed in, with the bar number for
                    each. Mike will only ever use a number listed here.
                </p>
                <SettingsSection>
                    <div className="space-y-3 p-4">
                        {admissions.length === 0 && (
                            <p className="text-sm text-gray-500">
                                Nothing listed yet.
                            </p>
                        )}
                        {admissions.map((row, index) => (
                            <div
                                key={index}
                                className="flex items-center gap-2"
                            >
                                <SettingsTextInput
                                    type="text"
                                    value={row.state}
                                    onChange={(e) =>
                                        updateAdmission(
                                            index,
                                            "state",
                                            e.target.value,
                                        )
                                    }
                                    placeholder="State"
                                    className="flex-1"
                                />
                                <SettingsTextInput
                                    type="text"
                                    value={row.bar_number}
                                    onChange={(e) =>
                                        updateAdmission(
                                            index,
                                            "bar_number",
                                            e.target.value,
                                        )
                                    }
                                    placeholder="Bar number"
                                    className="flex-1"
                                />
                                <button
                                    type="button"
                                    aria-label="Remove this admission"
                                    onClick={() =>
                                        setAdmissions((prev) =>
                                            prev.filter((_, i) => i !== index),
                                        )
                                    }
                                    className="shrink-0 rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            onClick={() =>
                                setAdmissions((prev) => [
                                    ...prev,
                                    { state: "", bar_number: "" },
                                ])
                            }
                            className="flex items-center gap-1.5 text-xs font-medium text-gray-700 transition-colors hover:text-gray-950"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add a state
                        </button>
                    </div>
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Signature block
                </h2>
                <p className="text-sm text-gray-600">
                    Type it exactly as it should appear at the foot of a letter.
                    Mike copies it word for word and line for line.
                </p>
                <SettingsSection>
                    <div className="space-y-2 p-4">
                        <textarea
                            value={signatureBlock}
                            onChange={(e) => setSignatureBlock(e.target.value)}
                            rows={7}
                            spellCheck={false}
                            placeholder={
                                "Jane Roe\nPartner\nRoe & Company\n123 Main Street\nTopeka, Kansas 66601\n(785) 555-0100"
                            }
                            className={`${SETTINGS_CONTROL_CLASS} resize-y py-2 font-mono text-xs leading-5`}
                        />
                    </div>
                </SettingsSection>
            </section>

            {error && (
                <div className="flex items-start justify-between gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
                    <span>{error}</span>
                    <button
                        type="button"
                        onClick={() => setError(null)}
                        aria-label="Dismiss"
                        className="shrink-0 text-red-400 hover:text-red-600"
                    >
                        ×
                    </button>
                </div>
            )}

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={saveState !== "idle"}
                    className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                >
                    {saveState === "saving"
                        ? "Saving..."
                        : saveState === "saved"
                          ? "Saved"
                          : "Save my details"}
                </button>
            </div>
        </div>
    );
}
