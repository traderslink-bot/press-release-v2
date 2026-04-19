# press_release_levels_v2

Standalone `v2` workspace for TraderLink press release ingestion, PR financing classification, SEC dilution timing analysis, and Discord delivery.

## Setup

1. Copy [`.env.press_release_v2.example`](./.env.press_release_v2.example) to `.env.press_release_v2`.
2. Fill in your Discord, OpenAI, and local runtime values in `.env.press_release_v2`.
3. Run the bot from this project folder or from the workspace root.

## Notes

- `PR DROP` posts are currently suppressed from Discord in `v2`.
- The live focus right now is PR offerings/private placements and dilution timing.
- Replay artifacts live under [`docs/replay_results`](./docs/replay_results).
