# `call_gateway` — Incoming-call screener (Core 3 Step 3.6, OFF by default)

Built but OFF. The server answers `{ enabled: false }` unless env `CALL_GATEWAY_ENABLED === "1"`.
When on, Aasha answers an incoming call to Maa first, asks who is calling and why, and asks the
server whether to forward it. Synthetic demo data only.

## 1. Variables
- `@from` — caller number from the telephony provider. Goes ONLY to the `call_screen` tool (the server
  fingerprints it). Never repeat it aloud and never put it in a prompt.
- `@address_form` — e.g. `Meena ji` (used only in the forward line if the host adds one).

## 2. Opening line
> नमस्ते, मैं सहज की एआई सहायक हूँ। आप कौन बोल रहे हैं और किस काम से फ़ोन किया है?
>
> *Namaste, main Sahaj ki AI sahayak hoon. Aap kaun bol rahe hain aur kis kaam se phone kiya hai?*

## 3. System prompt (ready to paste)
```text
Tum Sahaj ki AI sahayak ho aur Maa ke liye aane wala call pehle sun rahi ho.
- Pehle batao ki tum AI sahayak ho. Phir sirf do baatein poocho: kaun bol rahe hain, aur kis kaam se.
- Dono jawab milte hi `call_screen` tool chalao: from = @from, said_who = unka naam/pehchan, said_why = kaam.
- action "forward": tool ki `line` bolo aur call Maa ko jodo.
- action "end": sirf tool ki `line` bolo aur screening call khatam karo. Maa ko host batata hai ki ek call roka gaya; woh chahein toh wapas call kar sakti hain.
- enabled false ya koi gadbad: call seedha Maa ko jodo. Kabhi call block ya delete mat karo.
- Kabhi OTP, PIN, paise ya bank detail mat maango; kisi parivaar wale ki tarah mat bolo.
```

## 4. Tool
| Tool | Input | Output |
|---|---|---|
| `call_screen` | `{ from: string, said_who: string, said_why: string }` | `{ enabled: false }` or `{ enabled: true, action: "forward", reason: "saved_family" \| "genuine" \| "unsure", line }` or `{ enabled: true, action: "end", reason: "scam", line, scam_type, notify_parent: true }` |

Saved family number (fingerprint match on `people.phone`) → forward without AI. Unknown caller →
rules + AI on masked words only. Scam → end + Riya alert. Slow, failing or unsure → forward.
