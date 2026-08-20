"use client";

import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { SettingsSection } from "../SettingsSection";

const MODEL_API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-...",
    },
    {
        provider: "gemini",
        label: "Google (Gemini) API Key",
        placeholder: "AI...",
    },
    {
        provider: "openai",
        label: "OpenAI API Key",
        placeholder: "sk-...",
    },
    {
        provider: "openrouter",
        label: "OpenRouter API Key",
        placeholder: "sk-or-...",
    },
] as const;

export default function ApiKeysPage() {
    const { profile, updateApiKey } = useUserProfile();

    return (
        <div>
            <div className="mb-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    API Keys
                </h2>
            </div>
            <p className="text-sm text-gray-500 mb-4">
                A key you add here is yours and is used before anything else.
                If your firm has an account with a provider, or this server was
                set up with one, that is used instead and you do not need to add
                anything. Every key is encrypted where it is stored.
            </p>
            <SettingsSection>
                {MODEL_API_KEY_FIELDS.map((field) => (
                    <div key={field.provider}>
                        <ApiKeyField
                            label={field.label}
                            placeholder={field.placeholder}
                            hasSavedKey={
                                !!profile?.apiKeys[field.provider].configured
                            }
                            keySource={
                                profile?.apiKeys[field.provider].source ?? null
                            }
                            onSave={(value) =>
                                updateApiKey(
                                    field.provider,
                                    value.trim() || null,
                                )
                            }
                            onRemove={() => updateApiKey(field.provider, null)}
                        />
                    </div>
                ))}
            </SettingsSection>

        </div>
    );
}
