Read media content from a file.

**Tips:**
- Follow the description of each tool parameter.
- A `<system>` tag accompanies the media; it summarizes mime type, byte size and, for images, the original pixel dimensions, and states how the image was delivered (untouched, downsampled, cropped, or native resolution). When outputting coordinates, give relative coordinates first and compute absolute coordinates from the original image size. After generating or editing media via commands or scripts, read the result back before continuing.
- Large images are downsampled by default when automatic compression can fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the `<system>`-reported original dimensions, never by measuring the displayed copy. When it reports downsampling and you need that detail, call again with `region` (original-image pixel coordinates) for a full-fidelity crop, or set `full_resolution: true` when the whole file fits the per-image byte limit. Re-reading without these parameters just reproduces the downsampled image.
- If compression cannot fit the image within model limits, the tool returns an error and does not send the original — follow the error: create a smaller copy via Bash or an image-processing tool, then read that copy. Do not retry the unchanged file.
- Use in parallel: read multiple files in one response when possible.
- Image and video files only — use the Read tool for text files, `ls` via Bash or Glob for directories. A nonexistent/invalid path or a file over ${MAX_MEDIA_MEGABYTES}MB returns an error.

**Capabilities**
