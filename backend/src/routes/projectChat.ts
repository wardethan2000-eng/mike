import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { whoIsAskingSection } from "../lib/draftingContext";
import {
    allowedModelsForFirm,
    isModelAllowed,
    MODEL_NOT_ALLOWED_DETAIL,
} from "../lib/allowedModels";
import { recordChatTurn } from "../lib/audit";
import {
    buildProjectDocContext,
    mergeChatOnlyDocs,
    buildMessages,
    buildWorkflowStore,
    enrichWithPriorEvents,
    appendAskInputsResponseToLastAssistantMessage,
    appendAssistantEventsToLastAssistantMessage,
    AssistantStreamError,
    buildCancelledAssistantMessage,
    extractCitations,
    generateSpotlightNonce,
    isAbortError,
    runLLMStream,
    spotlightFilename,
    stripTransientAssistantEvents,
    PROJECT_EXTRA_TOOLS,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalAttachedDocuments,
    parseOptionalChatId,
    parseOptionalDisplayedDoc,
    parseOptionalModel,
    parseOptionalResume,
    condenseForContinuation,
    takeResumeState,
    type ChatMessage,
} from "../lib/chat";
import {
    getUserModelSettings,
} from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { startSseHeartbeat } from "../lib/chat/routeStreaming";
import {
    loadProjectContext,
    caseOverviewPromptSection,
} from "../lib/projectOverview";
import { proposeMemoriesForTurn } from "../lib/memoryProposals";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";
import { generateAssistantChatTitle } from "../lib/chatTitle";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
Copies created with replicate_document are saved as project documents in this project. After replication, use the returned doc_id for any requested edits.`;

export const projectChatRouter = Router({ mergeParams: true });

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessages = parseChatMessages(body.messages);
    if (!parsedMessages.ok) {
        return void res.status(400).json({ detail: parsedMessages.detail });
    }
    const parsedChatId = parseOptionalChatId(body.chat_id);
    if (!parsedChatId.ok) {
        return void res.status(400).json({ detail: parsedChatId.detail });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedDisplayedDoc = parseOptionalDisplayedDoc(body.displayed_doc);
    if (!parsedDisplayedDoc.ok) {
        return void res.status(400).json({ detail: parsedDisplayedDoc.detail });
    }
    const parsedAttachedDocuments = parseOptionalAttachedDocuments(
        body.attached_documents,
    );
    if (!parsedAttachedDocuments.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAttachedDocuments.detail });
    }
    const parsedAskInputsResponse = parseOptionalAskInputsResponse(
        body.ask_inputs_response,
    );
    if (!parsedAskInputsResponse.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAskInputsResponse.detail });
    }

    const messages = parsedMessages.value;
    const chat_id = parsedChatId.value;
    const model = parsedModel.value;
    const displayed_doc = parsedDisplayedDoc.value;
    const attached_documents = parsedAttachedDocuments.value;
    const parsedResume = parseOptionalResume(body.resume);
    if (!parsedResume.ok) {
        return void res.status(400).json({ detail: parsedResume.detail });
    }
    const resume = parsedResume.value;
    const askInputsResponse = parsedAskInputsResponse.value;
    if (resume && !chat_id) {
        return void res.status(400).json({ detail: "resume requires chat_id" });
    }
    // Continuing a paused turn adds to the answer already on screen.
    const appendToPrevious = !!askInputsResponse || !!resume;

    const db = createServerSupabase();

    // The firm may have named a shortlist of models. It applies to everybody,
    // and to a request sent straight at the API as much as to the picker.
    if (!isModelAllowed(model, await allowedModelsForFirm(db))) {
        return void res.status(403).json({ detail: MODEL_NOT_ALLOWED_DETAIL });
    }

    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select("id, title, project_id")
            .eq("id", chatId)
            .single();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else chatTitle = existing!.title;
    }

    if (!chatId) {
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: projectId })
            .select("id, title")
            .single();
        if (error || !newChat)
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (askInputsResponse) {
        await appendAskInputsResponseToLastAssistantMessage(
            db,
            chatId,
            askInputsResponse,
        );
    } else if (lastUser && !resume) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        });
    }

    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
        projectId,
        userId,
        db,
    );
    // Files dropped straight onto the chat live in the chat, not the project,
    // so they are not in the list above. Add them or the assistant cannot
    // open the very file the user just handed it.
    await mergeChatOnlyDocs(
        messages,
        userId,
        db,
        { docIndex, docStore },
        userEmail,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: folderPaths.get(doc_id),
    }));
    const documentsById = new Map(
        Object.entries(docIndex).map(([slug, document]) => [
            document.document_id,
            { slug, filename: document.filename },
        ] as const),
    );
    // Generate the nonce before adding request metadata or prior events so
    // every document filename is fenced wherever it enters the prompt.
    const nonce = generateSpotlightNonce();
    const documentPromptRef = (
        documentId: string,
        requestFilename: string,
    ) => {
        const document = documentsById.get(documentId);
        return {
            slug: document?.slug,
            filename: spotlightFilename(
                document?.filename ?? requestFilename,
                nonce,
            ),
        };
    };

    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
        nonce,
    );
    const messagesForLLM: ChatMessage[] = displayed_doc
        ? enrichedMessages.map((m, i) => {
              if (i !== enrichedMessages.length - 1 || m.role !== "user")
                  return m;
              const displayedDocument = documentPromptRef(
                  displayed_doc.document_id,
                  displayed_doc.filename,
              );
              return {
                  ...m,
                  content: `${m.content}\n\ndisplayed_doc: ${displayedDocument.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
              };
          })
        : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    // The matter's standing instructions — who we act for, what we are
    // trying to achieve, how this firm wants things done — go in ahead of the
    // per-turn detail, so they apply to answering and drafting alike.
    // What was just asked decides which remembered facts are worth sending,
    // on a matter that holds more than fit in every question.
    const caseContext = await loadProjectContext(
        db,
        projectId,
        lastUser?.content ?? "",
    );
    // Who is asking, and on whose behalf: the firm's details and the
    // attorney's own, so a letter can be signed properly instead of being
    // signed by nobody.
    const askerSection = await whoIsAskingSection(db, userId, userEmail);
    let systemPromptExtra =
        PROJECT_SYSTEM_PROMPT_EXTRA +
        askerSection +
        caseOverviewPromptSection(
            caseContext.overview,
            nonce,
            caseContext.memories,
            caseContext.omitted,
        );
    if (attached_documents?.length) {
        const lines = attached_documents.map((d) => {
            const document = documentPromptRef(d.document_id, d.filename);
            return document.slug
                ? `- ${document.slug}: ${document.filename}`
                : `- ${document.filename}`;
        });
        systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
    }

    const {
        api_keys: apiKeys,
        legal_research_us: legalResearchUs,
        title_model: titleModel,
    } = await getUserModelSettings(userId, db);

    // A paused turn is held in memory, so it does not survive a backend
    // restart. Say so plainly rather than silently starting from scratch.
    let resumeState = resume
        ? takeResumeState({ token: resume.token, userId, chatId })
        : null;
    if (resume && !resumeState) {
        return void res.status(409).json({
            detail: "This answer can no longer be continued. Ask the question again.",
        });
    }

    let apiMessages = buildMessages(
        messagesForLLM,
        docAvailability,
        systemPromptExtra,
        undefined,
        legalResearchUs,
        nonce,
    );

    // "Condense and keep going": swap the whole working transcript for a
    // written summary of it, then run on from there with room to spare.
    if (resumeState && resume?.condense) {
        try {
            const condensed = await condenseForContinuation({
                state: resumeState,
                apiKeys,
            });
            apiMessages = [apiMessages[0], ...condensed];
            resumeState = null;
        } catch (error) {
            console.error("[project-chat] failed to condense paused turn", error);
            return void res.status(500).json({
                detail: "Could not shorten this answer to continue it.",
            });
        }
    }
    const runModel = resumeState ? resumeState.model : model;

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);
    const streamAbort = new AbortController();
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) streamAbort.abort();
    });
    const stopHeartbeat = startSseHeartbeat(res);

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const shouldGenerateTitle =
            !chatTitle && !!lastUser?.content && !appendToPrevious;
        const titleMessage = lastUser
            ? [
                  lastUser.content,
                  lastUser.workflow
                      ? `Workflow: ${lastUser.workflow.title}`
                      : "",
                  lastUser.files?.length
                      ? `Files: ${lastUser.files.map((file) => file.filename).join(", ")}`
                      : "",
              ]
                  .filter(Boolean)
                  .join("\n")
            : "";
        const titlePromise = shouldGenerateTitle
            ? generateAssistantChatTitle({
                  model: titleModel,
                  message: titleMessage,
                  apiKeys,
              })
                  .then(async (title) => {
                      const { error } = await db
                          .from("chats")
                          .update({ title })
                          .eq("id", chatId);
                      if (error) throw error;
                      chatTitle = title;
                      if (!streamAbort.signal.aborted) {
                          write(
                              `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                          );
                      }
                  })
                  .catch((error) => {
                      console.error(
                          "[project-chat/stream] failed to generate chat title",
                          safeErrorLog(error),
                      );
                  })
            : Promise.resolve();

        const { events, citations } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            extraTools: PROJECT_EXTRA_TOOLS,
            workflowStore,
            includeResearchTools: legalResearchUs,
            model: runModel,
            apiKeys,
            signal: streamAbort.signal,
            projectId,
            nonce,
            chatId,
            resumeState,
            emitDone: false,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        if (appendToPrevious) {
            await appendAssistantEventsToLastAssistantMessage(
                db,
                chatId,
                persistedEvents,
                citations,
                "chat_messages",
                // The old "keep going" card has been acted on.
                resume ? ["paused"] : undefined,
            );
        } else {
            await db.from("chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: persistedEvents.length ? persistedEvents : null,
                citations: citations.length ? citations : null,
            });
        }

        await titlePromise;

        if (!chatTitle && lastUser?.content) {
            const title = lastUser.content.slice(0, 120);
            await db
                .from("chats")
                .update({ title })
                .eq("id", chatId);
            chatTitle = title;
            if (shouldGenerateTitle && !streamAbort.signal.aborted) {
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }

        void recordChatTurn(
            db,
            {
                userId,
                userEmail,
                chatId,
                projectId,
                title: chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                model,
            },
            persistedEvents,
        );

        // Look back over what was just said for anything worth remembering
        // about the case. This happens after the answer has gone out, so a
        // slow or failed suggestion never holds up a reply.
        void proposeMemoriesForTurn({
            db,
            projectId,
            userId,
            chatId,
            userMessage: lastUser?.content ?? "",
            assistantMessage: persistedEvents
                .filter((event) => event.type === "content")
                .map((event) => (event as { text: string }).text)
                .join("\n"),
            model: titleModel,
            apiKeys,
        });

        write("data: [DONE]\n\n");
    } catch (err) {
        if (isAbortError(err)) {
            console.log("[project-chat/stream] client aborted stream", {
                chatId,
            });
            if (err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText, events) =>
                        extractCitations(fullText, docIndex, events),
                });
                const saveError = appendToPrevious
                    ? null
                    : (
                          await db.from("chat_messages").insert({
                              chat_id: chatId,
                              role: "assistant",
                              content: partial.events.length
                                  ? partial.events
                                  : null,
                              citations: partial.citations.length
                                  ? partial.citations
                                  : null,
                          })
                      ).error;
                if (appendToPrevious) {
                    await appendAssistantEventsToLastAssistantMessage(
                        db,
                        chatId,
                        partial.events,
                        partial.citations,
                    );
                }
                if (saveError) {
                    console.error(
                        "[project-chat/stream] failed to save aborted stream",
                        saveError,
                    );
                }
            }
            return;
        }
        console.error("[project-chat/stream] error:", safeErrorLog(err));
        const message = safeErrorMessage(err, "Stream error");
        const errorEvents = err instanceof AssistantStreamError
            ? stripTransientAssistantEvents(err.events)
            : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        try {
            const citations = extractCitations(
                errorFullText,
                docIndex,
                errorEvents,
            );
            const saveError = appendToPrevious
                ? null
                : (
                      await db.from("chat_messages").insert({
                          chat_id: chatId,
                          role: "assistant",
                          content: errorEvents.length ? errorEvents : null,
                          citations: citations.length ? citations : null,
                      })
                  ).error;
            if (appendToPrevious) {
                await appendAssistantEventsToLastAssistantMessage(
                    db,
                    chatId,
                    errorEvents,
                    citations,
                );
            }
            if (saveError)
                console.error("[project-chat/stream] failed to save error", saveError);
        } catch (saveErr) {
            console.error("[project-chat/stream] failed to save error", saveErr);
        }
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        streamFinished = true;
        stopHeartbeat();
        res.end();
    }
});
