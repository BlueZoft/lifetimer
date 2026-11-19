# Development handoff

## Current expansion

The next release adds optional morning and evening health check-ins, confirmed activity logs, task outcome reviews, and session history. A task retains its original goal and checkpoint wording. Its current success criteria and remaining estimate can evolve with a dated revision history.

A focus session records elapsed work independently of confirmed task completion. Unreviewed sessions remain available after closing a dialog or reloading. Existing browser data is migrated in place.

Goal plans cover 3, 7, or 14 calendar days, with an adjustable daily focus allowance and rest days. Future invitations, hydration prompts, and daily check-ins are persisted on the reminder server for the whole plan. Actual session break prompts begin when a session starts.

## Validation and delivery

Run npm test for the planner, timer, migration, campaign allocation, and reminder server. Use Chromium to check creating/editing tasks, preserving baseline goals, ending and reviewing sessions, health check-ins, and mobile dialogs. Native push delivery still needs a compatible browser and reachable push provider.

Implementation is in progress. The next commits will replace this status with tested behavior and any remaining limitations. Each completed slice is committed and pushed to main with its documentation.

The data and planner modules are implemented and covered by focused tests. Legacy browser tasks and unpadded water dates migrate to the expanded schema. Multi-day allocation respects explicit completion, a default four-hour daily focus allowance, and rest weekdays. UI integration and end-to-end verification remain in progress.
