export interface VoiceLine {
  id: string;
  use: string;
  hi: string;
  roman: string;
  en: string;
  seconds_est: number;
}

/**
 * Fixed spoken Hindi voice lines for Aasha Didi (Core 1, Core 2, and Core 3 Shield).
 * Shield lines shield_1–shield_9 match STOP_SCRIPTS 1–9 in @sahaj/shield.
 */
export const LINES = [
  // --- Core 3 · Shield fixed lines (1–9) ---
  {
    id: "shield_1",
    use: "Shield 1: General fraud stop warning — do not pay or share OTP, hang up",
    hi: "रुक जाइए जी। ये फ्रॉड हो सकता है। किसी को पैसे या OTP मत दीजिए, और ये फ़ोन काट दीजिए।",
    roman: "Ruk jaiye ji. Ye fraud ho sakta hai. Kisi ko paise ya OTP mat dijiye, aur ye phone kaat dijiye.",
    en: "Please stop. This could be fraud. Do not give anyone money or an OTP, and hang up this phone.",
    seconds_est: 7,
  },
  {
    id: "shield_2",
    use: "Shield 2: OTP warning — bank, police, or company never ask for OTP",
    hi: "OTP किसी को मत बताइए जी। बैंक, पुलिस या कंपनी कभी OTP नहीं माँगते।",
    roman: "OTP kisi ko mat bataiye ji. Bank, police ya company kabhi OTP nahi maangte.",
    en: "Do not tell anyone your OTP. A bank, the police, or a company never ask for an OTP.",
    seconds_est: 6,
  },
  {
    id: "shield_3",
    use: "Shield 3: Outgoing call pause — check suspicious number before talking",
    hi: "एक मिनट रुकिए जी। इस नंबर पर बात करने से पहले हम चेक कर लेते हैं।",
    roman: "Ek minute rukiye ji. Is number par baat karne se pehle hum check kar lete hain.",
    en: "Wait one minute, please. Before talking on this number, let us check it first.",
    seconds_est: 5,
  },
  {
    id: "shield_4",
    use: "Shield 4: Digital-arrest video call warning",
    hi: "पुलिस कभी वीडियो कॉल पर अरेस्ट नहीं करती जी। ये फ्रॉड है, फ़ोन काट दीजिए।",
    roman: "Police kabhi video call par arrest nahi karti ji. Ye fraud hai, phone kaat dijiye.",
    en: "The police never arrest anyone on a video call. This is fraud, please hang up.",
    seconds_est: 6,
  },
  {
    id: "shield_5",
    use: "Shield 5: Suspicious file, APK, or app install warning",
    hi: "कोई फ़ाइल या ऐप मत खोलिए जी। ये फ्रॉड हो सकता है।",
    roman: "Koi file ya app mat kholiye ji. Ye fraud ho sakta hai.",
    en: "Do not open any file or app, please. This could be fraud.",
    seconds_est: 4,
  },
  {
    id: "shield_6",
    use: "Shield 6: Post-incident OTP check and reassurance",
    hi: "क्या आपने किसी को OTP बताया है जी? बताया हो तो कोई बात नहीं, हम अभी मदद करते हैं।",
    roman: "Kya aapne kisi ko OTP bataya hai ji? Bataya ho toh koi baat nahi, hum abhi madad karte hain.",
    en: "Did you share an OTP with anyone? If you did, no worries — we will help you right away.",
    seconds_est: 6,
  },
  {
    id: "shield_7",
    use: "Shield 7: 1930 cybercrime helpline prompt if money was already sent",
    hi: "पैसे चले गए हैं तो अभी 1930 पर कॉल कीजिए। रिया को सब भेज दिया है।",
    roman: "Paise chale gaye hain toh abhi 1930 par call kijiye. Riya ko sab bhej diya hai.",
    en: "If money has been sent, call 1930 right now. Everything has been sent to Riya.",
    seconds_est: 6,
  },
  {
    id: "shield_8",
    use: "Shield 8: Hold line while checking with family members",
    hi: "एक मिनट रुकिए जी, मैं आपके घर वालों से पूछ रही हूँ।",
    roman: "Ek minute rukiye ji, main aapke ghar walon se pooch rahi hoon.",
    en: "Wait one minute, please — I am checking with your family.",
    seconds_est: 4,
  },
  {
    id: "shield_9",
    use: "Shield 9: Practice drill praise when Maa handles a drill safely",
    hi: "ये सिर्फ़ अभ्यास था जी। आपने बिल्कुल सही किया।",
    roman: "Ye sirf abhyaas tha ji. Aapne bilkul sahi kiya.",
    en: "This was just a practice drill. You did the exact right thing.",
    seconds_est: 4,
  },

  // --- Core 1 & Core 2 fixed lines ---
  {
    id: "aasha_greeting",
    use: "Core 1: Standard call greeting with AI disclosure",
    hi: "नमस्ते जी, मैं सहज की एआई सहायक आशा हूँ।",
    roman: "Namaste ji, main Sahaj ki AI sahayak Aasha hoon.",
    en: "Hello, I am Aasha, Sahaj's AI assistant.",
    seconds_est: 4,
  },
  {
    id: "urgent_112",
    use: "Core 1: Immediate danger line (raise_urgent)",
    hi: "पहले 112 लगाइए जी। मैं सबको बता रही हूँ।",
    roman: "Pehle 112 lagaiye ji. Main sabko bata rahi hoon.",
    en: "Call 112 first, please. I am alerting everyone now.",
    seconds_est: 4,
  },
  {
    id: "main_safe_hoon_prompt",
    use: "Core 2 (G4/G6): Prompt asking Riya to tap or record 'Main safe hoon'",
    hi: "माँ आपको ढूँढ रही हैं — 'मैं सेफ़ हूँ' दबाइए।",
    roman: "Maa aapko dhoondh rahi hain — 'Main safe hoon' dabaiye.",
    en: "Maa is looking for you — tap 'Main safe hoon'.",
    seconds_est: 4,
  },
  {
    id: "never_dead_bridge",
    use: "Core 1/2/3: Never-dead fallback line when any tool fails or times out",
    hi: "माफ़ कीजिए, मैं आपको अभी रिया से जोड़ रही हूँ।",
    roman: "Maaf kijiye, main aapko abhi Riya se jod rahi hoon.",
    en: "Sorry about that — I am connecting you to Riya right now.",
    seconds_est: 4,
  },
  {
    id: "real_news_rule",
    use: "Core 2 (G7): Real-news rule taught at setup and biweekly check-ins",
    hi: "रिया के बारे में कोई भी फ़ोन आए — काटिए और 2 दबाइए। असली ख़बर सिर्फ़ आपके अपने कॉल में मिलेगी।",
    roman: "Riya ke baare mein koi bhi phone aaye — kaatiye aur 2 dabaiye. Asli khabar sirf aapke apne call mein milegi.",
    en: "If any call comes about Riya — hang up and press 2. Real news will only come inside your own call.",
    seconds_est: 7,
  },
  {
    id: "g4_status_on_the_way",
    use: "Core 2 (G4): Status line when Riya's watch is on and she is safely on her way",
    hi: "रिया घर के रास्ते में हैं जी, अभी सब ठीक है।",
    roman: "Riya ghar ke raste mein hain ji, abhi sab theek hai.",
    en: "Riya is on her way home, and everything is fine.",
    seconds_est: 4,
  },
  {
    id: "g4_status_arrived",
    use: "Core 2 (G4): Status line when Riya has safely arrived home",
    hi: "रिया सुरक्षित घर पहुँच गई हैं जी।",
    roman: "Riya surakshit ghar pahunch gayi hain ji.",
    en: "Riya has reached home safely.",
    seconds_est: 3,
  },
  {
    id: "g4_status_offline",
    use: "Core 2 (G4): Status line when Riya's phone went offline during a watch",
    hi: "रिया का फ़ोन बंद हो गया है जी, आख़िरी बार वो रास्ते में थीं। मैं प्रिया से पता कर रही हूँ — 5 मिनट में बताऊँगी।",
    roman: "Riya ka phone band ho gaya hai ji, aakhri baar wo raste mein thi. Main Priya se pata kar rahi hoon — 5 minute mein bataungi.",
    en: "Riya's phone has switched off; she was last on her way. I am checking with Priya and will tell you in 5 minutes.",
    seconds_est: 8,
  },
  {
    id: "g4_status_no_news",
    use: "Core 2 (G4): Status line when there is no active watch and Riya is unreachable",
    hi: "रिया का फ़ोन अभी नहीं लग रहा जी। मैं रिया और प्रिया को बता रही हूँ।",
    roman: "Riya ka phone abhi nahi lag raha ji. Main Riya aur Priya ko bata rahi hoon.",
    en: "Riya's phone is not connecting right now. I am letting Riya and Priya know.",
    seconds_est: 6,
  },
  {
    id: "g4_status_no_answer_fallback",
    use: "Core 2 (G4/G5): Fallback line when Riya could not answer within 60 s",
    hi: "रिया से अभी बात नहीं हुई जी, प्रिया उनके पास जा रही हैं। पैसे बिल्कुल मत भेजिए।",
    roman: "Riya se abhi baat nahi hui ji, Priya unke paas ja rahi hain. Paise bilkul mat bhejiye.",
    en: "We have not spoken to Riya yet; Priya is going to check on her. Do not send any money at all.",
    seconds_est: 6,
  },
] as const satisfies readonly VoiceLine[];

export type VoiceLineId = (typeof LINES)[number]["id"];
