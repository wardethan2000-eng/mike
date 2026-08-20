"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { getFirmUsage, type FirmUsagePerson } from "@/app/lib/mikeApi";
import { SettingsSection } from "../../settings/SettingsSection";
import { AdminErrorBanner } from "../AdminErrorBanner";
import { errorMessage } from "../adminHelpers";

function thisMonth() {
    return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, by: number) {
    const [year, monthNumber] = month.split("-").map(Number);
    const date = new Date(Date.UTC(year, monthNumber - 1 + by, 1));
    return date.toISOString().slice(0, 7);
}

function monthLabel(month: string) {
    const [year, monthNumber] = month.split("-").map(Number);
    const date = new Date(Date.UTC(year, monthNumber - 1, 1));
    return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
    });
}

export default function AdminUsagePage() {
    const [month, setMonth] = useState(thisMonth);
    const [people, setPeople] = useState<FirmUsagePerson[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (target: string) => {
        setLoading(true);
        setError(null);
        try {
            const result = await getFirmUsage(target);
            setPeople(result.people);
        } catch (loadError) {
            setError(errorMessage(loadError, "Could not load the figures."));
            setPeople([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(month);
    }, [load, month]);

    const total = useMemo(
        () => people.reduce((sum, person) => sum + person.messages, 0),
        [people],
    );
    const atThisMonth = month >= thisMonth();

    return (
        <div className="space-y-6">
            <AdminErrorBanner
                message={error}
                onDismiss={() => setError(null)}
            />

            <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        How much Mike is being used
                    </h2>
                    <div className="flex items-center gap-2">
                        <TabPillButton
                            onClick={() => setMonth(shiftMonth(month, -1))}
                            title="The month before"
                        >
                            <ChevronLeft className="h-3.5 w-3.5" />
                        </TabPillButton>
                        <span className="min-w-32 text-center text-sm text-gray-700">
                            {monthLabel(month)}
                        </span>
                        <TabPillButton
                            onClick={() => setMonth(shiftMonth(month, 1))}
                            disabled={atThisMonth}
                            title="The month after"
                        >
                            <ChevronRight className="h-3.5 w-3.5" />
                        </TabPillButton>
                    </div>
                </div>
                <p className="text-sm text-gray-500">
                    Counted as messages sent to Mike, taken from the same record
                    the history page shows. {total.toLocaleString()} this month
                    across the firm.
                </p>

                <SettingsSection>
                    {loading ? (
                        <div className="space-y-2 p-4">
                            {[0, 1, 2].map((row) => (
                                <div
                                    key={row}
                                    className="h-12 w-full animate-pulse rounded-lg bg-gray-100"
                                />
                            ))}
                        </div>
                    ) : people.length === 0 ? (
                        <p className="p-4 text-sm text-gray-500">
                            Nobody sent Mike anything that month.
                        </p>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {people.map((person) => (
                                <li key={person.user_id} className="px-4 py-3">
                                    <div className="flex items-baseline justify-between gap-4">
                                        <span className="min-w-0 truncate text-sm text-gray-900">
                                            {person.display_name?.trim() ||
                                                person.email ||
                                                "Somebody"}
                                        </span>
                                        <span className="shrink-0 text-sm text-gray-700">
                                            {person.messages.toLocaleString()}{" "}
                                            {person.messages === 1
                                                ? "message"
                                                : "messages"}
                                        </span>
                                    </div>
                                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                                        {person.by_model.map((entry) => (
                                            <span
                                                key={entry.model}
                                                className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500"
                                            >
                                                {entry.model} ·{" "}
                                                {entry.count.toLocaleString()}
                                            </span>
                                        ))}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </SettingsSection>
            </section>
        </div>
    );
}
