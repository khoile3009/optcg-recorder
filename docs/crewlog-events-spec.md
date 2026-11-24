# Crewlog recorder API: events and tournament games

Status: draft · Owner: Crewlog server · Consumer: optcg-recorder

## Why

Today every game the recorder logs goes into the user's sim session for that
day. Players also play online tournaments on OPTCG Sim, and those games belong
to an event with rounds, not to the sim session. The sim logs don't mark
tournament games, so the recorder adds that marking itself: the user turns on
**Event mode** (with an event name) and every game logged while it's on is
tagged with that event. Games played in the same private room against the
same opponent form one **set** (one round, for example a best-of-3).

This spec extends the existing connector API so Crewlog can file those games
under the right event and round. Everything here is additive. A recorder that
doesn't send the new fields keeps working exactly as it does now.

## 1. Feature discovery

`GET /api/recorder/me` gains a `features` list:

```json
{ "handle": "khoi", "features": ["events"] }
```

The recorder sends the new fields only when `features` contains `"events"`.
This lets the server and the recorder ship in either order.

Separately from that, the server **must ignore unknown fields** on
`POST /api/recorder/games` instead of answering 400. The recorder treats a 400
as its own bug and drops the game for good, so a strict server would lose games.

## 2. `POST /api/recorder/games`: new optional fields

| Field | Type | Rules |
|---|---|---|
| `kind` | `"sim"` \| `"event"` | Absent means `"sim"`, which is today's behaviour. |
| `event` | object | Required when `kind` is `"event"`, and ignored otherwise. |
| `event.client_id` | string, 1 to 64 chars, `[A-Za-z0-9_-]` | The recorder makes this id when the user starts Event mode, and it stays the same for the whole event. This is the matching key. |
| `event.name` | string, 1 to 80 chars, trimmed | The name to show. Used when the event is created. If the name changes later for the same `client_id`, the event is renamed. |
| `set_id` | string, 1 to 64 chars, `[A-Za-z0-9_-]` | Opaque. Games with the same `set_id` in one event are one round. It's a hash made by the recorder and never contains a room code (see section 6). |
| `game_in_set` | integer, 1 to 9 | The game number within its set. Optional. |
| `match_source` | `"queue"` \| `"private"` | How the game was started in the sim. Used for display and filtering only. |

A full example:

```json
{
  "game_id": "8a1f…",
  "played_on": "2026-11-23",
  "my_leader": "OP17-039",
  "opp_leader": "OP11-041",
  "result": "W",
  "went_first": true,
  "kind": "event",
  "event": { "client_id": "ev_7c2d9e", "name": "Weekly Bash #12" },
  "set_id": "s_3fa94b1c0d2e",
  "game_in_set": 2,
  "match_source": "private"
}
```

The whole body stays under the existing 2000-byte limit.

## 3. Filing rules (server)

1. **`kind` absent or `"sim"`:** no change from today, so the game goes into the
   day's sim session. `match_source` is still stored if it's sent.
2. **`kind` is `"event"`:**
   - Look up the user's event by `event.client_id`. If there isn't one, create it
     with `event.name` and `played_on` as its date.
     Return `new_event: true` in that case.
   - **Rounds:** each distinct `set_id` in the event is one round. Rounds are
     numbered in the order their first game arrives.
   - If `set_id` is missing, the game is its own round.
   - A round's result is the majority of its games' results (2–1 is a win). If
     the games are tied (1–1 with no decider), the round is unresolved until
     another game arrives.
   - Event games are **not** added to the day's sim session.
3. **Duplicates:** these keep today's meaning. A second POST with a `game_id`
   that's already logged returns `duplicate: true` and the existing filing, and
   moves nothing, even if the event fields are different. Moving a game is
   done through section 5.

## 4. Response

Add these fields to the existing response
(`event_id, round, handle, duplicate, new_session, url`):

| Field | Meaning |
|---|---|
| `kind` | Where the game was filed: `"sim"` or `"event"`. |
| `event_id` | The event's id, which already exists. For sim games it's the sim session's id, as now. |
| `round` | The round number within the event, which already exists. It's `null` for sim games. |
| `new_event` | `true` when this POST created the event. |
| `round_result` | `"W"`, `"L"` or `null` (unresolved). Event games only. |
| `url` | For event games, a link to the event page, scrolled to the round. |

## 5. Moving a logged game: `PATCH /api/recorder/games/{game_id}`

Players forget to turn on Event mode, so the recorder lets them tag games
afterwards. It sends the same fields as section 2:

```json
{ "kind": "event", "event": { "client_id": "ev_7c2d9e", "name": "Weekly Bash #12" }, "set_id": "s_3fa94b1c0d2e", "game_in_set": 1 }
```

- `{ "kind": "sim" }` moves the game back to the sim session for its
  `played_on` date. That session is created if it doesn't exist.
- The request is idempotent. Sending the same body twice returns the same result.
- The reply has the same shape as section 4.
- If moving the game leaves a sim session or an event empty, delete the empty one.
- `404` with `code: "unknown_game"` if the `game_id` was never logged by this user.

## 6. Privacy

- No room codes, opponent names or match numbers are sent.
- `set_id` is computed on the user's machine as
  `"s_" + first 12 hex chars of sha256(room_id + "|" + opponent_name + "|" + played_on)`,
  so the server can group the games of a set but can't recover the room or the opponent.
- `event.client_id` is random (`"ev_" + 6 or more random bytes, hex`).
- Authentication doesn't change: the bearer connector code is sent only to the
  configured base URL.

## 7. Errors

The error shape stays `{ error, code }` with status 422, so the recorder drops
the game and shows `error` to the user. New codes:

| `code` | When |
|---|---|
| `event_required` | `kind` is `"event"` but `event` is missing or invalid. |
| `bad_event_name` | The name is empty after trimming, or longer than 80 chars. |
| `bad_set_id` | The `set_id` has the wrong length or invalid characters. |
| `event_closed` | The user closed or archived that event in Crewlog. |

## 8. Rollout

1. **Crewlog:** ignore unknown fields (this can ship today), then implement
   sections 2 to 5 and advertise `features: ["events"]`.
2. **Recorder:** add Event mode, sets and badges. It sends event fields only
   when `/me` lists `"events"`. Otherwise event games are logged as plain sim
   games and tagged locally, so they can be moved with PATCH once the server
   supports it.

## Open questions

- Should the event store the format (Swiss or top cut), or only the rounds?
- Should round results count only resolved sets in the event's win rate?
- Should a user be able to name the opponent for a round in the Crewlog UI,
  since the recorder doesn't send names?
