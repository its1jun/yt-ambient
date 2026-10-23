# AI Coding Rules

## 1. Language

- Write all code comments in Korean.
- Write explanations to the user in Korean, using simple words. Briefly explain technical terms when needed.
- Keep variable names, function names, class names, file names, and identifiers in English.
- Preserve the existing naming conventions of the project.

## 2. Project Context

- The user is a non-developer doing vibe coding. Do not assume programming background.
- If `architecture.txt` (or a similar project doc) exists, read it first and follow it. Its project-specific rules take priority over Section 6 where they differ.
- Do not guess about code you have not seen. If a file is needed, ask the user to paste it.
- If a change makes `architecture.txt` outdated, tell the user which line to update.

## 3. Comments

- Add one concise Korean comment above each function when it is useful. Describe the overall behavior and main responsibility.
- Add internal comments only for important information: value units, formats, ranges, expected inputs or outputs, dependencies, or usage requirements.
- Keep the function body focused on code.

## 4. Bug Fixing

- Investigate the underlying cause before modifying code. Trace the relevant data flow, state changes, function calls, and dependencies.
- Fix the root cause, not only the symptom. Do not hide or bypass the problem.
- Prefer a fix that stays correct when related values, content, or screen sizes change.
- Reuse existing variables, constants, functions, and configuration before creating new ones.
- Keep values that may change configurable (variables or constants), not hardcoded.
- If the cause cannot be determined from the code provided, say so and ask for the missing file or error message. Do not guess.

## 5. Code Modification

- Make the smallest change that fixes the root cause. Do not make a narrower patch that only masks the symptom.
- Preserve the existing project structure, variable names, function names, class names, naming conventions, coding style, and formatting.
- Modify only what the requested task requires. Keep unrelated code unchanged.
- If the proper fix requires a structural change (new abstraction, multiple files, renaming, restructuring), do not apply it immediately. First explain the reason and the scope in a few lines, and wait for the user's approval.

## 6. Project Conventions (reusable across projects)

Before applying these rules, identify the project's actual files and folders (check `architecture.txt` or the existing structure). Use their real names. If a role below has no matching file yet, ask the user before creating one.

- **Global stylesheet**: the CSS file that holds `:root` variables shared by the whole site (often `base.css`).
- **Entry page**: the main HTML file that loads the CSS/JS files (often `index.html`).

Rules:

- Split new features by feature name into separate CSS and JS files. Keep small HTML fragments in the entry page.
- Put new files in the folder that matches their type, following the project's existing folders (for example styles, scripts, audio, images).
- File names: lowercase English letters with hyphen or underscore. No Korean or spaces.
- Define colors, sizes, spacing, durations, and other design values as variables in `:root` of the global stylesheet. Other CSS files must use `var(--name)` and must not hardcode them.
- Prefer relative units `rem`, `vw`, `%`, `clamp()`, `min()`) over `px`, so layouts adapt to screen size and font settings.
- Position elements from the screen edge with edge-spacing variables. On narrow screens, limit widths with `min()` / `calc()` so elements do not overlap.
- Build repeatedly opening/closing UI (panels, menus, popups) with `transition` and a `.visible` class. Do not use the `hidden` attribute or `display: none` for them.
- When a new CSS or JS file is created, remind the user to link it in the entry page.

## 7. Response Format

- Put the replacement code first. Keep each explanation to one line. Use one or two sentences only when explaining a bug cause.
- Always give complete units that can be pasted over the old ones, one per replacement, each with its file name and location.
- Provide only the parts that require modification.

**JS / other code**: replace the whole function.

**File:** `FileName.js`

**Replace:** `functionName()`

```js
// 함수 설명 주석
function functionName() {
  ...
}

```

**CSS**: replace the whole rule block (selector to closing brace), or the whole `@keyframes` block.

**File:** `file-name.css`

**Replace:** `.selector`

```css
.selector {
  ...
}

```

**HTML**: show the changed element, and state exactly where it goes (for example "directly above `</body>`" or "replace the line containing `<div class=...>`").

- After the code, add one line on how to check that it works.

## 8. Workflow

1. Read `architecture.txt` and understand the existing logic related to the request.
2. For a bug, identify the underlying cause first.
3. Find existing patterns and reusable parts in the project.
4. Choose the smallest change that properly solves the problem. Ask for approval if it is structural (Section 5).
5. Consider related conditions and side effects.
6. Provide each modified unit in full, with file name and location, following Section 7.
