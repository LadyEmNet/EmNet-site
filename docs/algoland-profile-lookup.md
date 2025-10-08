# Algoland profile lookup feature

This release introduces an on-page Algorand address and Algoland ID lookup workflow so operations and support teams can quickly retrieve player progress while keeping indexer traffic manageable.

## Front-end
- Adds a search form above the weekly tracker that accepts wallet addresses or numeric IDs and performs inline validation.
- Reuses the Algoland overlay styling to present lookup results in a modal with profile, quest, challenge, referral, and weekly draw breakdowns.
- Provides accessible status messaging, focus management, and loading indicators to keep the experience usable with keyboards and assistive technologies.

## Back-end
- Exposes a `/api/algoland-stats` endpoint that accepts addresses or IDs, normalises indexer responses, and caches decoded profiles to avoid redundant blockchain calls.
- Includes resilient retry logic with exponential back-off for indexer requests and structured error responses for empty, invalid, or missing profiles.
- Shares caching utilities with existing entrants/completions endpoints so the new lookup can leverage warm data where available.

## Screenshot
A current UI capture of the lookup form positioned above the weekly tracker is attached to the pull request for reference.
