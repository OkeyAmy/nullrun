# TestSprite code-defined tests

Purpose: public transparency evidence for the code-defined tests in the NULLRUN
TestSprite project. Each file here is the exact Python that TestSprite executes
for that test id (`testsprite test code get <id>` output), replayed against the
app by the TestSprite CLI, and exercised on every pull request by the
TestSprite GitHub App check.

Every test drives the real application — real keyboard events, real cursor
clicks on canvas tiles and buttons, real drag gestures — then asserts on the
game state exposed by the app's own bridge (`window.nullrun`). Nothing is
stubbed and no outcome is hardcoded: the seed is fixed so the facility layout
is deterministic, but every interaction is performed through the UI.

| test id | test |
| --- | --- |
| `0e0c57cb-76d3-47f0-952c-6302b367f482` | Pan the board by dragging (code) |
| `146f3135-c3c8-44db-aaa7-af05c5d02b6b` | Pan the camera by dragging the board (code) |
| `19cd58c4-f315-4bf0-a7e3-04274d614491` | Advance to the next floor after clearing a floor (code) |
| `1b2e49d5-2066-4b33-b160-6c5671627bb2` | Advance to the next floor after clearing a floor (code) |
| `1f9c8b28-f865-4063-a72a-5b95a562e334` | Toggle an adjacent door by clicking (code) |
| `1fbbfb34-dce8-4b99-a4e5-4ec340e0ab04` | Block movement when action points are exhausted (code) |
| `22e3d752-275c-4a3f-837a-c0ac0c359062` | Verify core collection updates the cores left stat (code) |
| `2e76a409-031e-4cb6-84cf-1c7b5d408f22` | Toggle sprint state with the shortcut action (code) |
| `3162d38d-b237-4297-95ad-3a0a8453a509` | Lift intel from loot (code) |
| `52668bb8-32e6-4a8a-947c-786e99fafd16` | Hack a terminal while adjacent to it (code) |
| `5784fa97-8a5d-4dbb-8eb0-2ead9362ae86` | Extraction remains gated until all cores are collected (code) |
| `6a9d8f4c-a84c-4b73-97ef-d4217d72b22c` | Failed run records the failure reason in the log (code) |
| `6deec06b-1d1f-4bf4-a484-c52cfd44fcf4` | Bridge status and tool count are exposed (code) |
| `70902a5a-3ae2-466f-873f-44f9398378f3` | Walk a path to a distant tile by clicking (code) |
| `7933ff2e-3ebe-4c07-91df-15c12b935bb0` | Open sprint and move farther in a single turn (code) |
| `7d26b780-1cde-4364-92da-4385212cfce1` | Click adjacent door toggles instead of moving onto it (code) |
| `822a08f1-1939-4826-9e89-d32ba00cf45d` | Follow a path by clicking a distant tile (code) |
| `88e30e2b-8bb4-45d4-b45b-c5fe61788fee` | Complete the full five-floor run (code) |
| `970ea8bf-3eaa-469e-948c-0aa106b56093` | Take down an adjacent guard (code) |
| `b2feccdd-352a-44ec-b96b-34a705336643` | Toggle an adjacent door by clicking it (code) |
| `c2efe0d3-ffe2-4c31-bc54-b44bbd5f574a` | Move one tile with keyboard (code) |
| `d1ecb8c5-4d0b-429b-b634-239373ffff30` | Extract after completing the floor objective (code) |
