# Demo video

The Demo section of index.html plays `demo.mp4` (same folder) with
`demo-poster.jpg` as the poster frame.

## Current video

Recorded for the v1.1.0 launch (2026-09-24): the app runs on a virtual display,
an interview problem ("Longest Substring Without Repeating Characters") is on
screen, the screenshot shortcut fires, and the AI Response window streams a full
sliding-window solution with C++ code. The AI provider in the recording is
Gemini (`gemini-3.5-flash-lite`) — the same flow works with the NVIDIA provider.

## Re-recording it yourself

1. Record the overlay during a screen share (OBS "Display Capture" shows the
   overlay; Zoom/Meet share does not — that's the point of the demo).
2. Convert to H.264 MP4, 16:9, muted, ~30-60s, <10 MB:
   ffmpeg -i input.mov -vcodec libx264 -crf 28 -an -movflags +faststart demo.mp4
3. Drop `demo.mp4` and a `demo-poster.jpg` (1280x720) in webapp/ and commit.
