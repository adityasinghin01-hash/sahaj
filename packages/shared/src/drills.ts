import type { ScamType } from "./shield";

export type DrillScamType = Exclude<ScamType, "otp_theft" | "remote_access" | "unknown">;

export interface HelperDrill {
  id: string;
  scam_type: DrillScamType;
  title_en: string;
  story_hi: string;
  story_roman: string;
  seconds_est: number;
  good_answers: readonly string[];
  risky_answers: readonly string[];
  teach_line_hi: string;
  teach_line_roman: string;
}

/**
 * 10 weekly helper-drill stories for Aasha Didi (Core 3 Step 2.6),
 * one for each active scam type in ScamType.
 */
export const HELPER_DRILLS = [
  {
    id: "drill_digital_arrest",
    scam_type: "digital_arrest",
    title_en: "Fake police video call (Digital Arrest)",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। सामने से एक आदमी पुलिस की वर्दी में वीडियो कॉल पर आया और बोला कि आपके नाम से पार्सल पकड़ा गया है, अब आप घर से बाहर नहीं निकल सकतीं। उसने कहा किसी को मत बताना और जाँच के लिए पचास हज़ार रुपये भेजो, वरना अभी गिरफ़्तारी होगी। मेरी सहेली बहुत घबरा गई। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Saamne se ek aadmi police ki vardi mein video call par aaya aur bola ki aapke naam se parcel pakda gaya hai, ab aap ghar se baahar nahi nikal saktin. Usne kaha kisi ko mat batana aur jaanch ke liye pachaas hazaar rupaye bhejo, warna abhi giraftaari hogi. Meri saheli bahut ghabra gayi. Aap hoti toh kya karti?",
    seconds_est: 30,
    good_answers: [
      "video call kaat dena",
      "phone rakh dena",
      "paise na bhejna",
      "Riya ko batana",
      "1930 par call karna",
      "Sahaj ya 2 dabakar madad lena",
    ],
    risky_answers: [
      "video call par bane rehna",
      "paise bhejna",
      "kisi ko na batana (secrecy)",
      "Aadhaar ya bank details dikhana",
    ],
    teach_line_hi:
      "बिल्कुल सही कहा आपने जी, और एक ज़रूरी बात — असली पुलिस कभी वीडियो कॉल पर अरेस्ट नहीं करती और न फ़ोन पर पैसे माँगती है। ऐसा कॉल आए तो तुरंत फ़ोन काटकर रिया को बताइए।",
    teach_line_roman:
      "Bilkul sahi kaha aapne ji, aur ek zaroori baat — asli police kabhi video call par arrest nahi karti aur na phone par paise maangti hai. Aisa call aaye toh turant phone kaatkar Riya ko bataiye.",
  },
  {
    id: "drill_kyc_block",
    scam_type: "kyc_block",
    title_en: "Fake bank KYC block call",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। बोलने वाले ने कहा कि मैं आपके बैंक से बोल रहा हूँ, आपका KYC पूरा नहीं हुआ है और आज रात बारह बजे खाता बंद हो जाएगा। उसने कहा अभी एक लिंक भेजा है, उस पर क्लिक करके अपना ATM नंबर और फ़ोन पर आया OTP बता दीजिए, वरना पेंशन रुक जाएगी। मेरी सहेली डर गई। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Bolne wale ne kaha ki main aapke bank se bol raha hoon, aapka KYC poora nahi hua hai aur aaj raat baarah baje khaata band ho jayega. Usne kaha abhi ek link bheja hai, us par click karke apna ATM number aur phone par aaya OTP bata dijiye, warna pension ruk jayegi. Meri saheli dar gayi. Aap hoti toh kya karti?",
    seconds_est: 30,
    good_answers: [
      "phone rakh dena",
      "OTP na dena",
      "link na kholna",
      "ATM ya PIN na batana",
      "bank branch jaakar poochhna",
      "Riya ko batana",
    ],
    risky_answers: [
      "OTP batana",
      "link kholna",
      "ATM card number ya PIN batana",
      "paise bhejna",
    ],
    teach_line_hi:
      "बहुत बढ़िया सोचा आपने जी, और याद रखिए — बैंक कभी फ़ोन पर OTP, PIN या लिंक से KYC नहीं कराता। अगर कभी शक हो तो फ़ोन रखिए और बैंक या रिया से पूछिए।",
    teach_line_roman:
      "Bahut badhiya socha aapne ji, aur yaad rakhiye — bank kabhi phone par OTP, PIN ya link se KYC nahi karaata. Agar kabhi shak ho toh phone rakhiye aur bank ya Riya se poochhiye.",
  },
  {
    id: "drill_electricity_cut",
    scam_type: "electricity_cut",
    title_en: "Electricity disconnection threat",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। उसने कहा मैं बिजली दफ़्तर से बोल रहा हूँ, आपका पिछला बिल अपडेट नहीं हुआ है और आज रात नौ बजे घर की बिजली काट दी जाएगी। उसने कहा कि अगर बिजली चालू रखनी है तो अभी मेरे बताए नंबर पर दो हज़ार रुपये भेजिए और एक छोटा सा ऐप डाउनलोड कीजिए। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Usne kaha main bijli daftar se bol raha hoon, aapka pichhla bill update nahi hua hai aur aaj raat nau baje ghar ki bijli kaat di jayegi. Usne kaha ki agar bijli chaalu rakhni hai toh abhi mere bataye number par do hazaar rupaye bhejiye aur ek chhota sa app download kijiye. Aap hoti toh kya karti?",
    seconds_est: 29,
    good_answers: [
      "phone rakh dena",
      "paise na bhejna",
      "koi app download na karna",
      "purani bill raseed ya meter check karna",
      "Riya ko batana",
      "1930 par batana",
    ],
    risky_answers: [
      "paise bhejna",
      "app download karna",
      "code batana",
      "link kholna",
    ],
    teach_line_hi:
      "शाबाश जी, आपने बिल्कुल सही पकड़ा — बिजली विभाग ऐसे रात में फ़ोन करके किसी निजी नंबर पर पैसे या ऐप डाउनलोड करने को नहीं कहता। हमेशा फ़ोन रखकर रिया या घर में किसी को बताइए।",
    teach_line_roman:
      "Shabaash ji, aapne bilkul sahi pakda — bijli vibhaag aise raat mein phone karke kisi niji number par paise ya app download karne ko nahi kehta. Hamesha phone rakhkar Riya ya ghar mein kisi ko bataiye.",
  },
  {
    id: "drill_parcel_customs",
    scam_type: "parcel_customs",
    title_en: "Fake customs or courier parcel trap",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। उधर से बोला गया कि आपके आधार कार्ड से विदेश जा रहा एक पार्सल कस्टम्स में पकड़ा गया है और उसमें कुछ ग़ैर-क़ानूनी सामान मिला है। उसने कहा कि अगर केस से बचना है तो अभी वेरिफ़िकेशन के लिए पैसे ट्रांसफ़र कीजिए, नहीं तो पुलिस घर आ जाएगी। मेरी सहेली ने तो कोई पार्सल भेजा ही नहीं था। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Udhar se bola gaya ki aapke Aadhaar card se videsh ja raha ek parcel customs mein pakda gaya hai aur usmein kuchh gair-kaanooni saamaan mila hai. Usne kaha ki agar case se bachna hai toh abhi verification ke liye paise transfer kijiye, nahi toh police ghar aa jayegi. Meri saheli ne toh koi parcel bheja hi nahi tha. Aap hoti toh kya karti?",
    seconds_est: 31,
    good_answers: [
      "phone rakh dena",
      "paise na bhejna",
      "Aadhaar ya bank details na dena",
      "Riya ko batana",
      "1930 par call karna",
    ],
    risky_answers: [
      "paise bhejna",
      "Aadhaar number ya OTP batana",
      "dar kar unki baat maanna",
      "kisi ko na batana",
    ],
    teach_line_hi:
      "बिल्कुल सही जी, बहुत समझदारी की बात है — जब आपने कोई पार्सल भेजा ही नहीं तो कस्टम्स कभी फ़ोन पर पैसे लेकर मामला नहीं निपटाता। घबराने की ज़रूरत नहीं, बस फ़ोन काटकर रिया को बताइए।",
    teach_line_roman:
      "Bilkul sahi ji, bahut samajhdaari ki baat hai — jab aapne koi parcel bheja hi nahi toh customs kabhi phone par paise lekar maamla nahi niptaata. Ghabrane ki zaroorat nahi, bas phone kaatkar Riya ko bataiye.",
  },
  {
    id: "drill_lottery_prize",
    scam_type: "lottery_prize",
    title_en: "Fake lottery or prize money call",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। एक मीठी आवाज़ वाले आदमी ने बधाई दी और कहा कि आपके नंबर पर पाँच लाख रुपये की लॉटरी निकली है। उसने कहा कि इनाम के पैसे सीधे आपके खाते में आने वाले हैं, बस सरकारी टैक्स और प्रोसेसिंग फ़ीस के नाम पर पहले तीन हज़ार रुपये भेज दीजिए और एक कोड बताइए। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Ek meethi aawaaz wale aadmi ne badhaai di aur kaha ki aapke number par paanch lakh rupaye ki lottery nikli hai. Usne kaha ki inaam ke paise seedhe aapke khaate mein aane wale hain, bas sarkari tax aur processing fees ke naam par pehle teen hazaar rupaye bhej dijiye aur ek code bataiye. Aap hoti toh kya karti?",
    seconds_est: 30,
    good_answers: [
      "phone rakh dena",
      "paise na bhejna",
      "OTP ya code na batana",
      "Riya ko batana",
    ],
    risky_answers: [
      "tax ya fees ke paise bhejna",
      "code batana",
      "OTP batana",
      "bank account details dena",
    ],
    teach_line_hi:
      "वाह जी, आपने एकदम ठीक समझा — बिना खेले कोई लॉटरी नहीं निकलती, और असली इनाम के लिए कभी पहले पैसे नहीं भरने पड़ते। ऐसे मीठे झाँसे में आए बिना तुरंत फ़ोन रख दीजिए।",
    teach_line_roman:
      "Waah ji, aapne ekdam theek samjha — bina khele koi lottery nahi nikalti, aur asli inaam ke liye kabhi pehle paise nahi bharne padte. Aise meethe jhaanse mein aaye bina turant phone rakh dijiye.",
  },
  {
    id: "drill_job_task",
    scam_type: "job_task",
    title_en: "Work-from-home task or prepaid deposit scam",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। बोला गया कि घर बैठे रोज़ वीडियो लाइक करने से दो हज़ार रुपये मिलेंगे। पहले दो दिन उसे सच में तीन सौ रुपये मिले भी, फिर तीसरे दिन उन्होंने कहा कि बड़ा काम खोलने के लिए पहले दस हज़ार रुपये जमा करने होंगे, तभी पूरा पैसा वापस मिलेगा। मेरी सहेली लालच में आ रही थी। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Bola gaya ki ghar baithe roz video like karne se do hazaar rupaye milenge. Pehle do din use sach mein teen sau rupaye mile bhi, phir teesre din unhone kaha ki bada kaam kholne ke liye pehle das hazaar rupaye jama karne honge, tabhi poora paisa wapas milega. Meri saheli laalach mein aa rahi thi. Aap hoti toh kya karti?",
    seconds_est: 31,
    good_answers: [
      "paise jama na karna",
      "phone rakh dena",
      "group ya chat chhod dena",
      "Riya ko batana",
      "1930 par batana",
    ],
    risky_answers: [
      "paise bhejna",
      "aur zyada paise lagana",
      "link kholna",
      "bank details share karna",
    ],
    teach_line_hi:
      "बिल्कुल सही किया आपने जी — ये ठग पहले थोड़ा सा पैसा भेजकर भरोसा जीतते हैं और फिर बड़ी रकम हड़प लेते हैं। किसी भी काम के लिए पहले पैसे माँगे तो तुरंत रुक जाइए और रिया से बात कीजिए।",
    teach_line_roman:
      "Bilkul sahi kiya aapne ji — ye thag pehle thoda sa paisa bhejkar bharosa jeette hain aur phir badi rakam hadap lete hain. Kisi bhi kaam ke liye pehle paise maange toh turant ruk jaiye aur Riya se baat kijiye.",
  },
  {
    id: "drill_family_in_trouble",
    scam_type: "family_in_trouble",
    title_en: "Fake emergency or arrest call about child",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। सामने वाला रोती हुई आवाज़ में बोला कि मैं थाने से बोल रहा हूँ, आपकी बेटी का एक्सिडेंट हो गया है और अभी अस्पताल में भर्ती है, उसका फ़ोन बंद है। उसने कहा कि इलाज शुरू करने के लिए तुरंत तीस हज़ार रुपये इस नंबर पर भेजिए और किसी से बात मत कीजिए। मेरी सहेली का दिल घबरा गया। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Saamne wala roti hui aawaaz mein bola ki main thaane se bol raha hoon, aapki beti ka accident ho gaya hai aur abhi aspataal mein bharti hai, uska phone band hai. Usne kaha ki ilaaj shuru karne ke liye turant tees hazaar rupaye is number par bhejiye aur kisi se baat mat kijiye. Meri saheli ka dil ghabra gaya. Aap hoti toh kya karti?",
    seconds_est: 31,
    good_answers: [
      "phone rakh dena",
      "paise na bhejna",
      "2 dabakar Sahaj ko call karna",
      "beti ya ghar walon ko khud call karna",
      "1930 par batana",
    ],
    risky_answers: [
      "jaldi mein paise bhejna",
      "bina check kiye bharosa karna",
      "kisi aur ko na batana",
    ],
    teach_line_hi:
      "बहुत अच्छी बात कही आपने जी — ऐसी घबराहट वाली कॉल आए तो पहले साँस लीजिए, वह फ़ोन काटिए और 2 दबाकर सीधे सहज पर कॉल कीजिए। असली ख़बर हमेशा आपके अपने कॉल में ही मिलेगी।",
    teach_line_roman:
      "Bahut achhi baat kahi aapne ji — aisi ghabrahat wali call aaye toh pehle saans lijiye, wah phone kaatiye aur 2 dabakar seedhe Sahaj par call kijiye. Asli khabar hamesha aapke apne call mein hi milegi.",
  },
  {
    id: "drill_wedding_invite_apk",
    scam_type: "wedding_invite_apk",
    title_en: "Fake wedding card or APK file trap",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। किसी अनजान आदमी ने कहा कि मैं आपके रिश्तेदार के घर से बोल रहा हूँ, अगले हफ़्ते शादी है और मैंने आपको व्हाट्सऐप पर शादी का कार्ड भेजा है। कार्ड के नाम पर एक नीली फ़ाइल आई थी जिस पर APK लिखा था, और वह बोला इसे खोलकर हाँ लिख दीजिए। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Kisi anjaan aadmi ne kaha ki main aapke rishtedaar ke ghar se bol raha hoon, agle hafte shaadi hai aur maine aapko WhatsApp par shaadi ka card bheja hai. Card ke naam par ek neeli file aayi thi jis par APK likha tha, aur wah bola ise kholkar haan likh dijiye. Aap hoti toh kya karti?",
    seconds_est: 29,
    good_answers: [
      "file ya APK na kholna",
      "download na karna",
      "phone rakh dena",
      "Riya ko batana",
      "rishtedaar ko khud call karke poochhna",
    ],
    risky_answers: [
      "APK file kholna",
      "install dabana",
      "link kholna",
      "permission allow karna",
    ],
    teach_line_hi:
      "एकदम सही पकड़ा आपने जी — असली शादी का कार्ड तस्वीर या PDF में होता है, APK फ़ाइल नहीं होती। अनजान APK खोलने से पूरा फ़ोन हैक हो सकता है, इसलिए ऐसी कोई फ़ाइल कभी मत खोलिए।",
    teach_line_roman:
      "Ekdam sahi pakda aapne ji — asli shaadi ka card tasveer ya PDF mein hota hai, APK file nahi hoti. Anjaan APK kholne se poora phone hack ho sakta hai, isliye aisi koi file kabhi mat kholiye.",
  },
  {
    id: "drill_refund_cashback",
    scam_type: "refund_cashback",
    title_en: "Fake refund or cashback collect-PIN scam",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। उसने कहा कि आपने ऑनलाइन जो दवा मँगवाई थी उसके पंद्रह सौ रुपये गलती से दो बार कट गए हैं, और हम अभी वह पैसा वापस भेज रहे हैं। फिर उसने कहा कि रिफ़ंड पाने के लिए मैंने एक रिक्वेस्ट भेजी है, बस उस पर अपना UPI PIN डालकर हाँ दबा दीजिए। मेरी सहेली को लगा पैसे वापस आ रहे हैं। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Usne kaha ki aapne online jo dawa mangwaayi thi uske pandrah sau rupaye galti se do baar kat gaye hain, aur hum abhi wah paisa wapas bhej rahe hain. Phir usne kaha ki refund paane ke liye maine ek request bheji hai, bas us par apna UPI PIN daalkar haan daba dijiye. Meri saheli ko laga paise wapas aa rahe hain. Aap hoti toh kya karti?",
    seconds_est: 30,
    good_answers: [
      "UPI PIN na daalna",
      "request cancel kar dena",
      "phone rakh dena",
      "OTP na dena",
      "Riya ko batana",
    ],
    risky_answers: [
      "UPI PIN daalna",
      "pay ya approve dabana",
      "OTP batana",
      "link kholna",
    ],
    teach_line_hi:
      "बिल्कुल सही जी, और सबसे आसान नियम याद रखिए — पैसे मिलने के लिए कभी UPI PIN या OTP नहीं डालना पड़ता। PIN डालने से पैसे आते नहीं, बल्कि खाते से कट जाते हैं।",
    teach_line_roman:
      "Bilkul sahi ji, aur sabse aasaan niyam yaad rakhiye — paise milne ke liye kabhi UPI PIN ya OTP nahi daalna padta. PIN daalne se paise aate nahi, balki khaate se kat jaate hain.",
  },
  {
    id: "drill_sextortion_threat",
    scam_type: "sextortion_threat",
    title_en: "Fake photo/video blackmail threat",
    story_hi:
      "मेरी एक सहेली को फ़ोन आया। सामने वाला बदतमीज़ी से डराने लगा कि हमारे पास आपकी ग़लत तस्वीर और वीडियो है, अगर आपने अभी बीस हज़ार रुपये नहीं भेजे तो हम इसे आपके रिश्तेदारों को भेज देंगे। मेरी सहेली ने कुछ ग़लत नहीं किया था, फिर भी बदनामी के डर से वह चुपचाप पैसे भेजने की सोचने लगी। आप होतीं तो क्या करतीं?",
    story_roman:
      "Meri ek saheli ko phone aaya. Saamne wala badtameezi se daraane laga ki hamaare paas aapki galat tasveer aur video hai, agar aapne abhi bees hazaar rupaye nahi bheje toh hum ise aapke rishtedaaron ko bhej denge. Meri saheli ne kuchh galat nahi kiya tha, phir bhi badnaami ke dar se wah chupchaap paise bhejne ki sochne lagi. Aap hoti toh kya karti?",
    seconds_est: 30,
    good_answers: [
      "phone rakh dena",
      "paise na bhejna",
      "darna nahi",
      "number block karna",
      "Riya ko batana",
      "1930 par call karna",
    ],
    risky_answers: [
      "dar kar paise bhejna",
      "baat karte rehna",
      "sharm se kisi ko na batana",
      "aur paise bhejna",
    ],
    teach_line_hi:
      "बहुत हिम्मत की बात कही आपने जी — ये ठग नक़ली तस्वीरें बनाकर सबको डराते हैं, और एक बार पैसे देने पर और माँगते हैं। इसमें शर्म की कोई बात नहीं है; फ़ोन काटिए, ब्लॉक कीजिए और बेझिझक रिया को बताइए।",
    teach_line_roman:
      "Bahut himmat ki baat kahi aapne ji — ye thag nakli tasveerein banaakar sabko daraate hain, aur ek baar paise dene par aur maangte hain. Ismein sharm ki koi baat nahi hai; phone kaatiye, block kijiye aur bejhijhak Riya ko bataiye.",
  },
] as const satisfies readonly HelperDrill[];

export type HelperDrillId = (typeof HELPER_DRILLS)[number]["id"];
