# Enhanced Activity Feed Implementation

## Overview

This document describes the enhanced command pipeline UI that improves upon the existing activity feed with structured output, step grouping, approval integration, and actionable error cards.

## Architecture

The enhanced activity feed **extends** (not replaces) the current streaming log architecture. It preserves full transparency while adding structure and actionable feedback.

## Key Components

### 1. Pipeline State Header

Located at the top of the activity feed, displays:
- **Pipeline Status**: Running / Succeeded / Failed / Blocked
- **Step Progress**: Step X/Y (dynamically updated)
- **Status Icon**: Visual indicator (⚡ running, ✓ success, ✗ failed, ⏸ blocked)

The header changes color based on state:
- Running: teal accent
- Success: green
- Failed: red
- Blocked: amber (approval pending)

### 2. Step Grouping by Phase

Steps are automatically grouped into logical phases based on tool name and command patterns:

**Detected Phases:**
- `staging`: git add commands
- `commit`: git commit commands
- `tag`: git tag commands
- `push`: git push commands
- `deploy`: vercel commands
- `build`: npm build commands
- `test`: npm test commands
- `browser`: browser_* tool calls
- `files`: file_write, file_edit
- `general`: everything else

**Phase Behavior:**
- Each phase has a collapsible header showing status
- Only current phase expanded by default
- Previous phases auto-collapse when new phase starts
- Phase status derived from contained steps

### 3. Approval Integration

When an approval request is received:
1. Current step marked as `blocked`
2. Pipeline status becomes `blocked`
3. Phase header shows: "Awaiting approval (ELEVATED/EXFIL/etc.)"
4. Approval decision logged inline: "✓ Approved (Approve once)" or "❌ Denied by user"

**Event Flow:**
- `onApprovalRequest` → `setApprovalBlocked()`
- User clicks approval button → `approval-panel.ts` emits `clawdia:approval:resolved` event
- `approvalResolved()` updates pipeline state and logs decision

### 4. Action Required Cards

Lightweight pattern detection on stderr output triggers actionable cards:

**Detected Patterns:**
- Vercel login/token expired → "Login to Vercel" button
- Git authentication failure → "Configure Git" button
- Tag already exists → "Delete tag" button
- No git remote → "View remotes" button
- Permission denied (sudo) → Information only

**Card Structure:**
```
⚠️ [Title]
[Description]
[Primary Action] [Secondary Action] [✕ Dismiss]
```

Cards appear **above** the log panel and don't interrupt streaming.

### 5. Normal vs Verbose Toggle

**Normal Mode (default):**
- Hides internal debug tools: `sequential_thinking`, `vault_search`, `vault_ingest`, `directory_tree`
- Filters noise: IPC validation traces, file replacement logs, type exports
- Always shows: tool name, executed command, stderr, status, durations

**Verbose Mode:**
- Shows raw unfiltered stream
- Useful for debugging

Toggle button in top-right of feed footer.

## File Structure

### New Files

```
src/renderer/modules/enhanced-activity-feed.ts  (815 lines)
└─ Main implementation
   ├─ EnhancedActivityFeed class
   ├─ Phase detection logic
   ├─ Error pattern matching
   ├─ IPC event handlers
   └─ Export functions
```

### Modified Files

```
src/renderer/modules/chat.ts
├─ Import startEnhancedActivityFeed
└─ Replace startActivityFeed() with startEnhancedActivityFeed()

src/renderer/modules/approval-panel.ts
└─ Emit 'clawdia:approval:resolved' event in handleDecision()

src/renderer/main.ts
├─ Import initEnhancedActivityFeed
└─ Call initEnhancedActivityFeed() in init()

src/renderer/styles.css
└─ Add ~350 lines of CSS for:
   ├─ Pipeline header (.pipeline-header-*)
   ├─ Action cards (.action-required-*)
   ├─ Pipeline phases (.pipeline-phase-*)
   ├─ Verbose toggle (.verbose-toggle)
   └─ Blocked state (.activity-feed__step--blocked)
```

## Logic Flows

### Step Addition Flow

```
1. IPC: TOOL_EXEC_START event
2. onToolExecStart() callback
3. addStep(toolId, toolName, args)
   ├─ Detect phase via detectPhase()
   ├─ Get or create PipelinePhase
   ├─ Collapse previous phase if different
   ├─ Create step row DOM
   ├─ Add to phase content
   ├─ Update phase status
   └─ Update pipeline header
```

### Step Completion Flow

```
1. IPC: TOOL_EXEC_COMPLETE event
2. onToolExecComplete() callback
3. updateStep(toolId, status, duration, summary, stderr)
   ├─ Update step DOM (icon, duration, status classes)
   ├─ Check stderr for error patterns
   ├─ If pattern matched → addActionRequiredCard()
   ├─ If executable plan → add Undo button
   ├─ Update phase status
   ├─ Update pipeline header
   └─ Apply normal/verbose visibility
```

### Approval Flow

```
1. IPC: APPROVAL_REQUEST event
2. onApprovalRequest() callback
3. setApprovalBlocked(request)
   ├─ Store currentApprovalRequest
   ├─ Set pipelineStatus = 'blocked'
   ├─ Mark affected step as blocked
   ├─ Update phase status
   └─ Update pipeline header

[User clicks approval button in approval-panel]

4. approval-panel.ts emits 'clawdia:approval:resolved'
5. approvalResolved(decision)
   ├─ Clear currentApprovalRequest
   ├─ Log decision inline
   ├─ Update pipelineStatus
   ├─ Unblock affected steps
   ├─ Update phase status
   └─ Update pipeline header
```

## CSS Classes

### Pipeline Header
- `.pipeline-header`: Container
- `.pipeline-header--running/success/failed/blocked`: State variants
- `.pipeline-status-icon`: Status icon
- `.pipeline-status-text`: Status text
- `.pipeline-progress-text`: Step counter

### Action Cards
- `.action-cards-container`: Cards wrapper
- `.action-required-card`: Individual card
- `.action-required-header`: Card header
- `.action-required-title`: Card title
- `.action-required-description`: Card body text
- `.action-required-actions`: Buttons container
- `.action-required-btn`: Button base
- `.action-required-btn--primary/secondary/dismiss`: Button variants

### Pipeline Phases
- `.phases-container`: All phases wrapper
- `.pipeline-phase`: Individual phase
- `.pipeline-phase--running/success/error/blocked`: Phase state
- `.pipeline-phase-header`: Clickable phase header
- `.pipeline-phase-icon`: Phase status icon
- `.pipeline-phase-title`: Phase name
- `.pipeline-phase-status`: Approval status text
- `.pipeline-phase-chevron`: Collapse indicator
- `.pipeline-phase-content`: Phase steps container
- `.pipeline-phase.collapsed`: Collapsed state

### Misc
- `.approval-log-line`: Inline approval decision log
- `.verbose-toggle`: Normal/Verbose button
- `.verbose-toggle--active`: Verbose mode active
- `.activity-feed__step--blocked`: Blocked step state

## Testing Checklist

### 1. Successful Git Pipeline
- [ ] Create commit and tag
- [ ] Verify phases auto-collapse as new ones start
- [ ] Check pipeline header shows "Step X/Y"
- [ ] Confirm final status is "Succeeded"

### 2. Vercel Login Required Case
- [ ] Trigger Vercel command without auth
- [ ] Verify "Action Required" card appears
- [ ] Check "Login to Vercel" button present
- [ ] Test dismiss button

### 3. Approval-Blocked Step
- [ ] Trigger ELEVATED approval
- [ ] Verify pipeline status becomes "Blocked"
- [ ] Check phase shows "Awaiting approval (ELEVATED)"
- [ ] Approve and verify inline log: "✓ Approved (Approve once)"
- [ ] Confirm pipeline resumes

### 4. Verbose Toggle Behavior
- [ ] Start in Normal mode
- [ ] Verify internal tools hidden (sequential_thinking, vault_search)
- [ ] Toggle to Verbose
- [ ] Confirm all steps visible
- [ ] Toggle back to Normal
- [ ] Verify filtering restored

### 5. Error Handling
- [ ] Trigger git authentication failure
- [ ] Verify "Action Required" card shows
- [ ] Confirm pipeline status becomes "Failed"
- [ ] Check stderr visible in step detail

### 6. Phase Grouping
- [ ] Run mixed command pipeline (git + vercel + browser)
- [ ] Verify steps grouped into correct phases:
  - staging (git add)
  - commit (git commit)
  - deploy (vercel)
  - browser (browser_navigate)
- [ ] Confirm only current phase expanded

### 7. Undo Button
- [ ] Execute `action_execute_plan` successfully
- [ ] Verify "Undo" button appears on step
- [ ] Click Undo → check button text changes to "Undoing..."
- [ ] Confirm IPC call to `actionUndoPlan`

## Performance Considerations

- **Collapsing old phases** reduces DOM size for long pipelines
- **Verbose mode filtering** applied via `display: none` (no DOM removal)
- **Error pattern matching** runs only on `updateStep()`, not per stderr line
- **Phase detection** uses regex matching on tool name + args (fast)
- **Event listeners** use event delegation where possible

## Future Enhancements

1. **Streaming stderr/stdout in phases**: Buffer and display raw output inline
2. **Action card history**: Log dismissed cards for reference
3. **Phase duration**: Show phase-level timing
4. **Retry button**: For failed steps
5. **Export pipeline log**: Save full execution log to file
6. **Smart phase naming**: Use LLM to generate human-readable phase names
7. **Progress bars**: Visual progress within phases
8. **Collapsible substeps**: Nested command output

## Known Limitations

1. **No real shell_exec wiring in action cards**: Primary action buttons log to console but don't execute commands (TODO)
2. **Stderr capture**: Relies on IPC events including stderr; not all tools emit this yet
3. **Phase detection heuristics**: May misclassify novel command patterns
4. **No persistent state**: Feed state lost on conversation switch/reload
5. **Approval tool ID**: `onApprovalRequest` doesn't include affected tool ID, so we can't highlight specific step

## Integration Points

### IPC Events Consumed
- `TOOL_EXEC_START`: Step begins
- `TOOL_EXEC_COMPLETE`: Step finishes
- `TOOL_STEP_PROGRESS`: Substep progress
- `TOOL_LOOP_COMPLETE`: Pipeline complete
- `APPROVAL_REQUEST`: Approval needed

### IPC Events Emitted (via DOM)
- `clawdia:approval:resolved`: Approval decision made

### Custom Events
- `clawdia:conversation:reset`: Clear feed state

## Code Quality

- **TypeScript strict**: No type errors
- **No external deps**: Uses only built-in APIs
- **CSS scoped**: All classes namespaced
- **Event cleanup**: Listeners removed on destroy
- **Memory safe**: Maps cleared on destroy
- **Error boundaries**: Null checks on DOM queries

## Accessibility

- Keyboard navigation: Not yet implemented (TODO)
- Screen readers: No ARIA labels (TODO)
- Color contrast: Meets WCAG AA for all states
- Focus management: Approval buttons focusable

## Summary

The enhanced activity feed provides a **structured, actionable, and transparent** view of command execution without changing the underlying tool execution logic. It's a pure UI enhancement that works alongside the existing activity feed and can be toggled/disabled without breaking core functionality.
