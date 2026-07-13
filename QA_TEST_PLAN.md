# DeepTutor Manual QA Test Plan

Covers every user-facing feature of the platform, including MCP (Model Context
Protocol) integration. Written to be run top-to-bottom by a human tester
against a running `web/` + backend instance. Each case has: **Precondition**,
**Steps**, **Expected result**. Check off `[ ]` as you go; note actual
behavior for anything that fails.

Legend: 🔴 = known regression hotspot (see §13) — pay extra attention here.

---

## 0. Setup

- [ ] Backend + `web/` dev server running, at least one admin user exists.
- [ ] Have ready: one small PDF, one image, one short DOCX, one CSV.
- [ ] Have an API key or local command available for at least one real MCP
      server to test with (e.g. a `stdio` server like `npx @modelcontextprotocol/server-filesystem <dir>`,
      or any remote `sse`/`streamableHttp` MCP endpoint you have access to).

---

## 1. Auth

- [ ] `/login` — valid credentials log in; invalid credentials show an error, no session created.
- [ ] `/register` — only reachable/enabled before any user exists (single-tenant mode); once a user exists, confirm register is hidden/disabled.
- [ ] Logout from `/profile` clears session and redirects to `/login`.

## 2. Home / Chat (`/home`)

- [ ] Default chat: ask a factual question → coherent answer, session appears in history sidebar.
- [ ] 🔴 Ask a solve/calculate/derive question in **default chat** (not Deep Solve), e.g. "solve x^2 - 5x + 6 = 0" → final answer **shows the method/steps**, not just the bare result. (Regression: this was previously too shallow; fixed 2026-07-09 in `agentic_chat.yaml`. If it regresses to answer-only, flag it.)
- [ ] Attach a document/notebook/KB/persona to the composer → attached context is used in the answer (ask a question only answerable from the attached doc).
- [ ] Quick Actions panel (sidebar) — each action fires and produces the expected effect.
- [ ] Switch capability tiles: Chat / Solve / Visualize / Research / Quiz / Mastery Path — each loads its distinct composer/UI.
- [ ] Session history: reopening an old session restores its messages; deleting a session removes it.
- [ ] `/playground` — run a capability config outside the normal chat flow; process/log panel shows step-by-step execution.

## 3. Deep Solve (`/home?capability=deep_solve`)

- [ ] Pose a multi-step math/logic problem → plan is shown, steps solved incrementally, final answer references the steps.
- [ ] Tool use (code execution, geogebra) is invoked when relevant and its output is incorporated.

## 4. Visualize (`/home?capability=visualize`)

- [ ] Ask for a diagram of a process (e.g. "visualize the water cycle") → correct output type chosen automatically (svg/chartjs/mermaid/html/manim) and renders without errors.
- [ ] Ask for a chart from data you provide → chartjs output with correct data mapping.
- [ ] Ask for an animation → manim video/image renders (allow extra time).
- [ ] 🔴 Voice-triggered visualize (see §11) is a known-fixed case — confirm it still works: say "visualize the water cycle" via voice → real visualize pipeline runs (not just a silent mode switch).

## 5. Deep Research (`/home?capability=deep_research`)

- [ ] Submit a research topic → rephrase step, then an editable outline/sub-topics list appears.
- [ ] Edit the outline before continuing → edits are respected in the generated report.
- [ ] Final report is produced iteratively (visible progress) and cites/uses sub-topic research.

## 6. Quiz / "Deep Question" (`/home?capability=deep_question`)

- [ ] Custom mode: request quiz on a topic → explore → plan → generates per-question, with correct answers/explanations.
- [ ] Mimic mode: upload a PDF quiz template → generated questions follow the template's format/style.
- [ ] Ask a single follow-up question after a quiz batch → generates one more question consistent with prior ones.
- [ ] Generated questions are saved and browsable at `/space/questions` (Question Bank).

## 7. Mastery Path (`/home?capability=mastery_path`, progress at `/space/learning`)

- [ ] Start a mastery path on a topic → status/quiz/grade/assess tools drive a gated tutoring loop (can't skip ahead without demonstrating mastery).
- [ ] Answer correctly several times → mastery score increases, path advances.
- [ ] Answer incorrectly → path does not falsely advance; remediation/repetition offered.
- [ ] Progress reflected correctly at `/space/learning`.
- [ ] 🔴 Voice-triggered mastery_path (see §11): same record-only gap that visualize had may still exist here — confirm whether saying "switch to mastery path and quiz me on X" actually runs the pipeline or just switches the UI silently. If silent, this is a known/expected gap, not a new bug — but worth confirming current status.

## 8. Book Generation (`/book`)

- [ ] Create a new book from a topic/prompt → ideation → spine/outline → per-page planning visible.
- [ ] Source exploration step pulls in relevant material (if sources attached).
- [ ] Generated pages include varied block types: text, quiz, flashcards, code, figure, concept-graph, timeline, callout, deep-dive, animation, interactive — verify at least one of each renders correctly.
- [ ] Page reader navigation and progress timeline work.
- [ ] Delete a book from the library → removed and not recoverable in UI.

## 9. Co-Writer (`/co-writer`, `/co-writer/[docId]`)

- [ ] Create a new document → opens rich text editor.
- [ ] Use the AI edit agent to revise a selection/section → edit applied correctly, original intent preserved.
- [ ] Delete a document from the list → removed.

## 10. Knowledge Base / RAG (`/knowledge`)

- [ ] Create a KB, upload PDF/DOCX/CSV → ingestion completes, documents listed.
- [ ] Change document-parsing engine in `/settings/document-parsing` (e.g. to MinerU) → re-ingest and confirm parsing engine actually changes output quality/structure.
- [ ] Ask a chat question that should be answered from the KB → correct grounded answer, not hallucinated.
- [ ] **Obsidian vault KB**: connect an Obsidian vault as a KB, select it in chat → chat runs *only* the 9 vault-editing tools (verify no unrelated tools fire); test at least one vault edit (create/update a note) end-to-end.
- [ ] **Subagent consultation KB**: with a local Claude Code/Codex session connected (`/settings/agents/claude-code` or `/codex`), select it as a source in chat → `consult_subagent` tool is invoked and its response is incorporated.

## 11. Voice (mic/voice button, sidebar `VoiceOrb` + home hero)

- [ ] Start a voice call → connects (WebRTC realtime), mic indicator active.
- [ ] Spoken Q&A: ask a question aloud → transcribed, routed through the same send path as typed text, answer streams back (and is spoken via TTS if enabled).
- [ ] Voice navigation: say "go to settings" / "open history" / "switch theme" → corresponding `navigate_to`/UI action fires via the MCP `call_tool` round-trip to `/api/v1/voice/execute-action`.
- [ ] 🔴 Voice capability switch with real content, e.g. "visualize the water cycle" → **actual visualize pipeline runs** (confirmed fixed 2026-07-10 — regression-test this specifically).
- [ ] 🔴 Voice capability switch with bare mode-switch phrasing, e.g. "switch to visualize mode" (no content) → UI switches mode **without** spuriously triggering generation.
- [ ] 🔴 Same two checks above for **quiz, research, solve, mastery_path** — as of last check these still only did a record-only mode switch (no real pipeline run) when reached via voice. Confirm current behavior; if still record-only, that's expected/known, not a new bug — but flag if it's inconsistent between capabilities.
- [ ] Filler utterances ("thanks", "ok", "mmhm") during a generation-only capability (visualize/quiz/research) do **not** trigger unwanted regeneration.
- [ ] End the call → cleans up, mic released, no lingering connection.

## 12. Partners (`/partners`, `/partners/new`, `/partners/[partnerId]`)

- [ ] Create a partner via the 5-step wizard: Identity → Soul → Mind → Library → Review.
  - [ ] Identity: name/description/face/language set correctly.
  - [ ] Soul: write persona text, or clone an existing Persona (`/space/personas`) into it.
  - [ ] Mind (Tool Picker): enable a mix of System tools, Built-in tools, and **MCP tools** (grouped by MCP server name) — confirm MCP tools only appear if a server is configured/enabled in `/settings/mcp` (§13).
  - [ ] Library: attach knowledge bases/skills/notebooks via the Asset Picker.
  - [ ] Review step: confirm summary matches selections before creating.
- [ ] Chat with the created partner → responds in character per its Soul, and can call only its enabled tools (test one enabled MCP tool call and one disabled tool to confirm the deny actually blocks it).
- [ ] `PartnerConfigure`: edit Identity/Soul/Model(primary+backup)/Library/Tools after creation → changes persist.
- [ ] Partner memory tools (`partner_read`/`partner_memorize`/`partner_search`) work without being explicitly enabled (always-on) — verify the partner remembers something across sessions.
- [ ] Channels tab: connect an IM channel (Feishu/Telegram/Slack if available) → partner reachable from that channel.
- [ ] Start/stop a partner session — stop actually halts activity, start resumes.

## 13. MCP Integration — Admin Settings (`/settings/mcp`)

This is the core MCP surface; test thoroughly since it's the platform's actual protocol integration point.

- [ ] Requires admin — confirm a non-admin user cannot reach `/settings/mcp` (or its API) at all.
- [ ] **Add a stdio MCP server**: name + command/args/env/cwd (e.g. `npx @modelcontextprotocol/server-filesystem /some/dir`) → save.
- [ ] **Test connection** before saving (`POST /api/v1/settings/mcp/test`) → discovers and lists the server's tools *without* persisting anything; cancel and confirm nothing was saved.
- [ ] **Save** (`PUT /api/v1/settings/mcp`) → server appears in the list with a live status badge: connected / connecting / error / disabled.
- [ ] **Add a remote MCP server** (`sse` or `streamableHttp` transport) with url + headers → same test/save/status flow.
- [ ] Deliberately misconfigure a server (bad command / unreachable url) → status badge shows **error**, with a legible error message, not a silent hang.
- [ ] **Enable/disable toggle** on a saved server → disabling immediately makes its tools unavailable to chat/partners; re-enabling restores them (no restart required, or confirm if a restart is actually needed).
- [ ] **Tool list expansion** for a server → shows discovered tools with names/descriptions.
- [ ] **`enabled_tools` whitelist**: restrict a server to a subset of its tools (not `*`) → only the whitelisted tools are selectable downstream in Partner Tool Picker / `/admin/users` grants / general chat tool surface; disabled ones are absent, not just greyed out.
- [ ] **Tool timeout** setting → a deliberately slow tool call is cut off at the configured timeout with a clear error, not an indefinite hang.
- [ ] **Edit** an existing server's config → changes take effect (re-test connection reflects the edit).
- [ ] **Delete** a server → its tools disappear from every downstream tool picker (partners, admin grants, general chat) immediately.
- [ ] End-to-end call: enable an MCP server + at least one tool, use it from a normal chat session (not a partner) → tool call succeeds and its result is used in the final answer.
- [ ] Restart the backend (if feasible in your environment) → previously-enabled MCP servers reconnect automatically on startup.

## 14. Multi-User / Admin Grants (`/admin/users`)

- [ ] Create a new non-admin user → can log in, has no admin-only access (`/settings/mcp`, `/admin/users` blocked).
- [ ] Open `GrantEditor` for that user → grant a specific LLM model profile, specific KBs, specific skills, an `enabled_tools` whitelist, and an `mcp_tools` whitelist.
- [ ] As the granted user, confirm only the granted models/KBs/skills/tools are visible/usable — everything not granted is inaccessible, not just hidden.
- [ ] Toggle `exec_enabled` off for a user → that user cannot trigger code execution even if a capability would otherwise offer it.
- [ ] Delete a user → their account and session are invalidated.
- [ ] Change a user's role (user ↔ admin) → access reflects immediately (may require re-login — note actual behavior).

## 15. Memory System (`/memory`, `/memory/l1..l3`, `/memory/graph`, `/memory/resolve`)

- [ ] `/memory` hub shows correct L2/L3 doc counts and backlog.
- [ ] `/memory/l1/[slot]` workbench: raw per-surface memory records (chat/notebook/quiz/kb/book/partner/cowriter) are visible and correctly attributed to their surface.
- [ ] `/memory/l2` and `/memory/l3`: consolidated memory reflects an actual consolidation pass — trigger one via `/settings/memory` (Update/Audit/Dedup rounds) and confirm new/changed L2/L3 entries.
- [ ] `/memory/graph` renders a navigable graph, not a static/broken image.
- [ ] `/memory/resolve?...` — paste an `m_<ULID>` citation id from a chat answer → correctly redirects to the owning surface/record.
- [ ] Adjust chunking/round settings in `/settings/memory` → next consolidation run respects the new settings (e.g. different chunk boundaries).

## 16. Settings — Service Configuration

For each, confirm: setting saves, persists after reload, and actually changes behavior (not just cosmetic).

- [ ] `/settings/llm` — switch default LLM provider/model → next chat response reflects the new model (check response metadata/logs if visible).
- [ ] `/settings/embedding` — change embedding model → re-index a KB and confirm new embeddings are used (or that a re-index is prompted).
- [ ] `/settings/search` — configure web search provider → a research/chat query that needs web search actually calls it.
- [ ] `/settings/image`, `/settings/video` — configure image/video gen provider → a visualize/book request using that modality succeeds.
- [ ] `/settings/stt`, `/settings/tts` — change speech provider → voice call uses new provider (listen for a difference, or check network calls).
- [ ] `/settings/document-parsing` — see §10.
- [ ] `/settings/capabilities` — change a capability's LLM params/stage budget → next run of that capability reflects it (e.g. lower budget = fewer steps).
- [ ] `/settings/tools` — toggle a user-controllable tool off → it's no longer callable in chat.
- [ ] `/settings/appearance` — theme + language switch apply immediately app-wide, including newly-opened pages.
- [ ] `/settings/network` — change chat response timeout → a deliberately slow response is cut off at the new threshold.
- [ ] `/settings/agents/claude-code`, `/settings/agents/codex` — configure connection → shows connected status; feeds `/agents` hub and Subagent capability (§10).
- [ ] Deprecated redirects `/settings/mineru` → `/settings/document-parsing`, `/settings/status` → `/settings` — confirm redirect works, not a 404.

## 17. Space (`/space` and sub-pages)

- [ ] `/space` overview tiles show correct live counts (notebooks, questions, chat history, etc.) — cross-check one count against its actual sub-page.
- [ ] `/space/notebooks` — list/categories/bookmarks correct.
- [ ] `/space/questions` — Question Bank shows quiz-generated questions from §6.
- [ ] `/space/chat-history` — archive is complete and each entry is attachable as an explore-context source in chat.
- [ ] `/space/learning` — mastery progress from §7 shown accurately.
- [ ] `/space/personas` — create/edit a persona; confirm it's selectable when creating a Partner (§12).
- [ ] `/space/skills` — builtin skills (docx/pdf/pptx/xlsx, skill-creator) listed; test skill-creator produces a usable new skill.

## 18. Agents Hub (`/agents`)

- [ ] Live connected Claude Code/Codex sessions shown with correct status.
- [ ] Imported agent-history replay works for a past session.

## 19. i18n

- [ ] Switch language en ↔ zh in `/settings/appearance` → UI strings and (where applicable) generated content prompts switch language; spot-check the chat prompt behavior in §2 in zh too, since `agentic_chat.yaml` has separate en/zh files that must stay in sync.

## 20. Cross-cutting / Regression Watchlist

Known-sensitive areas from recent work — check these specifically even if not filing a new bug:

1. 🔴 **Default chat "show work"** (§2) — solve/calc/derive questions must show method, in both en and zh prompt variants.
2. 🔴 **Voice `switch_capability` real-execution gap** (§4, §7, §11) — confirmed fixed for `visualize` (2026-07-10); confirm it hasn't regressed, and note current status for quiz/research/solve/mastery_path (same gap pattern, may still be open).
3. **MCP tool whitelist enforcement** (§13, §14) — a tool excluded via `enabled_tools`/grants must be actually unreachable, not just hidden from the picker UI (test by attempting the call path, not just checking the UI list).
4. **Obsidian/Subagent exclusivity** (§10) — confirm no unrelated tools leak in when one of these special KB modes is active.

---

## Reporting

For each failed case, record: route, exact steps, expected vs. actual, and
whether it reproduces consistently. File against the relevant backend module
noted in parentheses above (e.g. `deeptutor/services/mcp/manager.py`,
`deeptutor/agents/chat/prompts/`, `web/context/VoiceCallContext.tsx`).
