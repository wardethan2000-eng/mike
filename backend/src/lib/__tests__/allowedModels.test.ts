import { describe, expect, it } from "vitest";
import {
    filterAllowedModels,
    isModelAllowed,
    normalizeAllowedModels,
} from "../allowedModels";

describe("the shortlist of models a firm allows", () => {
    it("keeps the ids it is given, tidied and without repeats", () => {
        expect(
            normalizeAllowedModels([
                " claude-opus-4-8 ",
                "ollama/glm-5.2",
                "claude-opus-4-8",
                "",
                "   ",
            ]),
        ).toEqual(["claude-opus-4-8", "ollama/glm-5.2"]);
    });

    it("treats an empty list as no shortlist at all", () => {
        // Otherwise clearing the box would lock everybody out of every model,
        // which is never what somebody means by clearing it.
        expect(normalizeAllowedModels([])).toBeNull();
        expect(normalizeAllowedModels(["", "  "])).toBeNull();
    });

    it("ignores anything that is not a list", () => {
        expect(normalizeAllowedModels(null)).toBeNull();
        expect(normalizeAllowedModels(undefined)).toBeNull();
        expect(normalizeAllowedModels("claude-opus-4-8")).toBeNull();
        expect(normalizeAllowedModels({ id: "x" })).toBeNull();
    });

    it("allows everything when the firm has not named a shortlist", () => {
        expect(isModelAllowed("anything-at-all", null)).toBe(true);
    });

    it("allows only what is on the shortlist", () => {
        const allowed = ["claude-opus-4-8", "ollama/glm-5.2"];
        expect(isModelAllowed("claude-opus-4-8", allowed)).toBe(true);
        expect(isModelAllowed("gpt-5.5", allowed)).toBe(false);
    });

    it("matches a local model on its whole name, prefix and all", () => {
        // "glm-5.2" on its own is not a model id anywhere else in Mike, so it
        // must not be one here either.
        expect(isModelAllowed("ollama/glm-5.2", ["ollama/glm-5.2"])).toBe(true);
        expect(isModelAllowed("ollama/glm-5.2", ["glm-5.2"])).toBe(false);
        expect(isModelAllowed("glm-5.2", ["ollama/glm-5.2"])).toBe(false);
    });

    it("lets a request through that names no model at all", () => {
        // The route falls back to the person's saved choice in that case.
        expect(isModelAllowed(undefined, ["claude-opus-4-8"])).toBe(true);
        expect(isModelAllowed(null, ["claude-opus-4-8"])).toBe(true);
    });

    it("drops the models the firm does not allow from a picker list", () => {
        const models = [
            { id: "claude-opus-4-8" },
            { id: "gpt-5.5" },
            { id: "ollama/glm-5.2" },
        ];
        expect(
            filterAllowedModels(models, ["claude-opus-4-8", "ollama/glm-5.2"]),
        ).toEqual([{ id: "claude-opus-4-8" }, { id: "ollama/glm-5.2" }]);
    });

    it("leaves a picker list alone when there is no shortlist", () => {
        const models = [{ id: "gpt-5.5" }];
        expect(filterAllowedModels(models, null)).toEqual(models);
    });
});
