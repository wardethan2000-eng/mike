"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import {
    getFirmAudit,
    getFirmAuditActions,
    getFirmMembers,
    type AuditEvent,
    type FirmMember,
} from "@/app/lib/mikeApi";
import { SettingsSection } from "../../settings/SettingsSection";
import { AdminErrorBanner } from "../AdminErrorBanner";
import { errorMessage, personLabel } from "../adminHelpers";

const ANYONE = "__anyone__";
const ANYTHING = "__anything__";
const PAGE_SIZE = 50;

/** "document.uploaded" reads better as "Document uploaded". */
function actionLabel(action: string) {
    const words = action.replace(/[._]/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function when(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export default function AdminAuditPage() {
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [members, setMembers] = useState<FirmMember[]>([]);
    const [actions, setActions] = useState<string[]>([]);
    const [person, setPerson] = useState(ANYONE);
    const [action, setAction] = useState(ANYTHING);
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");

    useEffect(() => {
        void getFirmMembers()
            .then(setMembers)
            .catch(() => setMembers([]));
        void getFirmAuditActions()
            .then(({ actions: list }) => setActions(list))
            .catch(() => setActions([]));
    }, []);

    const load = useCallback(
        async (offset: number) => {
            const filters = {
                userId: person === ANYONE ? null : person,
                action: action === ANYTHING ? null : action,
                // A plain date means the whole of that day.
                from: from ? `${from}T00:00:00.000Z` : null,
                to: to ? `${to}T23:59:59.999Z` : null,
                limit: PAGE_SIZE,
                offset,
            };
            return getFirmAudit(filters);
        },
        [action, from, person, to],
    );

    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await load(0);
            setEvents(result.events);
            setHasMore(result.hasMore);
        } catch (loadError) {
            setError(errorMessage(loadError, "Could not load the history."));
        } finally {
            setLoading(false);
        }
    }, [load]);

    useEffect(() => {
        void reload();
    }, [reload]);

    async function loadMore() {
        if (loadingMore || !hasMore) return;
        setLoadingMore(true);
        try {
            const result = await load(events.length);
            setEvents((current) => [...current, ...result.events]);
            setHasMore(result.hasMore);
        } catch (loadError) {
            setError(errorMessage(loadError, "Could not load any more."));
        } finally {
            setLoadingMore(false);
        }
    }

    return (
        <div className="space-y-6">
            <AdminErrorBanner
                message={error}
                onDismiss={() => setError(null)}
            />

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    What people have been doing
                </h2>
                <p className="text-sm text-gray-500">
                    Newest first. This is a record only — nothing here can be
                    changed or removed.
                </p>

                <SettingsSection>
                    <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-4">
                        <div>
                            <FieldLabel as="span" className="text-sm text-gray-600">
                                Person
                            </FieldLabel>
                            <ModalSelect
                                id="audit-person"
                                value={person}
                                options={[
                                    { value: ANYONE, label: "Anyone" },
                                    ...members.map((member) => ({
                                        value: member.user_id,
                                        label: personLabel(member),
                                    })),
                                ]}
                                onChange={setPerson}
                            />
                        </div>
                        <div>
                            <FieldLabel as="span" className="text-sm text-gray-600">
                                What happened
                            </FieldLabel>
                            <ModalSelect
                                id="audit-action"
                                value={action}
                                options={[
                                    { value: ANYTHING, label: "Anything" },
                                    ...actions.map((entry) => ({
                                        value: entry,
                                        label: actionLabel(entry),
                                    })),
                                ]}
                                onChange={setAction}
                            />
                        </div>
                        <div>
                            <FieldLabel
                                htmlFor="audit-from"
                                className="text-sm text-gray-600"
                            >
                                From
                            </FieldLabel>
                            <SettingsTextInput
                                id="audit-from"
                                type="date"
                                value={from}
                                onChange={(event) => setFrom(event.target.value)}
                            />
                        </div>
                        <div>
                            <FieldLabel
                                htmlFor="audit-to"
                                className="text-sm text-gray-600"
                            >
                                To
                            </FieldLabel>
                            <SettingsTextInput
                                id="audit-to"
                                type="date"
                                value={to}
                                onChange={(event) => setTo(event.target.value)}
                            />
                        </div>
                    </div>
                </SettingsSection>

                <SettingsSection>
                    {loading ? (
                        <div className="space-y-2 p-4">
                            {[0, 1, 2, 3, 4].map((row) => (
                                <div
                                    key={row}
                                    className="h-9 w-full animate-pulse rounded-lg bg-gray-100"
                                />
                            ))}
                        </div>
                    ) : events.length === 0 ? (
                        <p className="p-4 text-sm text-gray-500">
                            Nothing matches those filters.
                        </p>
                    ) : (
                        <>
                            <ul className="divide-y divide-gray-100">
                                {events.map((event) => (
                                    <li
                                        key={event.id}
                                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                                    >
                                        <span className="w-40 shrink-0 text-xs text-gray-500">
                                            {when(event.created_at)}
                                        </span>
                                        <span className="w-48 shrink-0 truncate text-xs text-gray-700">
                                            {event.user_email || "Somebody"}
                                        </span>
                                        <span className="min-w-0 flex-1 text-sm text-gray-900">
                                            {event.title ||
                                                actionLabel(event.action)}
                                        </span>
                                        {event.model && (
                                            <span className="shrink-0 rounded-full border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500">
                                                {event.model}
                                            </span>
                                        )}
                                        {event.status !== "completed" && (
                                            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                                                {event.status}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {hasMore && (
                                <div className="flex justify-center border-t border-gray-100 p-3">
                                    <PillButton
                                        tone="white"
                                        size="sm"
                                        onClick={() => void loadMore()}
                                        disabled={loadingMore}
                                    >
                                        {loadingMore ? (
                                            <>
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                Loading...
                                            </>
                                        ) : (
                                            "Show more"
                                        )}
                                    </PillButton>
                                </div>
                            )}
                        </>
                    )}
                </SettingsSection>
            </section>
        </div>
    );
}
