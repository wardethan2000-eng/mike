import type { FirmRole } from "@/app/lib/mikeApi";

export const ROLE_OPTIONS: { value: FirmRole; label: string }[] = [
    { value: "admin", label: "Administrator" },
    { value: "attorney", label: "Attorney" },
    { value: "paralegal", label: "Paralegal" },
];

export function roleLabel(role: FirmRole) {
    return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

export function personLabel(person: {
    display_name: string | null;
    email: string | null;
}) {
    return person.display_name?.trim() || person.email || "Unnamed person";
}

export function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
}

export function formatDate(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export const US_STATE_OPTIONS = [
    "Alabama",
    "Alaska",
    "Arizona",
    "Arkansas",
    "California",
    "Colorado",
    "Connecticut",
    "Delaware",
    "District of Columbia",
    "Florida",
    "Georgia",
    "Hawaii",
    "Idaho",
    "Illinois",
    "Indiana",
    "Iowa",
    "Kansas",
    "Kentucky",
    "Louisiana",
    "Maine",
    "Maryland",
    "Massachusetts",
    "Michigan",
    "Minnesota",
    "Mississippi",
    "Missouri",
    "Montana",
    "Nebraska",
    "Nevada",
    "New Hampshire",
    "New Jersey",
    "New Mexico",
    "New York",
    "North Carolina",
    "North Dakota",
    "Ohio",
    "Oklahoma",
    "Oregon",
    "Pennsylvania",
    "Rhode Island",
    "South Carolina",
    "South Dakota",
    "Tennessee",
    "Texas",
    "Utah",
    "Vermont",
    "Virginia",
    "Washington",
    "West Virginia",
    "Wisconsin",
    "Wyoming",
] as const;

export const CITATION_STYLE_OPTIONS = [
    "Bluebook",
    "ALWD Guide to Legal Citation",
    "State court rules",
] as const;
