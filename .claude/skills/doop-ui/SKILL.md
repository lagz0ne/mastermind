---
name: doop-ui
description: Design-to-code loop between the doop canvas "mastermind UI" and apps/web. Use for ANY UI work in apps/web (components, styles, layout, copy), and for anything about designs, the canvas, frames, mockups, design feedback or comments.
---

# doop-ui: the mastermind UI canvas

- Canvas: **mastermind UI**, id `SJl5feHa1b`, https://doop.vibea.dev/c/SJl5feHa1b
- MCP server: `doop` (tools `mcp__doop__*`). Call `get_guide({ topic: "doop-instructions" })` once per session first.
- Style guide on the canvas: `get_guidelines({ canvas_id, name: "mastermind-ui" })`.
- Mirror of the shipped home screen: frame `5mGIlpWOuL` "Home (from source: apps/web/src)".

**doop is where the UI is designed and reviewed. `apps/web` is where it is built.**
The product and brand are still being designed by the human: do not invent features,
copy or brand decisions in code. If you think something should change, propose it as a new frame.

Use one `agent_name` for every doop call in a session (e.g. `paseo-<id>`), so your presence
and edits are attributed. Pass it on reads too; open human feedback can only reach named agents.

## The loop

**(a) Read the canvas before any UI work**
- `get_canvas({ canvas_id, agent_name, approval_status: "ready_for_dev" })` lists approved frames.
  Only `ready_for_dev` is sign-off. HTML or size edits reset approval, so re-read `get_frame` right before implementing.
- `get_frame({ frame_id, agent_name })` returns the full HTML: the spec to build from.
- `get_feedback({ canvas_id, agent_name })` claims open human requests. Address them first.
- `get_comments({ canvas_id, frame_id?, include_resolved: false })` lists open comments. `elementId` = `data-doop-id` in the frame HTML.

**(b) One bead per frame or change**
```bash
bd create "ui: <frame name>" -t feature -p 2 -d "implement frame <id> (<url>)" --json
bd -q note <bead> "frame: <frame id>"
bd -q note <bead> "files: apps/web/src/..."
```

**(c) Narrate on the canvas while working**
`set_status({ canvas_id, agent_name, status: "Building <frame> in apps/web (<bead>)" })`. Clear it with `""` when done.

**(d) Implement and ship**
Build in `apps/web/src` (React 19, plain CSS, no CSS framework yet). Keep `data-doop-id`s in mind
when naming elements, so comments map to code. Ship with
`scripts/ship.sh -m "feat(web): ..." -i <bead> -- <paths>`, then wait for CI (it deploys to https://mastermind.vibea.dev).

**(e) After deploy, re-sync and close the loop**
- Update the mirror frame to what shipped. If the live site returns 200, use `import_webpage({ canvas_id, url, agent_name })`.
  Otherwise use `edit_frame_html` / `set_frame_html` on the mirror frame. Then `get_frame_screenshot` and check it.
- `reply_to_comment({ canvas_id, comment_id, text, agent_name })` with the commit sha, then
  `resolve_comment({ canvas_id, comment_id, agent_name })` for each comment the change addressed.
- `bd close <bead> -r "shipped <sha>: ... frame <id>"`.

## Do not

- Delete, overwrite or restyle a frame a human made. Propose changes as a **new frame** beside it
  (`create_frame` / `append_frame_html`), named "<original> — proposal (<bead>)".
- Edit a frame someone else touched seconds ago (check `updatedBy` / `updatedAt` in `get_canvas`).
- Strip `data-doop-*` attributes when rewriting frame HTML. Comments and prototype wiring hang off them.
- Implement a frame that is not `ready_for_dev` unless the human asked for it.
- Mark your own work approved. Approval is a human action in the doop UI.
- Inline images as `data:` URIs. Use `upload_asset` and use the URL it returns.

## Notes

- Mirror frames (`(live)` / `(from source)`) are agent-maintained and may be updated freely to match `main`.
- doop's renderer maps `system-ui` to a monospace face. The mirror frame pins a sans fallback (frame only, not in the app).
- Undo a bad frame edit: `list_frame_versions({ frame_id })` → `restore_frame_version({ frame_id, version_id, agent_name })`.
