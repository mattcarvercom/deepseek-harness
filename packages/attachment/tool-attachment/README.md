---
description: "Model-facing `attachment_paths` tool: read-only host paths for the images and files a human attached, so path-based tools can consume them."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-attachment

English | [中文](README.zh.md)

## Summary

`dsh-tool-attachment` adds `attachment_paths`, the model-facing bridge from a human's attachments to the filesystem paths that path-based tools read. An attached image reaches the model as pixels only — its durable reference is opaque — so an image editor, a file reader, or a shell command has nothing to open. The tool resolves the images and files of the most recent human message that carries attachments through the mounted attachment store's host-path accessors and returns the paths with display metadata. It copies nothing and writes nothing.

## Use this package

Mount it in an agent's Cordis composition with `tools` and a host-file-backed `attachments` store:

```yaml
- name: '@deepseek-ai/dsh-tool-attachment'
```

Without a mounted attachment store the plugin loads and registers nothing, mirroring `read_image`'s composition-conditional registration.

### What the tool does

`attachment_paths` takes no arguments. It scans the calling session's surface backwards for the most recent `user/message` from a human that carries `image` or `file` parts, resolves each through `ctx.attachments.imageHostPath` / `fileHostPath`, and returns the message sequence plus one entry per attachment: kind, absolute host path, name, media type, byte size, and image dimensions. With no such message it returns an empty list and says so.

The returned paths are read-only stored copies: an image resolves to the normalized object (`<dshHome>/attachments/v1/objects/<xx>/<sha256>`, extensionless, possibly re-encoded), a file to the verbatim named copy (`<dshHome>/attachments/v1/files/<xx>/<sha256>/<name>`). Pass them directly to tools that read files; copy first before mutating.

## Model Experience

### Request context and condition

The schema registers for every session on a composition that mounts the plugin and is listed in the tool catalog on every request. The tool is useful exactly when the user attached an image and the model needs a path: attached non-image files already receive a handle with their saved path in the conversation (`fileHandleText`), while an attached image otherwise has no path at all.

### What the model sees

The description names the trigger ("the user attached an image and a path-based tool needs it") and the read-only nature of the paths. A successful call returns one text block: a header line, one line per attachment with the quoted absolute path and metadata, and the read-only note. No attachment bytes enter the message; the result is bounded by the attachment count of one message.

### Token effect

One tool schema per mounted agent, plus one short result line per attachment on call. No other request grows.

## Known Limitations and Deferred Work

- The tool reports the most recent human message that carries attachments; an older message's attachments need a path already echoed in that conversation or a manual copy.
- A non-host-file-backed attachment store resolves no path; each entry then reports that no host path is available.
- Only image and file parts are covered; other content kinds have no path form.
