"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, UserPlus } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    cancelFirmInvite,
    createFirmInvite,
    getFirmInvites,
    getFirmMatters,
    getFirmMembers,
    reassignFirmMatter,
    updateFirmMember,
    type FirmInvite,
    type FirmMatterSummary,
    type FirmMember,
    type FirmRole,
} from "@/app/lib/mikeApi";
import { SettingsSection } from "../settings/SettingsSection";
import { AdminErrorBanner } from "./AdminErrorBanner";
import {
    ROLE_OPTIONS,
    errorMessage,
    formatDate,
    personLabel,
    roleLabel,
} from "./adminHelpers";

const controlLabelClassName =
    "mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400";

function PeopleSkeleton() {
    return (
        <div className="space-y-3 p-4">
            {[0, 1, 2].map((row) => (
                <div key={row} className="space-y-2">
                    <div className="h-4 w-40 animate-pulse rounded bg-gray-100" />
                    <div className="h-3 w-56 animate-pulse rounded bg-gray-100" />
                </div>
            ))}
        </div>
    );
}

export default function AdminPeoplePage() {
    const { reloadProfile } = useUserProfile();

    const [members, setMembers] = useState<FirmMember[]>([]);
    const [invites, setInvites] = useState<FirmInvite[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busyUserId, setBusyUserId] = useState<string | null>(null);

    // Invite someone
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteRole, setInviteRole] = useState<FirmRole>("attorney");
    const [inviteBusy, setInviteBusy] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [createdInvite, setCreatedInvite] = useState<FirmInvite | null>(null);
    const [linkCopied, setLinkCopied] = useState(false);
    const [pendingCancelInvite, setPendingCancelInvite] =
        useState<FirmInvite | null>(null);
    const [cancellingInvite, setCancellingInvite] = useState(false);

    // Turning someone off
    const [pendingDeactivate, setPendingDeactivate] =
        useState<FirmMember | null>(null);

    // Handing matters over
    const [handoverMember, setHandoverMember] = useState<FirmMember | null>(
        null,
    );
    const [matters, setMatters] = useState<FirmMatterSummary[]>([]);
    const [mattersLoading, setMattersLoading] = useState(false);
    const [matterTargets, setMatterTargets] = useState<Record<string, string>>(
        {},
    );
    const [busyMatterId, setBusyMatterId] = useState<string | null>(null);
    const [handoverError, setHandoverError] = useState<string | null>(null);

    const loadPeople = useCallback(async () => {
        setLoading(true);
        try {
            const [memberList, inviteList] = await Promise.all([
                getFirmMembers(),
                getFirmInvites(),
            ]);
            setMembers(memberList);
            setInvites(inviteList);
        } catch (loadError) {
            setError(
                errorMessage(loadError, "Could not load the firm's people."),
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadPeople();
    }, [loadPeople]);

    async function refreshMembers() {
        try {
            setMembers(await getFirmMembers());
        } catch (refreshError) {
            setError(
                errorMessage(refreshError, "Could not load the firm's people."),
            );
        }
    }

    async function saveMember(
        member: FirmMember,
        updates: {
            role?: FirmRole;
            status?: "active" | "deactivated";
            can_edit_firm_library?: boolean;
        },
    ) {
        setBusyUserId(member.user_id);
        setError(null);
        try {
            await updateFirmMember(member.user_id, updates);
            await refreshMembers();
            if (member.is_you) {
                await reloadProfile();
            }
        } catch (saveError) {
            setError(errorMessage(saveError, "That change did not save."));
        } finally {
            setBusyUserId(null);
        }
    }

    async function handleCreateInvite() {
        const email = inviteEmail.trim();
        if (!email) return;
        setInviteBusy(true);
        setInviteError(null);
        try {
            const invite = await createFirmInvite(email, inviteRole);
            setCreatedInvite(invite);
            setLinkCopied(false);
            setInvites(await getFirmInvites());
        } catch (createError) {
            setInviteError(
                errorMessage(createError, "Could not create the invitation."),
            );
        } finally {
            setInviteBusy(false);
        }
    }

    function closeInviteDialog() {
        if (inviteBusy) return;
        setInviteOpen(false);
        setInviteEmail("");
        setInviteRole("attorney");
        setInviteError(null);
        setCreatedInvite(null);
        setLinkCopied(false);
    }

    async function copyInviteLink(link: string) {
        await navigator.clipboard.writeText(link);
        setLinkCopied(true);
        window.setTimeout(() => setLinkCopied(false), 1600);
    }

    async function confirmCancelInvite() {
        if (!pendingCancelInvite) return;
        setCancellingInvite(true);
        setError(null);
        try {
            await cancelFirmInvite(pendingCancelInvite.id);
            setInvites(await getFirmInvites());
            setPendingCancelInvite(null);
        } catch (cancelError) {
            setError(
                errorMessage(
                    cancelError,
                    "Could not cancel that invitation.",
                ),
            );
            setPendingCancelInvite(null);
        } finally {
            setCancellingInvite(false);
        }
    }

    async function openHandover(member: FirmMember) {
        setHandoverMember(member);
        setMatters([]);
        setMatterTargets({});
        setHandoverError(null);
        setMattersLoading(true);
        try {
            setMatters(await getFirmMatters(member.user_id));
        } catch (loadError) {
            setHandoverError(
                errorMessage(loadError, "Could not load their matters."),
            );
        } finally {
            setMattersLoading(false);
        }
    }

    async function handOverMatter(matter: FirmMatterSummary) {
        const target = matterTargets[matter.id];
        if (!target) return;
        setBusyMatterId(matter.id);
        setHandoverError(null);
        try {
            await reassignFirmMatter(matter.id, target);
            setMatters((previous) =>
                previous.filter((item) => item.id !== matter.id),
            );
            await refreshMembers();
        } catch (moveError) {
            setHandoverError(
                errorMessage(moveError, "Could not hand that matter over."),
            );
        } finally {
            setBusyMatterId(null);
        }
    }

    const pendingInvites = invites.filter((invite) => !invite.accepted_at);
    const acceptedInvites = invites.filter((invite) => invite.accepted_at);
    const handoverCandidates = members.filter(
        (member) =>
            member.status === "active" &&
            member.user_id !== handoverMember?.user_id,
    );

    return (
        <div className="space-y-8">
            <AdminErrorBanner
                message={error}
                onDismiss={() => setError(null)}
            />

            <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        People
                    </h2>
                    <PillButton
                        tone="blue"
                        size="sm"
                        onClick={() => setInviteOpen(true)}
                        className="shrink-0"
                    >
                        <UserPlus className="h-4 w-4 shrink-0" />
                        Invite someone
                    </PillButton>
                </div>
                <SettingsSection>
                    {loading ? (
                        <PeopleSkeleton />
                    ) : members.length === 0 ? (
                        <p className="p-4 text-sm text-gray-500">
                            Nobody has joined this firm yet.
                        </p>
                    ) : (
                        <ul className="divide-y divide-white/60">
                            {members.map((member) => {
                                const busy = busyUserId === member.user_id;
                                return (
                                    <li
                                        key={member.user_id}
                                        className="flex flex-col gap-4 px-4 py-5 lg:flex-row lg:items-end lg:justify-between"
                                    >
                                        <div className="min-w-0 flex-1 space-y-1">
                                            <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
                                                <span className="truncate">
                                                    {personLabel(member)}
                                                </span>
                                                {member.is_you && (
                                                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                                                        You
                                                    </span>
                                                )}
                                                {member.status ===
                                                    "deactivated" && (
                                                    <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
                                                        Cannot sign in
                                                    </span>
                                                )}
                                            </p>
                                            {member.email && (
                                                <p className="truncate text-sm text-gray-500">
                                                    {member.email}
                                                </p>
                                            )}
                                            <p className="text-xs text-gray-500">
                                                {member.matter_count === 0
                                                    ? "No matters"
                                                    : member.matter_count === 1
                                                      ? "Responsible for 1 matter"
                                                      : `Responsible for ${member.matter_count} matters`}
                                                {member.matter_count > 0 && (
                                                    <>
                                                        {" · "}
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                void openHandover(
                                                                    member,
                                                                )
                                                            }
                                                            className="font-medium text-gray-700 transition-colors hover:text-gray-950"
                                                        >
                                                            Hand over matters
                                                        </button>
                                                    </>
                                                )}
                                            </p>
                                        </div>

                                        <div className="flex flex-wrap items-end gap-4">
                                            <div className="w-44">
                                                <FieldLabel
                                                    as="span"
                                                    className={
                                                        controlLabelClassName
                                                    }
                                                >
                                                    Role
                                                </FieldLabel>
                                                <ModalSelect
                                                    id={`role-${member.user_id}`}
                                                    value={member.role}
                                                    options={ROLE_OPTIONS}
                                                    disabled={busy}
                                                    onChange={(value) =>
                                                        void saveMember(
                                                            member,
                                                            {
                                                                role: value as FirmRole,
                                                            },
                                                        )
                                                    }
                                                />
                                            </div>

                                            <div>
                                                <FieldLabel
                                                    as="span"
                                                    className={
                                                        controlLabelClassName
                                                    }
                                                >
                                                    Firm library
                                                </FieldLabel>
                                                <ModalSegmentedToggle
                                                    value={
                                                        member.can_edit_firm_library
                                                            ? "edit"
                                                            : "read"
                                                    }
                                                    disabled={busy}
                                                    options={[
                                                        {
                                                            value: "edit",
                                                            label: "Can edit",
                                                        },
                                                        {
                                                            value: "read",
                                                            label: "Read only",
                                                        },
                                                    ]}
                                                    onChange={(value) =>
                                                        void saveMember(
                                                            member,
                                                            {
                                                                can_edit_firm_library:
                                                                    value ===
                                                                    "edit",
                                                            },
                                                        )
                                                    }
                                                />
                                            </div>

                                            {!member.is_you && (
                                                <div>
                                                    <FieldLabel
                                                        as="span"
                                                        className={
                                                            controlLabelClassName
                                                        }
                                                    >
                                                        Account
                                                    </FieldLabel>
                                                    <ModalSegmentedToggle
                                                        value={member.status}
                                                        disabled={busy}
                                                        options={[
                                                            {
                                                                value: "active",
                                                                label: "Active",
                                                            },
                                                            {
                                                                value: "deactivated",
                                                                label: "Deactivated",
                                                            },
                                                        ]}
                                                        onChange={(value) => {
                                                            if (
                                                                value ===
                                                                member.status
                                                            )
                                                                return;
                                                            if (
                                                                value ===
                                                                "deactivated"
                                                            ) {
                                                                setPendingDeactivate(
                                                                    member,
                                                                );
                                                                return;
                                                            }
                                                            void saveMember(
                                                                member,
                                                                {
                                                                    status: "active",
                                                                },
                                                            );
                                                        }}
                                                    />
                                                </div>
                                            )}

                                            {busy && (
                                                <Loader2 className="mb-2 h-4 w-4 animate-spin text-gray-400" />
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Invitations
                </h2>
                <SettingsSection>
                    {loading ? (
                        <PeopleSkeleton />
                    ) : invites.length === 0 ? (
                        <p className="p-4 text-sm text-gray-500">
                            No invitations yet. Mike does not send invitation
                            emails — you create a link and pass it on yourself.
                        </p>
                    ) : (
                        <ul className="divide-y divide-white/60">
                            {pendingInvites.map((invite) => (
                                <li
                                    key={invite.id}
                                    className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                                >
                                    <div className="min-w-0 space-y-1">
                                        <p className="truncate text-sm font-medium text-gray-900">
                                            {invite.email}
                                        </p>
                                        <p className="text-xs text-gray-500">
                                            {roleLabel(invite.role)} · expires{" "}
                                            {formatDate(invite.expires_at)}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-3">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void copyInviteLink(invite.link)
                                            }
                                            className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                                        >
                                            <Copy className="h-3 w-3" />
                                            Copy link
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setPendingCancelInvite(invite)
                                            }
                                            className="text-xs font-medium text-red-600 transition-colors hover:text-red-700"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </li>
                            ))}
                            {acceptedInvites.map((invite) => (
                                <li
                                    key={invite.id}
                                    className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                                >
                                    <div className="min-w-0 space-y-1">
                                        <p className="truncate text-sm font-medium text-gray-900">
                                            {invite.email}
                                        </p>
                                        <p className="text-xs text-gray-500">
                                            {roleLabel(invite.role)}
                                        </p>
                                    </div>
                                    <span className="shrink-0 text-xs font-medium text-green-700">
                                        Accepted {formatDate(invite.accepted_at)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </SettingsSection>
            </section>

            <Modal
                open={inviteOpen}
                onClose={closeInviteDialog}
                size="md"
                breadcrumbs={["People", "Invite someone"]}
                cancelAction={
                    createdInvite
                        ? false
                        : {
                              label: "Cancel",
                              onClick: closeInviteDialog,
                              disabled: inviteBusy,
                          }
                }
                primaryAction={
                    createdInvite
                        ? { label: "Done", onClick: closeInviteDialog }
                        : {
                              label: inviteBusy ? "Creating..." : "Create link",
                              onClick: () => void handleCreateInvite(),
                              disabled: inviteBusy || !inviteEmail.trim(),
                          }
                }
            >
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-3">
                    {createdInvite ? (
                        <>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-700">
                                    Invitation ready for {createdInvite.email}
                                </p>
                                <p className="text-sm text-gray-500">
                                    Mike does not email the invitation. Copy the
                                    link below and send it to them yourself. It
                                    works once, and expires on{" "}
                                    {formatDate(createdInvite.expires_at)}.
                                </p>
                            </div>
                            <div className="space-y-2 rounded-xl bg-gray-100 px-3 py-3">
                                <p className="break-all text-xs text-gray-700">
                                    {createdInvite.link}
                                </p>
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={() =>
                                        void copyInviteLink(createdInvite.link)
                                    }
                                >
                                    <Copy className="h-3 w-3 shrink-0" />
                                    {linkCopied ? "Copied" : "Copy link"}
                                </PillButton>
                            </div>
                        </>
                    ) : (
                        <>
                            <div>
                                <FieldLabel htmlFor="invite-email">
                                    Email address
                                </FieldLabel>
                                <SettingsTextInput
                                    id="invite-email"
                                    type="email"
                                    value={inviteEmail}
                                    onChange={(event) => {
                                        setInviteEmail(event.target.value);
                                        setInviteError(null);
                                    }}
                                    placeholder="name@firm.com"
                                />
                            </div>
                            <div>
                                <FieldLabel as="span">Role</FieldLabel>
                                <ModalSelect
                                    id="invite-role"
                                    value={inviteRole}
                                    options={ROLE_OPTIONS}
                                    onChange={(value) =>
                                        setInviteRole(value as FirmRole)
                                    }
                                />
                            </div>
                            <AdminErrorBanner
                                message={inviteError}
                                onDismiss={() => setInviteError(null)}
                            />
                        </>
                    )}
                </div>
            </Modal>

            <Modal
                open={!!handoverMember}
                onClose={() => setHandoverMember(null)}
                breadcrumbs={[
                    "People",
                    handoverMember
                        ? `${personLabel(handoverMember)}'s matters`
                        : "Matters",
                ]}
                cancelAction={{
                    label: "Close",
                    onClick: () => setHandoverMember(null),
                }}
            >
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-3">
                    <p className="text-sm text-gray-500">
                        Choose who each matter should belong to from now on. The
                        matter and everything in it stays as it is — only the
                        person responsible for it changes.
                    </p>
                    <AdminErrorBanner
                        message={handoverError}
                        onDismiss={() => setHandoverError(null)}
                    />
                    {mattersLoading ? (
                        <div className="flex justify-center py-6">
                            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                        </div>
                    ) : matters.length === 0 ? (
                        <p className="text-sm text-gray-500">
                            Nothing left to hand over.
                        </p>
                    ) : (
                        <ul className="space-y-3">
                            {matters.map((matter) => (
                                <li
                                    key={matter.id}
                                    className="space-y-2 rounded-xl bg-gray-100 px-3 py-3"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium text-gray-900">
                                            {matter.name}
                                        </p>
                                        {matter.cm_number && (
                                            <p className="text-xs text-gray-500">
                                                {matter.cm_number}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                        <div className="min-w-0 flex-1">
                                            <ModalSelect
                                                id={`handover-${matter.id}`}
                                                value={
                                                    matterTargets[matter.id] ??
                                                    ""
                                                }
                                                placeholder="Hand over to..."
                                                options={handoverCandidates.map(
                                                    (candidate) => ({
                                                        value: candidate.user_id,
                                                        label: personLabel(
                                                            candidate,
                                                        ),
                                                    }),
                                                )}
                                                disabled={
                                                    busyMatterId === matter.id
                                                }
                                                onChange={(value) =>
                                                    setMatterTargets(
                                                        (previous) => ({
                                                            ...previous,
                                                            [matter.id]: value,
                                                        }),
                                                    )
                                                }
                                            />
                                        </div>
                                        <PillButton
                                            tone="black"
                                            size="sm"
                                            className="shrink-0"
                                            disabled={
                                                !matterTargets[matter.id] ||
                                                busyMatterId === matter.id
                                            }
                                            onClick={() =>
                                                void handOverMatter(matter)
                                            }
                                        >
                                            {busyMatterId === matter.id
                                                ? "Handing over..."
                                                : "Hand over"}
                                        </PillButton>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Modal>

            <ConfirmPopup
                open={!!pendingDeactivate}
                title={
                    pendingDeactivate
                        ? `Deactivate ${personLabel(pendingDeactivate)}?`
                        : undefined
                }
                message="They will be signed out and cannot sign in again. Their matters stay with the firm."
                confirmLabel="Deactivate"
                cancelLabel="Keep access"
                onCancel={() => setPendingDeactivate(null)}
                onConfirm={() => {
                    const member = pendingDeactivate;
                    setPendingDeactivate(null);
                    if (member) {
                        void saveMember(member, { status: "deactivated" });
                    }
                }}
            />

            <ConfirmPopup
                open={!!pendingCancelInvite}
                title="Cancel this invitation?"
                message={
                    pendingCancelInvite
                        ? `The link you sent to ${pendingCancelInvite.email} will stop working. You can always create a new one.`
                        : undefined
                }
                confirmLabel="Remove"
                cancelLabel="Keep it"
                confirmStatus={cancellingInvite ? "loading" : "idle"}
                onCancel={() => setPendingCancelInvite(null)}
                onConfirm={() => void confirmCancelInvite()}
            />
        </div>
    );
}
