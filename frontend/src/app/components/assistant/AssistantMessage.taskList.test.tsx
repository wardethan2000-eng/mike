import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

const LIST: Extract<AssistantEvent, { type: "task_list" }> = {
    type: "task_list",
    steps: [
        { step: "Read the Graver file", status: "done" },
        { step: "Draft the demand letter to Acme Holdings", status: "doing" },
        { step: "Draft the demand letter to Borden Equipment", status: "pending" },
        { step: "Draft the demand letter to Chen Leasing", status: "dropped", reason: "lease was assigned away" },
    ],
};

const WORKING_PARAGRAPH = "Let me read the file before drafting anything.";
const THE_ANSWER = "All three letters are drafted and the authorities check out.";

function longJob(): AssistantEvent[] {
    return [
        { type: "content", text: WORKING_PARAGRAPH },
        LIST,
        { type: "doc_read", filename: "graver.pdf", document_id: "d1" },
        { type: "reasoning", text: "thinking about the amounts" },
        { type: "content", text: THE_ANSWER },
    ];
}

describe("the job list on a message", () => {
    it("shows one checklist for the whole message, summarised when the turn ends", () => {
        render(<AssistantMessage events={longJob()} />);
        // Two steps of four are neither done nor dropped.
        expect(
            screen.getAllByText("1 of 4 steps done, 1 dropped, 2 outstanding"),
        ).toHaveLength(1);
    });

    it("expands to the steps, with the dropped one's reason beside it", () => {
        render(<AssistantMessage events={longJob()} />);
        // Something is outstanding, so it opens by itself.
        expect(
            screen.getByText("Draft the demand letter to Acme Holdings"),
        ).toBeInTheDocument();
        expect(
            screen.getByText("— lease was assigned away"),
        ).toBeInTheDocument();
    });

    it("folds to one line when every step is done, and opens again on a click", () => {
        const done: AssistantEvent[] = [
            {
                type: "task_list",
                steps: [
                    { step: "Draft the notice", status: "done" },
                    { step: "Check the authorities", status: "done" },
                ],
            },
            { type: "doc_read", filename: "graver.pdf", document_id: "d1" },
            { type: "content", text: THE_ANSWER },
        ];
        render(<AssistantMessage events={done} />);
        expect(screen.queryByText("Draft the notice")).not.toBeInTheDocument();
        fireEvent.click(screen.getByText("2 steps — all done"));
        expect(screen.getByText("Draft the notice")).toBeInTheDocument();
    });
});

describe("the working area", () => {
    it("keeps the answer out of the box and folds the work away", () => {
        render(<AssistantMessage events={longJob()} />);
        // The answer is always there, at full size.
        expect(screen.getByText(THE_ANSWER)).toBeInTheDocument();
        // The work is folded, so the paragraph written before the tool call
        // is not on screen until the reader asks for it.
        expect(screen.queryByText(WORKING_PARAGRAPH)).not.toBeInTheDocument();
        fireEvent.click(screen.getByText(/Worked through/));
        expect(screen.getByText(WORKING_PARAGRAPH)).toBeInTheDocument();
    });

    it("counts a paragraph followed by a job-list update as working, not answer", () => {
        // The task_list call draws no activity row, so a rule that looked only
        // at what renders would call this paragraph the answer.
        const events: AssistantEvent[] = [
            { type: "doc_read", filename: "graver.pdf", document_id: "d1" },
            { type: "content", text: WORKING_PARAGRAPH },
            LIST,
            { type: "content", text: THE_ANSWER },
        ];
        render(<AssistantMessage events={events} />);
        expect(screen.getByText(THE_ANSWER)).toBeInTheDocument();
        expect(screen.queryByText(WORKING_PARAGRAPH)).not.toBeInTheDocument();
    });

    it("keeps the pause card out of the box so Keep going can be pressed", () => {
        const events: AssistantEvent[] = [
            { type: "doc_read", filename: "graver.pdf", document_id: "d1" },
            { type: "content", text: THE_ANSWER },
            {
                type: "paused",
                reason: "iterations",
                message: "Paused after 2 research steps — 0 of 6 steps done.",
                resume_token: "token",
                iterations: 2,
            },
        ];
        render(<AssistantMessage events={events} />);
        expect(
            screen.getByText("Paused after 2 research steps — 0 of 6 steps done."),
        ).toBeInTheDocument();
    });

    it("leaves an ordinary answer with no tool activity exactly as it was", () => {
        render(
            <AssistantMessage
                events={[{ type: "content", text: THE_ANSWER }]}
            />,
        );
        expect(screen.getByText(THE_ANSWER)).toBeInTheDocument();
        expect(screen.queryByText(/Worked through/)).not.toBeInTheDocument();
    });

    it("does not box a turn that produced no answer at all", () => {
        render(
            <AssistantMessage
                events={[
                    { type: "doc_read", filename: "graver.pdf", document_id: "d1" },
                ]}
            />,
        );
        expect(screen.getByText("graver.pdf")).toBeInTheDocument();
    });
});
