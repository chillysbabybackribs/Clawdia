
# Vault & Action Ledger Test Prompts

Use these prompts to verify the new functionality.

## 1. File Ingestion
**Goal:** Verify that the system can read a local file, extract its content, chunk it, and index it into the Vault.
**Prompt:**
> "Please digest the file at `/home/dp/Desktop/clawdia/docs/audits/CODEX_AUDIT.md` so I can ask questions about it later."

**Expected Behavior:**
1.  The agent should use the `vault_ingest` tool with the absolute path.
2.  The UI header should briefly show an "Ingesting..." status with a spinner/icon.
3.  The tool output should return a Document ID.
4.  The agent should confirm success.

---

## 2. Vault Search (Knowledge Retrieval)
**Goal:** Verify that the system can retrieve information from the Vault using semantic/keyword search.
**Prerequisite:** You must have ingested `docs/audits/CODEX_AUDIT.md` (or another file) first.
**Prompt:**
> "What does the audit say about the current state of the architecture?"

**Expected Behavior:**
1.  The agent should use the `vault_search` tool with a query like "audit architecture state".
2.  The tool output should contain relevant chunks from the file.
3.  The agent should synthesize an answer based *only* on the search results.

---

## 3. Action Plan & Execution (Reversible Actions)
**Goal:** Verify that the agent can create a multi-step plan, execute it transactionally, and that the UI affords an Undo capability.
**Prompt:**
> "Create a new file called `deployment_notes.txt` on my Desktop with a checklist for launch, then create a backup directory called `backups`."

**Expected Behavior:**
1.  **Planning:** The agent should use `action_create_plan` followed by `action_add_item` (twice: one `fs_write`, one `fs_move` or `fs_write` depending on interpretation, or just `fs_write` if it strictly follows instructions).
2.  **Execution:** The agent should call `action_execute_plan`.
3.  **UI Feedback:**
    *   The "Tool Activity" panel should show the plan execution steps.
    *   **CRITICAL:** A small "Undo" button should appear next to the `action_execute_plan` entry in the activity feed.
4.  **Verification:** The file `deployment_notes.txt` and folder `backups` should exist on your Desktop.

---

## 4. Undo Functionality
**Goal:** Verify that the "Undo" button actually reverses the file operations.
**Prerequisite:** Complete Test #3.
**Action:**
> Click the "Undo" button in the Tool Activity panel next to the `execute_plan` step.

**Expected Behavior:**
1.  The button text should change to "Undoing..." then "Undone".
2.  The `deployment_notes.txt` file and `backups` directory should disappear from your Desktop.
3.  In the terminal/logs, you should see `action_undo_plan` being called.

---

## 5. Complex Reasoning + Vault
**Goal:** Verify the agent can combine "Sequential Thinking" with Vault data.
**Prompt:**
> "Based on the patterns you see in the CODEX_AUDIT file, suggest 3 critical refactors we should prioritize next week."

**Expected Behavior:**
1.  Agent uses `vault_search` to recall the file content.
2.  Agent uses `sequential_thinking` to analyze the findings.
3.  Agent produces a synthesized list of recommendations.
