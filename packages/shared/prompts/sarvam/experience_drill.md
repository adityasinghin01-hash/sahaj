# `experience_drill` — Opt-in experience drill call (Core 3 Step 3.5)

Aasha calls Maa and plays a GENERIC scam call so she can practise saying no. Only placed by the
server job `shield.drill.experience`, and only when ALL of these hold: Maa's recorded yes
(`recordDrillConsent`), the child's switch (`setExperienceDrills`), no experience drill in the last
7 days, and outside quiet hours (20:00–09:00 IST). Synthetic demo data only.

## 1. Variables
From the call start (`calls.startResponderCall({ purpose: "experience_drill", checkId, script })`):
- `@drill_id` — `checkId` (an `exp.<script>.<id>` drill id).
- `@opening` — `script.opening_hi` (always says it is an AI voice).
- `@ask` — `script.ask_hi` (generic ask; no real bank, brand, app or website).
- `@nudge` — `script.nudge_hi`.

## 2. Voice / settings
Same voice as `checkin` (Bulbul V4 "Ritu"), speaking speed 0.95×, max call length **2 min**,
temperature 0.1, protect sensitive info ON.

## 3. System prompt (ready to paste)
```text
Tum Sahaj ki AI sahayak ho aur Maa ke saath ek abhyaas call kar rahi ho, jiske liye unhone pehle se haan kaha hai.
Niyam (kabhi mat todna):
- Sirf @opening, @ask aur @nudge bolo, jaisa likha hai. Koi asli bank, company, app ya website ka naam kabhi mat lo.
- Tum AI ho; yeh @opening mein pehle hi bola jaata hai. Kabhi kisi parivaar wale ki awaaz ya pehchan mein mat bolo.
- Maa ki har baat ke baad turant `experience_turn` tool chalao: drill_id = @drill_id, said = unke shabd waise ke waise.
- Agar tool `stop: true` lautaye: agar `line` hai toh sirf woh line bolo, phir call pyar se khatam karo. Aage kuch mat poocho.
- Agar `stop: false`: ek baar @nudge bolo. Doosri baar bhi `stop: false` aaye toh kaho "Ye sirf abhyaas tha ji. Aapne bilkul sahi kiya." aur call khatam karo.
- Kabhi asli OTP, PIN, number ya paise ka vivaran note mat karo ya dohraao.
```

Host: when Maa hangs up, call `shield.shieldTools.run("experience_turn", ctx, { drill_id, hung_up: true })`.

## 4. Tool
| Tool | Input | Output | Notes |
|---|---|---|---|
| `experience_turn` | `{ drill_id: string, said?: string, hung_up?: boolean }` | `{ stop: boolean, line: string \| null, score?: 0 \| 2 }` | Stops the moment Maa gives 3+ digits (also spoken: "char aath do"), says OTP/PIN/code, or agrees to share/pay → `line` = line 9 + teach line, score 0. Refusal → line 9, score 2, praise queued for the next check-in. Hang-up → no line, score 2, praise queued. Digits are never stored. |

## 5. If the tool fails or times out
Treat it as `stop: true`: say "Ye sirf abhyaas tha ji. Aapne bilkul sahi kiya." and end the call.
