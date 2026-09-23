# Demo video placeholder

The Demo section of index.html points at `demo.mp4` (same folder). To publish
your own capture:

1. Record the overlay during a screen share (OBS "Display Capture" shows the
   overlay; Zoom/Meet share does not — that's the point of the demo).
2. Convert to H.264 MP4, 16:9, muted, ~30-60s, <10 MB:
   ffmpeg -i input.mov -vcodec libx264 -crf 28 -an -movflags +faststart demo.mp4
3. Drop it in webapp/demo.mp4 and commit.

Until then browsers show the og-image poster with disabled controls.
