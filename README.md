# Market Widget X Relay

Free, read-only relay for public NFL reporter timelines used by Market Widget.

Every ten minutes, three isolated GitHub Actions runners retrieve separate matchup groups from current Nitter RSS timelines and send canonical public X post metadata to the managed Market Widget feed. No X credentials, API keys, cookies, or private extension code are stored in this repository.
