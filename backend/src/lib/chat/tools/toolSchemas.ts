export const PROJECT_EXTRA_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_matter",
      description:
        "Search every document in this matter by keyword and return the passages that match, each with its document and page. Use this to find where something is discussed across many documents — 'which files mention the summons', 'where is the indemnity clause', 'any reference to the March inspection' — without knowing which document holds it or reading them all. Matching understands word stems and tolerates the character errors that scanned documents carry. Cite the document and page from the result; open a document with read_document when you need its full text.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to look for — a word, a name, a phrase, or a short description of the idea.",
          },
          limit: {
            type: "number",
            description:
              "Most passages to return (default 20, maximum 100).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_documents",
      description:
        "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once. In one response, fetch each document/version at most once; after it has been fetched, use the prior tool result or find_in_document for targeted checks.",
      parameters: {
        type: "object",
        properties: {
          doc_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
          },
        },
        required: ["doc_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_to_law",
      description:
        "File one or more legal sources — cases retrieved from CourtListener, or statutes retrieved with a statute tool — into this matter's documents as permanent, viewable files. By default they land in the matter's \"Law\" folder; give folder to file them somewhere else (created if it does not exist). Use whenever the user asks to save, file, keep or add case law or statutes to the matter, its law bank or library, or a named folder. A case must have been fetched or verified in this conversation so its cluster id is known; a statute must have been retrieved this conversation or cited earlier in this chat.",
      parameters: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            description:
              "The sources to file, one entry per case or statute.",
            items: {
              type: "object",
              properties: {
                cluster_id: {
                  type: "integer",
                  description:
                    "CourtListener cluster id of a case, from courtlistener_verify_citations or courtlistener_get_cases results in this conversation.",
                },
                statute: {
                  type: "string",
                  description:
                    'A statute citation exactly as the statute tool\'s result labels it, e.g. "K.S.A. 58-2540".',
                },
              },
            },
          },
          folder: {
            type: "string",
            description:
              'Folder to file the documents in, by name. Omit for the matter\'s "Law" folder.',
          },
        },
        required: ["sources"],
      },
    },
  },
];

export const TABULAR_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_table_cells",
      description:
        "Read the extracted cell content from the tabular review. Each cell contains the value extracted for a specific column from a specific document. Pass col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or all rows.",
      parameters: {
        type: "object",
        properties: {
          col_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based column indices to read (e.g. [0, 2]). Omit to read all columns.",
          },
          row_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based document (row) indices to read (e.g. [0, 1]). Omit to read all rows.",
          },
        },
      },
    },
  },
];

export const WORKFLOW_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_workflows",
      description:
        "List all workflows available to the user. Returns each workflow's ID and title. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_workflow",
      description:
        "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "The workflow ID to read",
          },
        },
        required: ["workflow_id"],
      },
    },
  },
];

// The firm's own model documents. The list of what the firm banks is already
// in the system prompt; these are for comparing the versions of one kind of
// document and opening the one that fits.
export const FORM_BANK_TOOLS = [
  {
    type: "function",
    function: {
      name: "open_firm_form",
      description:
        "Work with the firm's banked model documents. Give a document_type to get the notes on every version the firm keeps of that kind of document, without opening any of them — that is how you compare them and choose. Give a form_id to open one: its document becomes available in this chat as a Library Template, and its notes come back with it, including the firm's drafting guidance and, for a fill-in form, the blanks to fill. Copy the opened document with replicate_document before changing anything.",
      parameters: {
        type: "object",
        properties: {
          form_id: {
            type: "string",
            description:
              "The id of one banked entry, as shown in the firm's form bank list.",
          },
          document_type: {
            type: "string",
            description:
              "The kind of document, as shown in the firm's form bank list (for example 'operating-agreement'). Returns the notes on every version, opening none.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_firm_form",
      description:
        "Search the firm's banked model documents by a few words — the kind of document, the situation it covers, the practice area. Returns matching entries' notes without opening any document. Use this when the firm's form bank list in your instructions says it is not the whole bank.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A few words describing the document you are looking for.",
          },
        },
        required: ["query"],
      },
    },
  },
];

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_tabular_review",
      description:
        "Read a grid (tabular review) belonging to this matter: its columns, its rows and every filled-in cell, together with the citations behind each answer. Call it with no arguments to list the grids on this matter, then again with a review_id to read one. Use this instead of re-reading every source document when the figures you need have already been pulled into a grid, and carry its citations through into your answer.",
      parameters: {
        type: "object",
        properties: {
          review_id: {
            type: "string",
            description:
              "The grid to read. Omit to list the grids available on this matter.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replicate_document",
      description:
        "Copy an available document, Library Template, or workflow asset without changing the source. In a project chat, copies are saved to Project Documents; otherwise they are saved to Library Files. Always use this before editing or drafting from a Library Template or workflow asset. For an ordinary document, use it when the user asks for a copy/duplicate, when they ask for a new document based on that file, and whenever you are asked to draft a new document of the same kind as one that is already available - copying and then editing the copy is the only way to keep the original document's fonts, margins, spacing and layout. A PDF source is copied as a fresh, fully editable .docx built from its text: the wording carries over, the PDF's visual layout is approximated — the result says so, and the copy should be restyled with write_document where the look matters. Returns new doc_id slugs for read_document and edit_document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description:
              "Chat-local ID of the source document, Library Template, or workflow asset.",
          },
          count: {
            type: "integer",
            description:
              "How many copies to create. Defaults to 1. Maximum 20.",
            minimum: 1,
            maximum: 20,
          },
          new_filename: {
            type: "string",
            description:
              "New base filename. Required for Library Templates and workflow assets. With count > 1, copies are numbered. The extension is forced to match the source.",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_inputs",
      description:
        "Ask the user for one or more decisions, clarifications, or document uploads before continuing. Use this when guessing would materially affect the answer or when required documents have not been attached. Put all needed questions and document requests in one items array. After calling ask_inputs, do not continue the substantive task until the user responds in a later message.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description:
              "The list of user inputs needed before continuing. Use choice items for decisions/clarifications and documents items for required uploads.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable short ID for this input, unique within this tool call.",
                },
                kind: {
                  type: "string",
                  enum: ["choice", "documents"],
                },
                question: {
                  type: "string",
                  description:
                    "For choice items only: the concise question to show to the user.",
                },
                options: {
                  type: "array",
                  description:
                    "For choice items only: selectable choices to show. Each choice has a single user-facing value, which is also sent back if selected.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      value: {
                        type: "string",
                        description: "The user-facing choice text.",
                      },
                    },
                    required: ["value"],
                  },
                },
                allow_other: {
                  type: "boolean",
                  description:
                    "For choice items only: whether to show an Other option with a text field. Defaults to true.",
                },
                other_label: {
                  type: "string",
                  description:
                    "For choice items only: label for the free-text option. Defaults to Other.",
                },
                document_types: {
                  type: "array",
                  description:
                    "For documents items only: readable labels for the types of documents you need the user to attach.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "string",
                  },
                },
                response_prefix: {
                  type: "string",
                  description:
                    "Optional prefix the UI should include when sending this response back as the next message.",
                },
              },
              required: ["id", "kind"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read the full text content of an available document. Always call this before answering questions about, summarising, citing from, or editing a document, but call it at most once per document/version in a single response. After this returns, use the prior tool result or find_in_document for targeted checks instead of reading the same document/version again.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description:
              "The document ID to read (e.g. 'doc-0', 'doc-1', or 'active-word-document')",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_in_document",
      description:
        "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to search (e.g. 'doc-0').",
          },
          query: {
            type: "string",
            description:
              "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
          },
          max_results: {
            type: "integer",
            description:
              "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
          },
          context_chars: {
            type: "integer",
            description:
              "Characters of surrounding context to include on each side of a match (default 80).",
          },
        },
        required: ["doc_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_docx",
      description:
        "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document AND no existing .docx of the same kind is available to copy. This tool renders with its own fixed fonts, spacing and numbering, so it cannot reproduce the appearance of a document the user has supplied; when such a document exists, call replicate_document and then edit_document instead. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Document title (used as filename and heading)",
          },
          landscape: {
            type: "boolean",
            description:
              "Set to true for landscape page orientation. Default is portrait.",
          },
          style: {
            type: "object",
            description:
              "Page-wide appearance. Omit it for a contract or agreement and the long-standing contract look is used: Times New Roman 11pt, single spaced, an all-caps centred title and automatic clause numbering. Set it for anything that is not a contract - a certificate of service, notice, motion, letter, affidavit - so the page matches the court's or the firm's requirements.",
            properties: {
              font: {
                type: "string",
                description:
                  "Typeface name, e.g. 'Times New Roman', 'Century Schoolbook', 'Arial'. Defaults to Times New Roman.",
              },
              fontSize: {
                type: "number",
                description:
                  "Body text size in points. Defaults to 11. Courts usually require 12.",
              },
              lineSpacing: {
                type: "string",
                enum: ["single", "1.5", "double"],
                description:
                  "Line spacing for the whole document. Defaults to single.",
              },
              margins: {
                type: "object",
                description:
                  "Page margins in inches. Defaults to Word's own 1 inch.",
                properties: {
                  top: { type: "number" },
                  bottom: { type: "number" },
                  left: { type: "number" },
                  right: { type: "number" },
                },
              },
              pageNumbers: {
                type: "boolean",
                description:
                  "Set to true to centre a page number in the footer.",
              },
              numbering: {
                type: "string",
                enum: ["legal", "none"],
                description:
                  "'legal' (the default) applies automatic 1., 1.1, (a) clause numbering to headings and paragraphs and puts the title in capitals - correct for contracts, wrong for everything else. Set 'none' for any other document: nothing is numbered or capitalised automatically, blank lines you write are kept, and you control numbering by typing it yourself.",
              },
              showTitle: {
                type: "boolean",
                description:
                  "Set to false to leave the title out of the page (it is still used as the filename). Use this when the document's own first lines are the heading, such as a court caption.",
              },
              titleAlign: {
                type: "string",
                enum: ["left", "center", "right", "justify"],
                description: "Title alignment. Defaults to centred.",
              },
            },
          },
          sections: {
            type: "array",
            description:
              "List of document sections. Each section may contain a heading, prose content, or a table.",
            items: {
              type: "object",
              properties: {
                heading: {
                  type: "string",
                  description: "Optional section heading",
                },
                level: {
                  type: "integer",
                  description: "Heading level: 1, 2, or 3",
                },
                content: {
                  type: "string",
                  description:
                    "Prose text content. Each line becomes its own paragraph. Within a line, **text** is bold, _text_ is underlined and *text* is italic, and a tab character moves to the next tab stop (3.5 inches, then the right margin) - that is how a signature line, a 'Dated: ______' line or a two-column line is set out. With style.numbering set to 'none', blank lines you write are kept as blank lines.",
                },
                pageBreak: {
                  type: "boolean",
                  description:
                    "Set to true to start this section on a new page. Use for contract signature pages.",
                },
                format: {
                  type: "object",
                  description:
                    "How this section's lines sit on the page. Use it for centred headings, right-hand or indented signature blocks, block quotes and 'Dated:' lines.",
                  properties: {
                    align: {
                      type: "string",
                      enum: ["left", "center", "right", "justify"],
                      description: "Alignment for this section's lines.",
                    },
                    indent: {
                      type: "number",
                      description:
                        "Left indent in inches for this section. A signature block is usually indented 3.5 inches.",
                    },
                    firstLineIndent: {
                      type: "number",
                      description:
                        "First-line indent in inches for each paragraph in this section, e.g. 0.5.",
                    },
                    spaceAfter: {
                      type: "number",
                      description:
                        "Space after each line of this section, in points.",
                    },
                    bold: { type: "boolean" },
                    italic: { type: "boolean" },
                    underline: { type: "boolean" },
                  },
                },
                table: {
                  type: "object",
                  description: "Optional table to render in this section",
                  properties: {
                    headers: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Column header labels. With headerRow false these are just the first row's cells.",
                    },
                    borders: {
                      type: "boolean",
                      description:
                        "Set to false to draw the table with no rules. A court caption block and a two-column signature block are borderless tables.",
                    },
                    headerRow: {
                      type: "boolean",
                      description:
                        "Set to false when the first row is ordinary content rather than column headings, so it is not shaded or bolded.",
                    },
                    widths: {
                      type: "array",
                      items: { type: "number" },
                      description:
                        "Column widths as percentages of the page width, one per column, e.g. [55, 45].",
                    },
                    rows: {
                      type: "array",
                      items: {
                        type: "array",
                        items: { type: "string" },
                      },
                      description:
                        "Array of rows, each row is an array of cell strings matching the headers order",
                    },
                  },
                  required: ["headers", "rows"],
                },
              },
            },
          },
        },
        required: ["title", "sections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_excel",
      description:
        "Generate an Excel (.xlsx) workbook from structured sheet data. Use this when the user asks for a spreadsheet, tracker, matrix, checklist, schedule, or Excel file. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Workbook title, used as the filename.",
          },
          sheets: {
            type: "array",
            description:
              "Workbook sheets. Each sheet has a name, columns, and rows. Row values should follow the columns order.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Sheet tab name. Keep it short.",
                },
                columns: {
                  type: "array",
                  items: { type: "string" },
                  description: "Column header labels.",
                },
                rows: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: "string" },
                  },
                  description:
                    "Array of rows, each row an array of cell strings matching the columns order.",
                },
              },
              required: ["name", "columns", "rows"],
            },
          },
        },
        required: ["title", "sheets"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_ppt",
      description:
        "Generate a PowerPoint (.pptx) presentation from structured slides. Use this when the user asks for slides, a deck, presentation, or PowerPoint file. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Presentation title, used as the filename.",
          },
          slides: {
            type: "array",
            description:
              "Slides in order. Each slide may have a title, bullets, and optional speaker notes.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Slide title.",
                },
                bullets: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Main bullet points for the slide. Keep each bullet concise.",
                },
                notes: {
                  type: "string",
                  description:
                    "Optional speaker notes. Included as text on a notes slide placeholder is not supported; use only for generation context.",
                },
              },
              required: ["title", "bullets"],
            },
          },
        },
        required: ["title", "slides"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_document",
      description:
        "Write a .docx document's whole body in one call, keeping the file's own look. This is how you fill in a copy made with replicate_document, and how you make sweeping changes to a document that already exists (set track_changes for that): send the finished document as a list of paragraphs and it replaces what is there, so a contract adapted for a new client takes ONE call instead of dozens of find-and-replace edits that stop matching as soon as the wording changes. You may add provisions the original did not have and drop ones it does not need — a paragraph you add between numbered clauses is numbered with them. Each paragraph is matched against the paragraph in the same position, so fonts, margins, line spacing, numbering, indentation, tables and the signature layout carry over from the document being copied. Read the source document first and send back every paragraph the new document needs, in order, with the old party names, dates and trade-specific wording replaced. Paragraphs you send unchanged stay byte-identical. Use edit_document instead for a small correction to a document that is otherwise already right.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "Document slug (e.g. 'doc-0').",
          },
          paragraphs: {
            type: "array",
            description:
              "The complete new document, one entry per paragraph, in order — including headings, clause text, exhibit text and signature lines. Anything left out is deleted from the document. A plain string is a paragraph that keeps the look of the one it replaces, which is what you want for a rewritten clause. Use the object form only where that is not right: for a paragraph you are ADDING whose neighbours look different, or to add a table. Inside a line, write **text** for bold, _text_ for underline and *text* for italic, and a tab character to move to the next tab stop. A line may also OPEN with [page break], [heading 1-3], [centered], or [right] — the same layout tokens the document text you read shows — and [fn N] anywhere in a line keeps that footnote's reference mark at that spot, while [fn new: note text] creates a brand-new numbered footnote there. Keep the markers and tokens at the corresponding places when you rewrite a paragraph, or its emphasis, layout and footnotes are lost; do not add ones the source does not have unless you mean to change the look.",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    text: {
                      type: "string",
                      description: "The paragraph's words.",
                    },
                    style: {
                      type: "string",
                      enum: ["heading1", "heading2", "heading3", "none"],
                      description:
                        "Make this a heading, or 'none' for ordinary text. Leave it out to keep the style of the paragraph being replaced.",
                    },
                    list: {
                      type: "string",
                      enum: ["number", "bullet", "none"],
                      description:
                        "Make this a numbered clause or a bullet, or 'none' for an ordinary paragraph — use 'none' for something like a signature line that must not pick up clause numbering. Leave it out to keep what the paragraph being replaced had.",
                    },
                    align: {
                      type: "string",
                      enum: ["left", "center", "right", "justify"],
                      description:
                        "Leave it out to keep the alignment of the paragraph being replaced.",
                    },
                    page_break: {
                      type: "boolean",
                      description:
                        "true starts this paragraph on a fresh page — for a new exhibit or a signature page.",
                    },
                    table: {
                      type: "object",
                      description:
                        "Put a table here instead of a paragraph. Use this to add a table the original document did not have, such as a new exhibit's price grid. Tables already in the document are kept automatically; write their cell text as ordinary paragraphs in the order it appears.",
                      properties: {
                        rows: {
                          type: "array",
                          description:
                            "Rows of cell text, first row first. Every row should have the same number of cells.",
                          items: {
                            type: "array",
                            items: { type: "string" },
                          },
                        },
                        borders: {
                          type: "boolean",
                          description:
                            "false for a borderless table (a caption block or a signature grid). Defaults to true.",
                        },
                        widths: {
                          type: "array",
                          description:
                            "Relative column widths, one per column. Defaults to equal columns.",
                          items: { type: "number" },
                        },
                      },
                      required: ["rows"],
                    },
                  },
                },
              ],
            },
          },
          track_changes: {
            type: "boolean",
            description:
              "true rewrites the document as tracked changes for the user to accept or reject one by one — use it when they asked you to revise a document they already have and want to see what changed. Inline markers keep their formatting, and a NEW table lands as one reviewable insertion with its own card (a table whose cells the document already contains is left alone). Leave it out when filling in a fresh copy: a new document has nothing to review.",
          },
        },
        required: ["doc_id", "paragraphs"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_document",
      description:
        "Write edits into a .docx. On a document the user already has, the edits land as tracked changes for them to accept or reject; on a fresh copy made with replicate_document they are written straight in, because a copy being filled in is a new document rather than a marked-up old one (see track_changes). Use read_document first unless this same document/version has already been read in the current response. Anchor each edit with short before/after context so it can be located unambiguously. When revising a document the user already has, keep each edit a precise, minimal substitution of specific words/characters rather than a whole-line rewrite. When filling in a fresh copy, work the other way: replace a whole clause or paragraph in one edit, so a rewrite takes a handful of edits rather than dozens. You can also write new body text: a blank line in `replace` starts a new paragraph, so one edit can turn a placeholder into several paragraphs, and an edit with an empty `find` inserts new paragraphs at the anchor. To remove a paragraph completely, set `find` to its full text and `replace` to an empty string — the blank line goes too. New paragraphs inherit the formatting of the paragraph they grow out of, and **bold**/_underline_/*italic* markers in `replace` become real formatting on the inserted words. The page header and footer (shown under '--- Page header ---' when reading) and footnote text (under '--- Footnotes ---') are editable too: an edit whose anchor matches text there is applied in place directly, not as a tracked change, with logos and layout preserved. Returns a download link to the edited document, plus per-edit annotations the UI renders as Accept/Reject cards when the edits are tracked.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "Document slug (e.g. 'doc-0').",
          },
          track_changes: {
            type: "boolean",
            description:
              "Whether the edits need the user's review. Leave it out and the right thing happens by default: a copy made with replicate_document that has not been edited yet has the changes written straight into it, and any other document gets tracked changes. Set it to false to write changes straight in — do that when the user asked for a new document rather than a review of this one. Set it to true to force tracked changes on a fresh copy.",
          },
          edits: {
            type: "array",
            description: "List of precise substitutions.",
            items: {
              type: "object",
              properties: {
                find: {
                  type: "string",
                  description:
                    "Exact substring to replace. When revising existing wording, keep it as short as possible — ideally just the words/chars being changed. Use the paragraph's full text to replace or remove the whole paragraph, or an empty string to insert new text at the anchor. The **bold**/_underline_/*italic* markers shown by read_document are not part of the document's characters; anchors work with or without them.",
                },
                replace: {
                  type: "string",
                  description:
                    "Replacement text. Empty string = pure deletion. A blank line (\\n\\n) starts a new paragraph; a single newline is a line break within the same paragraph. **bold**/_underline_/*italic* become formatting, [fn N] keeps an existing footnote's mark, and [fn new: note text] creates a brand-new numbered footnote at that spot.",
                },
                context_before: {
                  type: "string",
                  description:
                    "~40 chars immediately preceding `find`, used to disambiguate.",
                },
                context_after: {
                  type: "string",
                  description: "~40 chars immediately following `find`.",
                },
                reason: {
                  type: "string",
                  description:
                    "Short explanation shown to the user on the card.",
                },
              },
              required: ["find", "replace", "context_before", "context_after"],
            },
          },
        },
        required: ["doc_id", "edits"],
      },
    },
  },
];
