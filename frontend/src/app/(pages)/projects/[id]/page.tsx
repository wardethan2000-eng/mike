"use client";

import { use } from "react";
import { ProjectOverviewView } from "@/app/components/projects/ProjectOverviewView";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectDetailPage({ params }: Props) {
    const { id } = use(params);
    return <ProjectOverviewView projectId={id} />;
}
