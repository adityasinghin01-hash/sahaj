package app.sahaj.shield.rules

import java.util.Locale
import java.util.regex.Pattern
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class JsonRulesEngine(rulesJson: String) : RulesEngine {
    private val cfg = ParsedRules(rulesJson)

    private val schemePrefixRegex = Regex("^[a-z][a-z0-9+.-]*://")
    private val pathSplitRegex = Regex("[/?#\\\\]")
    private val portSuffixRegex = Regex(":[0-9]*$")
    private val trailingDotsRegex = Regex("\\.+$")
    private val ipv4Regex = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")
    private val digitsRunRegex = Regex("[0-9]{4,}")

    override fun check(input: SmsInput, ctx: PhoneContext): LocalVerdict {
        val hits = mutableListOf<RuleHit>()
        val reasonIds = mutableListOf<String>()
        fun addReason(id: String) {
            if (cfg.reasonsById.containsKey(id) && !reasonIds.contains(id)) reasonIds.add(id)
        }

        val text = input.body.takeIf { it.trim().isNotEmpty() }
        var floor = Level.GREEN
        var forced = false

        val ts = text?.let { scoreText(it) }
        if (ts != null) {
            hits.addAll(ts.hits)
            for (h in ts.hits) {
                if (h.weight > 0) addReason(h.ruleId)
            }
            if (ts.apk) {
                floor = maxLevel(floor, cfg.links.apkForceLevel)
                forced = true
            }
        }

        val sType = senderType(input.sender)
        val sRule = cfg.senderRules.find { it.type == sType }
        if (sRule != null) {
            hits.add(RuleHit(sRule.id, if (text != null) sRule.score else 0))
            if (text != null && sRule.score > 0) addReason(sRule.id)
        }
        if (sType == "mobile_10" && ts?.topic == true) {
            hits.add(RuleHit(cfg.mobileClaimsBrand.id, cfg.mobileClaimsBrand.score))
            addReason(cfg.mobileClaimsBrand.id)
        }

        val firedPatterns = mutableListOf<String>()
        var patternType: String? = null
        if (text != null) {
            if (checkP1(text, input.receivedAtMs, ctx)) {
                firedPatterns.add(cfg.p1.id)
                hits.add(RuleHit(cfg.p1.id, 0, scamType = cfg.p1.scamType))
                addReason(cfg.p1.id)
                floor = maxLevel(floor, cfg.p1.level)
                forced = true
                patternType = cfg.p1.scamType
            }
            val p5Level = checkP5(input.sender, text, senderTypeOverride = sType)
            if (p5Level != null) {
                firedPatterns.add(cfg.p5.id)
                val rid = "${cfg.p5.id}.${p5Level.wireName}"
                hits.add(RuleHit(rid, 0))
                addReason(rid)
                floor = maxLevel(floor, p5Level)
                if (p5Level == Level.RED) forced = true
            }
        }

        val score = clampScore(hits.sumOf { it.weight })
        val scoreLevel = when {
            score >= cfg.thresholds.redAt -> Level.RED
            score >= cfg.thresholds.yellowAt -> Level.YELLOW
            else -> Level.GREEN
        }
        val level = maxLevel(scoreLevel, floor)
        val needsAi = (text != null) && !forced && score >= cfg.thresholds.askAiLow && score < cfg.thresholds.askAiHigh
        if (text != null && isOtp(text)) {
            hits.add(RuleHit(cfg.otp.id, 0))
            if (level != Level.GREEN) addReason(cfg.otp.id)
        }

        var scamType = ts?.scamType ?: "unknown"
        if (scamType == "unknown" && patternType != null) scamType = patternType

        val reasons = if (level == Level.GREEN) emptyList() else reasonIds.mapNotNull { cfg.reasonsById[it]?.hi }
        val matchedRules = (hits.map { h ->
            if (h.detail != null && h.detail != "total" && h.ruleId.startsWith("script.")) {
                "${h.ruleId}:${h.detail}"
            } else {
                h.ruleId
            }
        } + firedPatterns).distinct()

        return LocalVerdict(
            level = level,
            scamType = scamType,
            reasons = reasons,
            matchedRules = matchedRules,
            maskedText = mask(input.body),
            senderType = sType,
            linkDomains = ts?.links?.map { it.registrableDomain }?.distinct() ?: emptyList(),
            needsAi = needsAi,
            score = score,
        )
    }

    fun senderType(sender: String?, saved: Boolean = false): String {
        if (saved) return "saved_contact"
        return classify(sender ?: "", cfg.senderRules, "unknown")
    }

    fun callerType(number: String?, saved: Boolean = false): String {
        if (saved) return "saved_contact"
        return classify(number ?: "", cfg.callerRules, "unknown")
    }

    fun hostOf(urlOrDomain: String): String {
        var h = urlOrDomain.trim().lowercase(Locale.ROOT)
        h = h.replace(schemePrefixRegex, "")
        h = h.split(pathSplitRegex, limit = 2).firstOrNull() ?: ""
        val at = h.lastIndexOf('@')
        if (at >= 0) h = h.substring(at + 1)
        h = h.replace(portSuffixRegex, "").replace(trailingDotsRegex, "")
        if (h.startsWith("www.")) h = h.substring(4)
        return h
    }

    fun registrableDomain(urlOrDomain: String): String {
        val host = hostOf(urlOrDomain)
        if (ipv4Regex.matches(host)) return host
        val labels = host.split('.').filter { it.isNotEmpty() }
        if (labels.size <= 2) return labels.joinToString(".")
        val lastTwo = labels.takeLast(2).joinToString(".")
        return if (cfg.links.multiPartSuffixes.contains(lastTwo)) {
            labels.takeLast(3).joinToString(".")
        } else {
            lastTwo
        }
    }

    fun findLinks(text: String): List<FoundLink> {
        val m = cfg.links.urlPattern.matcher(text)
        val out = mutableListOf<FoundLink>()
        var pos = 0
        while (pos <= text.length && m.find(pos)) {
            val lead = m.group(1) ?: ""
            val raw = m.group(cfg.links.urlGroup) ?: ""
            val start = m.start() + lead.length
            if (raw.isEmpty()) {
                pos = m.start() + 1
                continue
            }
            pos = max(start + raw.length, m.start() + 1)
            val url = cfg.links.trailingPunctPattern.matcher(raw).replaceAll("")
            val host = hostOf(url)
            if (host.isEmpty() || !host.contains('.')) continue
            out.add(FoundLink(url, host, registrableDomain(host), start, start + url.length))
        }
        return out
    }

    fun isShortener(urlOrDomain: String): Boolean {
        val host = hostOf(urlOrDomain)
        return cfg.links.shortenerDomains.contains(host) ||
            cfg.links.shortenerDomains.contains(registrableDomain(host))
    }

    fun isApk(text: String): Boolean = cfg.links.apkPattern.matcher(text).find()

    fun lookAlikeDetail(urlOrDomain: String): LookAlikeResult {
        val host = hostOf(urlOrDomain)
        val punycode = host.split('.').any { it.startsWith("xn--") }
        val official = cfg.links.trustedSuffixes.any { suffixMatch(host, it) } ||
            cfg.links.brands.any { b -> b.official.any { suffixMatch(host, it) } }
        if (official && !punycode) return LookAlikeResult(false, null, punycode = false, official = true)
        val brand = cfg.links.brands.find { b -> b.tokens.any { t -> host.contains(t.lowercase(Locale.ROOT)) } }
        return LookAlikeResult(
            lookAlike = (brand != null) || punycode,
            brand = brand?.brand,
            punycode = punycode,
            official = official,
        )
    }

    fun lookAlike(urlOrDomain: String): Boolean = lookAlikeDetail(urlOrDomain).lookAlike

    fun findOtpCodes(input: String): List<Span> {
        val text = asciiDigits(input)
        val keywords = keywordSpans(text)
        if (keywords.isEmpty()) return emptyList()
        val m = cfg.otp.numberPattern.matcher(text)
        val out = mutableListOf<Span>()
        var pos = 0
        while (pos <= text.length && m.find(pos)) {
            val lead = m.group(1) ?: ""
            val code = m.group(cfg.otp.numberGroup) ?: ""
            val start = m.start() + lead.length
            val end = start + code.length
            pos = max(end, m.start() + 1)
            if (code.isEmpty()) continue
            val before = text.substring(max(0, start - 8), start)
            if (cfg.otp.currencyBeforePattern.matcher(before).find()) continue
            val span = Span(start, end)
            if (keywords.any { near(span, it, cfg.otp.windowChars) }) out.add(span)
        }
        return out
    }

    fun isOtp(text: String): Boolean {
        if (findOtpCodes(text).isNotEmpty()) return true
        val idx = text.indexOf(cfg.mask.otpToken)
        if (idx < 0) return false
        val tokenSpan = Span(idx, idx + cfg.mask.otpToken.length)
        return keywordSpans(text).any { near(tokenSpan, it, cfg.otp.windowChars) }
    }

    fun mask(input: String): String {
        var text = asciiDigits(input)
        text = applyReplacements(
            text,
            findLinks(text).map { l ->
                val hostMasked = l.host.replace(digitsRunRegex, "#")
                val apkSuffix = if (isApk(l.url)) cfg.mask.apkMarker else ""
                Replacement(l.start, l.end, "${cfg.mask.urlTokenPrefix}$hostMasked${cfg.mask.urlTokenSuffix}$apkSuffix")
            },
        )
        val steps = cfg.mask.steps
        for (step in steps.dropLast(1)) {
            text = replaceWithLead(text, step.pattern, step.token)
        }
        text = applyReplacements(
            text,
            findOtpCodes(text).map { s -> Replacement(s.start, s.end, cfg.mask.otpToken) },
        )
        steps.lastOrNull()?.let { last ->
            text = replaceWithLead(text, last.pattern, last.token)
        }
        return text
    }

    fun hasTopicWords(text: String): Boolean = hasAnyPhrase(normalizeText(text), cfg.topicWords)

    fun scoreText(text: String): TextScore {
        val norm = normalizeText(text)
        val hits = mutableListOf<RuleHit>()

        var bestType: String? = null
        var typeScore = 0
        for ((type, script) in cfg.scriptTypes) {
            val matches = matchPhrases(norm, script.phrases) { it.text }
            var sum = 0
            for (m in matches) {
                sum += m.item.w
                hits.add(RuleHit("script.$type", 0, detail = m.phrase, scamType = type))
            }
            if (sum > typeScore) {
                typeScore = sum
                bestType = type
            }
        }
        if (bestType != null) {
            hits.add(RuleHit("script.$bestType", typeScore, detail = "total", scamType = bestType))
        }

        var signalScore = 0
        var signalType: String? = null
        var signalTypeWeight = 0
        for (sig in cfg.genericSignals) {
            val m = matchPhrases(norm, sig.phrases) { it }.firstOrNull() ?: continue
            signalScore += sig.score
            hits.add(RuleHit(sig.id, sig.score, detail = m.phrase, scamType = sig.scamType))
            if (sig.scamType != null && sig.score > signalTypeWeight) {
                signalType = sig.scamType
                signalTypeWeight = sig.score
            }
        }

        val links = findLinks(text)
        val lHits = linkHits(text, links)
        hits.addAll(lHits)
        val linkScore = lHits.sumOf { it.weight }
        val apk = lHits.any { it.ruleId == cfg.links.apkId }

        val scamType = when {
            bestType != null && typeScore >= cfg.minTypeScore -> bestType
            signalType != null -> signalType
            apk -> "remote_access"
            else -> "unknown"
        }

        return TextScore(
            score = clampScore(typeScore + signalScore + linkScore),
            scamType = scamType,
            hits = hits,
            typeScore = typeScore,
            links = links,
            apk = apk,
            topic = hasAnyPhrase(norm, cfg.topicWords),
        )
    }

    fun checkP1(body: String, receivedAtMs: Long, ctx: PhoneContext): Boolean {
        if (!ctx.onCallWithUnsaved) return false
        if (!isOtp(body)) return false
        val start = ctx.callStartedAtMs ?: 0L
        return receivedAtMs >= start
    }

    fun checkP5(
        sender: String?,
        text: String,
        senderSaved: Boolean = false,
        senderTypeOverride: String? = null,
    ): Level? {
        val links = findLinks(text)
        if (links.isEmpty()) return null
        val st = if (senderSaved) "saved_contact" else (senderTypeOverride ?: senderType(sender))
        val topic = hasTopicWords(text)
        val risky = cfg.p5.riskySenderTypes.contains(st)
        if (topic && risky) return Level.RED
        if (!topic && !risky) return null
        val trusted = st == "business_header" || st == "saved_contact"
        if (trusted) {
            val badLink = links.any { isShortener(it.host) || lookAlikeDetail(it.host).lookAlike }
            return if (badLink) Level.YELLOW else null
        }
        return Level.YELLOW
    }

    private fun linkHits(text: String, links: List<FoundLink>): List<RuleHit> {
        val l = cfg.links
        val hits = mutableListOf<RuleHit>()
        if (links.isNotEmpty()) {
            hits.add(RuleHit(l.present.id, l.present.score, detail = links.firstOrNull()?.host))
        }
        val short = links.find { isShortener(it.host) }
        if (short != null) {
            hits.add(RuleHit(l.shortener.id, l.shortener.score, detail = short.host))
        }
        for (link in links) {
            val la = lookAlikeDetail(link.host)
            if (la.brand != null && la.lookAlike && hits.none { it.ruleId == l.lookAlike.id }) {
                hits.add(RuleHit(l.lookAlike.id, l.lookAlike.score, detail = "${link.host} (${la.brand})"))
            }
            if (la.punycode && hits.none { it.ruleId == l.punycode.id }) {
                hits.add(RuleHit(l.punycode.id, l.punycode.score, detail = link.host))
            }
        }
        if (isApk(text)) {
            hits.add(RuleHit(l.apkId, l.apkScore, scamType = "remote_access"))
        }
        return hits
    }

    private fun classify(raw: String, rules: List<TypedRegexRule>, fallback: String): String {
        val trimmed = asciiDigits(raw).trim()
        if (trimmed.isEmpty()) return fallback
        val stripped = cfg.numberStripPattern.matcher(trimmed).replaceAll("")
        for (r in rules) {
            if (r.pattern.matcher(trimmed).find() || r.pattern.matcher(stripped).find()) {
                return r.type
            }
        }
        return fallback
    }

    private fun suffixMatch(host: String, suffix: String): Boolean {
        val s = suffix.lowercase(Locale.ROOT)
        return host == s || host.endsWith(".$s")
    }

    private fun keywordSpans(text: String): List<Span> {
        val m = cfg.otp.keywordPattern.matcher(text)
        val spans = mutableListOf<Span>()
        var pos = 0
        while (pos <= text.length && m.find(pos)) {
            if (m.start() == m.end()) {
                pos = m.start() + 1
                continue
            }
            spans.add(Span(m.start(), m.end()))
            pos = m.end()
        }
        return spans
    }

    private fun near(a: Span, b: Span, window: Int): Boolean {
        val gap = max(0, max(b.start - a.end, a.start - b.end))
        return gap <= window
    }

    private fun clampScore(n: Int): Int = max(0, min(cfg.thresholds.maxScore, n.toDouble().roundToInt()))

    private fun maxLevel(a: Level, b: Level): Level = if (b.ordinal > a.ordinal) b else a

    private data class Replacement(val start: Int, val end: Int, val value: String)

    private fun applyReplacements(text: String, reps: List<Replacement>): String {
        val sb = StringBuilder(text.length)
        var pos = 0
        for (r in reps.sortedBy { it.start }) {
            if (r.start < pos) continue
            sb.append(text, pos, r.start)
            sb.append(r.value)
            pos = r.end
        }
        sb.append(text, pos, text.length)
        return sb.toString()
    }

    private fun replaceWithLead(text: String, pattern: Pattern, token: String): String {
        val m = pattern.matcher(text)
        val sb = StringBuilder(text.length)
        var last = 0
        while (m.find()) {
            sb.append(text, last, m.start())
            sb.append(m.group(1) ?: "")
            sb.append(token)
            last = m.end()
        }
        sb.append(text, last, text.length)
        return sb.toString()
    }
}

