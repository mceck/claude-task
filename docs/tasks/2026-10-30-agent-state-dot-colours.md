---
status: done
---

# Agent state dots: filled when at work, hollow when not

## Specs

- [Clients](../specs/clients.md) (Theme)

## Problem

Every Agent and Session state used a filled dot in a different colour, so telling "working" from "idle" meant reading the colour and remembering that green filled meant both `working` and (before this change) nothing else, while `idle` was the same grey as an Agent that is offline. At a glance the board and the Agents list said little about whether an Agent is doing something.

## Solution

One visual language for the state dot, used by the avatar badge (Board cards, Agents list and Agent page), by the Agent state badge and by the Session chips of Tasks and Wiki Chats:

- **filled** = there is work: green `running`, blue `pending` (starting), blue `building`, amber `paused`, red `build_failed`;
- **hollow** = there is none: green `idle`, grey `offline` and `closed`, red `disabled`.

Running and building dots keep their pulse. The `Idle` badge keeps its neutral border and text: only the dot is green.

## Decisions

- **Hollow instead of another grey.** A shape difference reads at a glance and stays legible for colour-blind Users, who otherwise only had the (identical) grey of offline, closed and disabled.
- **`disabled` in red, hollow.** A disabled Agent is a state an Admin chose, not one the Agent reached: red marks it as something to fix, the hollow fill keeps it apart from a failed Build.
- **`closed` follows `offline`.** Both mean no live Session, so both are grey hollow; the chip's label ("closed") still tells them apart.
- **One component.** `StateDot` in `frontend/src/components/agents.tsx` maps every state, so the three places that show a dot cannot drift.

## Testing Decisions

The change is presentational and covered by the existing Playwright suites that render these states (`frontend/e2e/agents.spec.ts`, `board.spec.ts`); they were run to confirm nothing else depends on the dot's fill. Checked by hand in the running app: idle (green hollow), disabled (red hollow), working (green filled), building (blue filled), pending (blue filled) on the Agents list and the Board.

## Acceptance Criteria

- [x] `offline` and `closed` show a grey hollow dot.
- [x] `idle` shows a green hollow dot.
- [x] `running` and `working` keep the green filled dot, with the pulse.
- [x] `building` keeps the blue filled dot.
- [x] `disabled` shows a red hollow dot.
- [x] The change applies to the avatar badge, the Agent state badge and the Session chips.
- [x] The `Idle` badge keeps a neutral border and text.
- [x] `docs/specs/clients.md` documents the dot language.

## Out of Scope

- Colours of the Project activity dot and of the unread indicators, which are not Agent states.
- The native app, which shows no Agent state dot.
