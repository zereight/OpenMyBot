---
name: verify-omb
description: "Verify OpenMyBot server and conversation changes against an isolated fake-engine instance before claiming they work."
---

# Verify OpenMyBot

Follow the canonical instructions in `docs/verification/README.md`. Use its
shared control tool; do not improvise raw API calls or drive the user's live
OpenMyBot instance. The canonical feature map currently covers only the
server flows that tool can prove.
