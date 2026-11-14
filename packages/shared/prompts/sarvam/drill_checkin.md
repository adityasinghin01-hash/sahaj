# `drill_checkin` — Weekly helper drill segment of the daily check-in (Core 3 Step 2.6)

Add this segment to the `checkin` agent. It runs at most once a week, only when the server
supplied `@drill_id`. Synthetic demo data only.

## 1. Variables
From `on_start` (the host calls `shield.pickDrill({ familyId, parentId, now })` and, separately,
`shield.takeCheckinPraise({ familyId, parentId })`):
- `@drill_id` — `pickDrill(...).checkin_variables.drill_id`, or empty (no drill this week).
- `@drill_story` — `pickDrill(...).checkin_variables.drill_story` (Hindi story, already masked).
- `@drill_praise` — `takeCheckinPraise(...).drill_praise`, or empty. Set after a safe experience drill.

## 2. When
After the haal-chaal questions and before the fraud tip. Skip the whole segment when `@drill_id` is empty.
If `@drill_praise` is not empty, say it once, first, word for word.

## 3. Script (ready to paste into the check-in system prompt)
```text
Abhyaas (sirf jab @drill_id khali nahi ho):
- Kaho: "Ek chhoti si kahani sunati hoon, phir aap bataiyega aap kya karti." Phir @drill_story dheere se, jaisa likha hai, sunao.
- Jawab ka intezaar karo. Unke shabd waise ke waise `drill_answer` tool ko do: drill_id = @drill_id, said = unka jawab.
- Tool jo `teach_line_hi` lautaye, sirf wahi bolo. Apni taraf se kuch mat jodo.
- Abhyaas mein bhi kabhi OTP, PIN, paise ya bank detail mat maango. Tum Sahaj ki AI sahayak Aasha ho; kisi parivaar wale ki tarah mat bolo.
- Agar @drill_praise khali nahi hai, abhyaas se pehle use ek baar bolo.
```

## 4. Tool
| Tool | Input | Output | Notes |
|---|---|---|---|
| `drill_answer` | `{ drill_id: string, said: string }` | `{ score: 0\|1\|2, teach_line_hi: string, teach: boolean }` | Score is about the answer, never the person. `teach = true` (score < 2) → story's teaching line; `teach = false` (full marks) → short praise line. Answers within 3 s. Speech is masked before AI and storage. |

## 5. If the tool fails or times out
The tool itself returns a kind fallback line within 3 s. Speak it and move on to the fraud tip.
