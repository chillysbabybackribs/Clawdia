# Autonomy Mode and Approvals

Clawdia supports different levels of autonomy for tool execution, ranging from full confirmation for every action to unrestricted execution.

## Autonomy Modes

| Mode | Description |
| --- | --- |
| **Guided** | The default mode. High-risk actions (filesystem write, shell execution, exfiltration) require approval. |
| **Safe** | More restrictive. Most actions require approval. |
| **Unrestricted** | No guardrails. All actions execute without confirmation. Requires hold-to-confirm to enable. |

## Approval Flow

When an action requires approval, Clawdia triggers an approval request. This request is sent to:
1.  **Desktop UI**: An inline approval panel appears in the chat.
2.  **Telegram Bot** (if enabled): A notification with inline buttons is sent to the authorized Telegram chat.

### Available Actions

*   **Approve once**: Authorizes only the current tool execution.
*   **For this task**: Authorizes the current tool for the duration of the current task.
*   **Always approve**: Adds a global override to always allow this specific tool/risk combination.
*   **Deny**: Rejects the execution.

### Precedence: "First Decision Wins"

Approvals are deterministic and follow a "first decision wins" rule. Once a decision is made on either the Desktop UI or Telegram, the request is resolved, and the other channel is neutralized.

### Expiration and Security

*   **Timeout**: Approval requests expire after 90 seconds. If no decision is made, the action is automatically denied.
*   **Rate Limiting**: Telegram callback actions are rate-limited to prevent accidental or malicious double-clicks.
*   **Authorization**: Telegram approvals are only accepted from the authorized Chat ID configured in settings.

## Managing "Always Approve" Rules

You can view and remove global "Always approve" overrides from the Autonomy Mode popover in the desktop application:
1.  Click the Autonomy Mode label (e.g., "Guided") in the input bar.
2.  Select **Manage approvals**.
3.  Remove any rules you no longer wish to persist.
