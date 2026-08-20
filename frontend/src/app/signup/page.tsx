"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/app/lib/supabase";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    acceptInvite,
    lookUpInvite,
    updateUserProfile,
    type InviteDetails,
} from "@/app/lib/mikeApi";

const authGlassCardClassName =
    "rounded-2xl border border-white/70 bg-white/72 p-8 shadow-[0_4px_14px_rgba(15,23,42,0.045),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-8px_18px_rgba(255,255,255,0.12)] backdrop-blur-2xl";
const authInputClassName =
    "rounded-lg border border-transparent bg-gray-100 px-3 shadow-none focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45";
const authToggleClassName =
    "flex gap-1 rounded-full bg-gray-200 p-1 text-xs font-medium";
const authToggleActiveClassName =
    "inline-flex h-6 items-center rounded-full border border-white/80 bg-white/86 px-3 text-gray-900 shadow-[0_2px_7px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-3px_7px_rgba(229,231,235,0.32)] backdrop-blur-xl";
const authToggleInactiveClassName =
    "inline-flex h-6 items-center rounded-full border border-transparent px-3 text-gray-500 transition-colors hover:bg-white/38 hover:text-gray-900";

const MIN_INVITE_PASSWORD = 8;

/**
 * Accounts are created by invitation. When a firm's administrator has sent
 * someone a link, the address is already settled and all that is left is a
 * name and a password. Without a link this falls back to the ordinary form,
 * which the server refuses once open registration is switched off — so the
 * refusal is translated into something a person can act on.
 */
function signupErrorMessage(error: unknown): string {
    const raw =
        error instanceof Error ? error.message : "Something went wrong.";
    if (/signups? not allowed|disabled/i.test(raw)) {
        return "New accounts are by invitation. Ask your firm's administrator to send you an invitation link.";
    }
    return raw;
}

function SignupPageInner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const inviteToken = searchParams.get("invite");
    const { isAuthenticated, authLoading } = useAuth();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [name, setName] = useState("");
    const [organisation, setOrganisation] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    const [invite, setInvite] = useState<InviteDetails | null>(null);
    const [inviteLoading, setInviteLoading] = useState(!!inviteToken);
    const [inviteProblem, setInviteProblem] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated && !success) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router, success]);

    useEffect(() => {
        if (!inviteToken) return;
        let cancelled = false;
        setInviteLoading(true);
        lookUpInvite(inviteToken)
            .then((details) => {
                if (cancelled) return;
                setInvite(details);
                setEmail(details.email);
                setInviteProblem(null);
            })
            .catch(() => {
                if (cancelled) return;
                setInvite(null);
                setInviteProblem(
                    "This invitation has expired or has already been used. Ask your firm's administrator for a new link.",
                );
            })
            .finally(() => {
                if (!cancelled) setInviteLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [inviteToken]);

    const finish = useCallback(() => {
        setSuccess(true);
        setTimeout(() => router.push("/assistant"), 1500);
    }, [router]);

    const handleJoinFirm = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (password !== confirmPassword) {
            setError("Those passwords are not the same.");
            return;
        }
        if (password.length < MIN_INVITE_PASSWORD) {
            setError(
                `Choose a password of at least ${MIN_INVITE_PASSWORD} characters.`,
            );
            return;
        }
        setLoading(true);
        try {
            await acceptInvite({
                token: inviteToken as string,
                password,
                displayName: name.trim() || undefined,
            });
            const { error: signInError } =
                await supabase.auth.signInWithPassword({
                    email: invite?.email ?? email,
                    password,
                });
            if (signInError) throw signInError;
            finish();
        } catch (err) {
            setError(signupErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            setLoading(false);
            return;
        }

        if (password.length < 6) {
            setError("Password must be at least 6 characters");
            setLoading(false);
            return;
        }

        try {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
            });

            if (error) throw error;

            if (data.session) {
                const trimmedName = name.trim();
                const trimmedOrg = organisation.trim();
                if (trimmedName || trimmedOrg) {
                    try {
                        await updateUserProfile({
                            ...(trimmedName && { displayName: trimmedName }),
                            ...(trimmedOrg && { organisation: trimmedOrg }),
                        });
                    } catch (profileError) {
                        console.error(
                            "[signup] failed to persist profile fields",
                            profileError,
                        );
                    }
                }
            }
            finish();
        } catch (error: unknown) {
            setError(signupErrorMessage(error));
        } finally {
            setLoading(false);
        }
    };

    if (success) {
        return (
            <div className="min-h-dvh bg-gray-50/80 flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="lg" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div
                        className={`${authGlassCardClassName} p-10 text-center`}
                    >
                        <div className="mx-auto w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mb-6">
                            <CheckCircle2 className="h-6 w-6 text-green-600" />
                        </div>
                        <h2 className="text-2xl font-bold text-gray-950 mb-3">
                            {invite ? "You're all set" : "Account created!"}
                        </h2>
                        <p className="text-gray-600 leading-relaxed">
                            Taking you to Mike...
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const showInviteForm = !!inviteToken && !!invite;

    return (
        <div className="min-h-dvh bg-gray-50/80 flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={`${authGlassCardClassName} mb-4`}>
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-medium font-serif text-gray-950">
                            {showInviteForm ? "Join your firm" : "Create Account"}
                        </h2>
                        <div className={authToggleClassName}>
                            <Link
                                href="/login"
                                className={authToggleInactiveClassName}
                            >
                                Log in
                            </Link>
                            <span className={authToggleActiveClassName}>
                                Sign up
                            </span>
                        </div>
                    </div>

                    {inviteLoading && (
                        <div className="flex items-center gap-2 text-sm text-gray-600 py-6">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Checking your invitation...
                        </div>
                    )}

                    {!inviteLoading && inviteProblem && (
                        <div className="mb-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
                            {inviteProblem}
                        </div>
                    )}

                    {!inviteLoading && showInviteForm && (
                        <form onSubmit={handleJoinFirm} className="space-y-4">
                            <p className="text-sm text-gray-600">
                                {invite?.firm_name
                                    ? `${invite.firm_name} has invited you to Mike.`
                                    : "You have been invited to Mike."}{" "}
                                Choose a password and you are in.
                            </p>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Email
                                </label>
                                <Input
                                    type="email"
                                    value={invite?.email ?? ""}
                                    readOnly
                                    disabled
                                    className={`w-full ${authInputClassName} text-gray-600`}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    Your invitation was sent to this address.
                                </p>
                            </div>

                            <div>
                                <label
                                    htmlFor="invite-name"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    Your name
                                </label>
                                <Input
                                    id="invite-name"
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="How your colleagues will see you"
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="invite-password"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    Password
                                </label>
                                <Input
                                    id="invite-password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder={`At least ${MIN_INVITE_PASSWORD} characters`}
                                    required
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="invite-confirm"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    Confirm password
                                </label>
                                <Input
                                    id="invite-confirm"
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(e) =>
                                        setConfirmPassword(e.target.value)
                                    }
                                    placeholder="Type it once more"
                                    required
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>

                            {error && (
                                <div className="flex items-start justify-between gap-3 rounded bg-red-50 p-3 text-sm text-red-600">
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

                            <Button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-black hover:bg-gray-900 text-white"
                            >
                                {loading ? "Setting up..." : "Join the firm"}
                            </Button>
                        </form>
                    )}

                    {!inviteLoading && !showInviteForm && (
                        <>
                            {!inviteToken && (
                                <p className="mb-4 text-sm text-gray-600">
                                    Joining a firm? Open the invitation link
                                    your administrator sent you.
                                </p>
                            )}
                            <form onSubmit={handleSignup} className="space-y-4">
                                <div>
                                    <label
                                        htmlFor="name"
                                        className="block text-sm font-medium text-gray-700 mb-2"
                                    >
                                        Name{" "}
                                        <span className="text-gray-400 font-normal">
                                            (optional)
                                        </span>
                                    </label>
                                    <Input
                                        id="name"
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        placeholder="Your name"
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>

                                <div>
                                    <label
                                        htmlFor="organisation"
                                        className="block text-sm font-medium text-gray-700 mb-2"
                                    >
                                        Organisation{" "}
                                        <span className="text-gray-400 font-normal">
                                            (optional)
                                        </span>
                                    </label>
                                    <Input
                                        id="organisation"
                                        type="text"
                                        value={organisation}
                                        onChange={(e) =>
                                            setOrganisation(e.target.value)
                                        }
                                        placeholder="Your organisation"
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>

                                <div>
                                    <label
                                        htmlFor="email"
                                        className="block text-sm font-medium text-gray-700 mb-2"
                                    >
                                        Email
                                    </label>
                                    <Input
                                        id="email"
                                        type="email"
                                        value={email}
                                        onChange={(e) =>
                                            setEmail(e.target.value)
                                        }
                                        placeholder="Enter your email"
                                        required
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>

                                <div>
                                    <label
                                        htmlFor="password"
                                        className="block text-sm font-medium text-gray-700 mb-2"
                                    >
                                        Password
                                    </label>
                                    <Input
                                        id="password"
                                        type="password"
                                        value={password}
                                        onChange={(e) =>
                                            setPassword(e.target.value)
                                        }
                                        placeholder="Create a password (min. 6 characters)"
                                        required
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>

                                <div>
                                    <label
                                        htmlFor="confirmPassword"
                                        className="block text-sm font-medium text-gray-700 mb-2"
                                    >
                                        Confirm Password
                                    </label>
                                    <Input
                                        id="confirmPassword"
                                        type="password"
                                        value={confirmPassword}
                                        onChange={(e) =>
                                            setConfirmPassword(e.target.value)
                                        }
                                        placeholder="Confirm your password"
                                        required
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>

                                {error && (
                                    <div className="flex items-start justify-between gap-3 rounded bg-red-50 p-3 text-sm text-red-600">
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

                                <Button
                                    type="submit"
                                    disabled={loading}
                                    className="w-full bg-black hover:bg-gray-900 text-white"
                                >
                                    {loading ? "Creating account..." : "Sign up"}
                                </Button>
                            </form>
                        </>
                    )}

                    <div className="mt-4 text-center text-xs text-gray-500">
                        By signing up, you agree to our{" "}
                        <Link
                            href="https://mikeoss.com/terms"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                        >
                            Terms of Use
                        </Link>{" "}
                        and{" "}
                        <Link
                            href="https://mikeoss.com/privacy"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                        >
                            Privacy Policy
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function SignupPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-dvh bg-gray-50/80 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
            }
        >
            <SignupPageInner />
        </Suspense>
    );
}
